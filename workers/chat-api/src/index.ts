import {
  API_PATHS,
  DEFAULT_HISTORY_LIMIT,
  GLOBAL_ROOM_ID,
  MAX_HISTORY_LIMIT,
  MAX_IMAGE_SIZE_BYTES,
  MAX_NICKNAME_LENGTH,
  createImageObjectKey,
  isImageMimeType,
  isSafeImageKey,
  type AnyChatMessage,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ImageMimeType,
  type MessageHistoryResponse,
  type ReconnectSyncResponse,
  type SessionPayload,
  type UploadImageResponse
} from "../../../packages/shared/protocol";
import { createSessionToken, verifySessionToken } from "./crypto";
import { SlidingWindowRateLimiter } from "./rate-limit";
import { ChatRoom } from "./room";
import {
  buildMediaUrl,
  buildCorsHeaders,
  decodeCursor,
  encodeCursor,
  errorResponse,
  getBearerToken,
  getClientIp,
  jsonResponse,
  normalizeNickname,
  resolveAllowedOrigin,
  resolveRoomId
} from "./utils";

export { ChatRoom } from "./room";

type MessageRecord = {
  id: string;
  room_id: string;
  user_id: string;
  nickname: string;
  message_type: string | null;
  content: string | null;
  image_key: string | null;
  image_mime_type: string | null;
  image_size_bytes: number | null;
  created_at: number;
};

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  CHAT_DB: D1Database;
  CHAT_MEDIA: R2Bucket;
  SESSION_SECRET: string;
  ALLOWED_ORIGINS?: string;
  SESSION_TTL_SECONDS?: string;
}

const SESSION_RATE_LIMIT_PER_MINUTE = 20;
const sessionRateLimiter = new SlidingWindowRateLimiter();

function getSessionTtlSeconds(env: Env): number {
  const ttl = Number(env.SESSION_TTL_SECONDS ?? 604800);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 604800;
}

function assertAllowedOrigin(request: Request, env: Env): Response | null {
  const hasOrigin = request.headers.has("origin");
  if (!hasOrigin) {
    return null;
  }

  if (!resolveAllowedOrigin(request, env)) {
    return errorResponse(request, env, 403, {
      code: "unauthorized",
      message: "Origin is not allowed"
    });
  }

  return null;
}

function toMessage(record: MessageRecord, request: Request): AnyChatMessage {
  const base = {
    id: record.id,
    roomId: record.room_id,
    userId: record.user_id,
    nickname: record.nickname,
    createdAt: record.created_at
  };

  if (
    record.message_type === "image" &&
    record.image_key &&
    record.image_mime_type &&
    isImageMimeType(record.image_mime_type) &&
    Number.isFinite(record.image_size_bytes)
  ) {
    return {
      ...base,
      kind: "image",
      imageKey: record.image_key,
      imageMimeType: record.image_mime_type as ImageMimeType,
      imageSizeBytes: Number(record.image_size_bytes),
      imageUrl: buildMediaUrl(request, record.image_key)
    };
  }

  return {
    ...base,
    kind: "text",
    content: record.content ?? ""
  };
}

function parseRoomOrError(request: Request, env: Env, raw: string | null): { roomId: string } | { error: Response } {
  const roomId = resolveRoomId(raw ?? GLOBAL_ROOM_ID);
  if (!roomId) {
    return {
      error: errorResponse(request, env, 400, {
        code: "invalid_room",
        message: "Invalid room id"
      })
    };
  }

  return { roomId };
}

function mediaBaseUrl(request: Request): string {
  const url = new URL(request.url);
  url.pathname = API_PATHS.media;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function extractMediaKey(pathname: string): string | null {
  const prefix = `${API_PATHS.media}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  let payload: CreateSessionRequest;
  try {
    payload = (await request.json()) as CreateSessionRequest;
  } catch {
    return errorResponse(request, env, 400, {
      code: "bad_request",
      message: "Invalid JSON body"
    });
  }

  if (!payload || typeof payload.nickname !== "string") {
    return errorResponse(request, env, 400, {
      code: "invalid_nickname",
      message: "Invalid nickname"
    });
  }

  const nickname = normalizeNickname(payload.nickname);
  if (!nickname || nickname.length > MAX_NICKNAME_LENGTH) {
    return errorResponse(request, env, 400, {
      code: "invalid_nickname",
      message: `Nickname must be 1-${MAX_NICKNAME_LENGTH} chars`
    });
  }

  const ip = getClientIp(request);
  if (!sessionRateLimiter.consume(`session:${ip}`, SESSION_RATE_LIMIT_PER_MINUTE, 60_000)) {
    return errorResponse(request, env, 429, {
      code: "rate_limited",
      message: "Too many session requests"
    });
  }

  const userId = crypto.randomUUID();
  const now = Date.now();
  const sessionPayload: SessionPayload = {
    userId,
    nickname,
    issuedAt: now
  };

  const token = await createSessionToken(sessionPayload, env.SESSION_SECRET);
  await env.CHAT_DB.prepare(
    `
      INSERT OR REPLACE INTO users (user_id, nickname, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
    `
  )
    .bind(userId, nickname, now, now)
    .run();

  const responseBody: CreateSessionResponse = {
    ok: true,
    data: {
      userId,
      nickname,
      token
    }
  };

  return jsonResponse(request, env, responseBody, 201);
}

async function authenticate(request: Request, env: Env): Promise<SessionPayload | null> {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  return verifySessionToken(token, env.SESSION_SECRET, getSessionTtlSeconds(env));
}

async function fetchHistory(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const session = await authenticate(request, env);
  if (!session) {
    return errorResponse(request, env, 401, {
      code: "invalid_token",
      message: "Invalid or expired token"
    });
  }

  const url = new URL(request.url);
  const parsedRoom = parseRoomOrError(request, env, url.searchParams.get("room"));
  if ("error" in parsedRoom) {
    return parsedRoom.error;
  }
  const roomId = parsedRoom.roomId;

  const after = url.searchParams.get("after");
  if (after) {
    const afterTimestamp = Number(after);
    if (!Number.isFinite(afterTimestamp)) {
      return errorResponse(request, env, 400, {
        code: "bad_request",
        message: "after must be a timestamp"
      });
    }

    const query = await env.CHAT_DB.prepare(
      `
        SELECT id, room_id, user_id, nickname, message_type, content, image_key, image_mime_type, image_size_bytes, created_at
        FROM messages
        WHERE room_id = ? AND created_at > ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `
    )
      .bind(roomId, afterTimestamp, MAX_HISTORY_LIMIT)
      .all<MessageRecord>();

    const responseBody: ReconnectSyncResponse = {
      ok: true,
      data: {
        roomId,
        items: (query.results ?? []).map((record) => toMessage(record, request))
      }
    };

    return jsonResponse(request, env, responseBody);
  }

  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_HISTORY_LIMIT);
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), MAX_HISTORY_LIMIT);
  const cursorRaw = url.searchParams.get("cursor");

  let queryText = `
    SELECT id, room_id, user_id, nickname, message_type, content, image_key, image_mime_type, image_size_bytes, created_at
    FROM messages
    WHERE room_id = ?
  `;
  const bindValues: unknown[] = [roomId];

  if (cursorRaw) {
    const cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return errorResponse(request, env, 400, {
        code: "bad_request",
        message: "Invalid cursor format"
      });
    }

    queryText += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    bindValues.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  queryText += " ORDER BY created_at DESC, id DESC LIMIT ?";
  bindValues.push(limit);

  const rows = await env.CHAT_DB.prepare(queryText).bind(...bindValues).all<MessageRecord>();
  const records = rows.results ?? [];
  const items = records.map((record) => toMessage(record, request)).reverse();
  const tail = records.at(records.length - 1);

  const responseBody: MessageHistoryResponse = {
    ok: true,
    data: {
      roomId,
      items,
      nextCursor: tail ? encodeCursor(tail.created_at, tail.id) : null
    }
  };

  return jsonResponse(request, env, responseBody);
}

async function handleUploadImage(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const session = await authenticate(request, env);
  if (!session) {
    return errorResponse(request, env, 401, {
      code: "invalid_token",
      message: "Invalid or expired token"
    });
  }

  const url = new URL(request.url);
  const parsedRoom = parseRoomOrError(request, env, url.searchParams.get("room"));
  if ("error" in parsedRoom) {
    return parsedRoom.error;
  }
  const roomId = parsedRoom.roomId;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(request, env, 400, {
      code: "bad_request",
      message: "Expected multipart/form-data payload"
    });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errorResponse(request, env, 400, {
      code: "invalid_image",
      message: "Missing image file"
    });
  }

  const mimeType = file.type.toLowerCase();
  if (!isImageMimeType(mimeType)) {
    return errorResponse(request, env, 400, {
      code: "invalid_image",
      message: "Unsupported image MIME type"
    });
  }

  if (file.size <= 0) {
    return errorResponse(request, env, 400, {
      code: "invalid_image",
      message: "Image file is empty"
    });
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return errorResponse(request, env, 400, {
      code: "image_too_large",
      message: `Image size must be <= ${Math.floor(MAX_IMAGE_SIZE_BYTES / (1024 * 1024))}MB`
    });
  }

  const imageKey = createImageObjectKey(roomId, session.userId, mimeType);
  await env.CHAT_MEDIA.put(imageKey, file.stream(), {
    httpMetadata: {
      contentType: mimeType
    },
    customMetadata: {
      roomId,
      userId: session.userId,
      sizeBytes: String(file.size)
    }
  });

  const responseBody: UploadImageResponse = {
    ok: true,
    data: {
      roomId,
      imageKey,
      mimeType,
      sizeBytes: file.size
    }
  };

  return jsonResponse(request, env, responseBody, 201);
}

async function handleMediaRequest(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const imageKey = extractMediaKey(new URL(request.url).pathname);
  if (!imageKey || !isSafeImageKey(imageKey)) {
    return errorResponse(request, env, 400, {
      code: "invalid_image_key",
      message: "Invalid image key"
    });
  }

  const object = await env.CHAT_MEDIA.get(imageKey);
  if (!object || !object.body) {
    return errorResponse(request, env, 404, {
      code: "not_found",
      message: "Image not found"
    });
  }

  const headers = buildCorsHeaders(request, env);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  object.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }

  return new Response(object.body, { status: 200, headers });
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const url = new URL(request.url);
  const parsedRoom = parseRoomOrError(request, env, url.searchParams.get("room"));
  if ("error" in parsedRoom) {
    return parsedRoom.error;
  }
  const roomId = parsedRoom.roomId;

  const token = url.searchParams.get("token");
  if (!token) {
    return errorResponse(request, env, 401, {
      code: "invalid_token",
      message: "Missing token"
    });
  }

  const session = await verifySessionToken(token, env.SESSION_SECRET, getSessionTtlSeconds(env));
  if (!session) {
    return errorResponse(request, env, 401, {
      code: "invalid_token",
      message: "Invalid or expired token"
    });
  }

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(request, env, 400, {
      code: "bad_request",
      message: "WebSocket upgrade is required"
    });
  }

  const durableObjectId = env.CHAT_ROOM.idFromName(roomId);
  const roomStub = env.CHAT_ROOM.get(durableObjectId);
  const forwardRequest = new Request(request.url, request);
  forwardRequest.headers.set("x-user-id", session.userId);
  forwardRequest.headers.set("x-nickname", session.nickname);
  forwardRequest.headers.set("x-room-id", roomId);
  forwardRequest.headers.set("x-media-base-url", mediaBaseUrl(request));
  return roomStub.fetch(forwardRequest);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request, env)
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return jsonResponse(request, env, {
        ok: true,
        data: {
          uptime: Date.now()
        }
      });
    }

    if (url.pathname === API_PATHS.session && request.method === "POST") {
      return handleCreateSession(request, env);
    }

    if (url.pathname === API_PATHS.messages && request.method === "GET") {
      return fetchHistory(request, env);
    }

    if (url.pathname === API_PATHS.uploadImage && request.method === "POST") {
      return handleUploadImage(request, env);
    }

    if (url.pathname.startsWith(`${API_PATHS.media}/`) && request.method === "GET") {
      return handleMediaRequest(request, env);
    }

    if (url.pathname === API_PATHS.websocket && request.method === "GET") {
      return handleWebSocket(request, env);
    }

    return errorResponse(request, env, 404, {
      code: "bad_request",
      message: "Route not found"
    });
  }
} satisfies ExportedHandler<Env>;
