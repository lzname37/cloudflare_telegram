import {
  API_PATHS,
  DEFAULT_HISTORY_LIMIT,
  GLOBAL_ROOM_ID,
  MAX_HISTORY_LIMIT,
  MAX_NICKNAME_LENGTH,
  type ChatMessage,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type MessageHistoryResponse,
  type ReconnectSyncResponse,
  type SessionPayload
} from "../../../packages/shared/protocol";
import { createSessionToken, verifySessionToken } from "./crypto";
import { SlidingWindowRateLimiter } from "./rate-limit";
import { ChatRoom } from "./room";
import {
  buildCorsHeaders,
  decodeCursor,
  encodeCursor,
  errorResponse,
  getBearerToken,
  getClientIp,
  jsonResponse,
  normalizeNickname,
  resolveAllowedOrigin
} from "./utils";

export { ChatRoom } from "./room";

type MessageRecord = {
  id: string;
  room_id: string;
  user_id: string;
  nickname: string;
  content: string;
  created_at: number;
};

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  CHAT_DB: D1Database;
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

function mapMessageRecord(record: MessageRecord): ChatMessage {
  return {
    id: record.id,
    roomId: record.room_id,
    userId: record.user_id,
    nickname: record.nickname,
    content: record.content,
    createdAt: record.created_at
  };
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
      message: "昵称格式不正确"
    });
  }

  const nickname = normalizeNickname(payload.nickname);
  if (!nickname || nickname.length > MAX_NICKNAME_LENGTH) {
    return errorResponse(request, env, 400, {
      code: "invalid_nickname",
      message: `昵称不能为空且长度不能超过 ${MAX_NICKNAME_LENGTH} 字符`
    });
  }

  const ip = getClientIp(request);
  if (!sessionRateLimiter.consume(`session:${ip}`, SESSION_RATE_LIMIT_PER_MINUTE, 60_000)) {
    return errorResponse(request, env, 429, {
      code: "rate_limited",
      message: "请求过于频繁，请稍后再试"
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
      message: "无效或过期的 token"
    });
  }

  const url = new URL(request.url);
  const roomId = url.searchParams.get("room") ?? GLOBAL_ROOM_ID;
  if (roomId !== GLOBAL_ROOM_ID) {
    return errorResponse(request, env, 400, {
      code: "invalid_room",
      message: "首版仅支持 global 房间"
    });
  }

  const after = url.searchParams.get("after");
  if (after) {
    const afterTimestamp = Number(after);
    if (!Number.isFinite(afterTimestamp)) {
      return errorResponse(request, env, 400, {
        code: "bad_request",
        message: "after 参数必须为时间戳"
      });
    }

    const query = await env.CHAT_DB.prepare(
      `
        SELECT id, room_id, user_id, nickname, content, created_at
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
        items: (query.results ?? []).map(mapMessageRecord)
      }
    };

    return jsonResponse(request, env, responseBody);
  }

  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_HISTORY_LIMIT);
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), MAX_HISTORY_LIMIT);
  const cursorRaw = url.searchParams.get("cursor");

  let queryText = `
    SELECT id, room_id, user_id, nickname, content, created_at
    FROM messages
    WHERE room_id = ?
  `;
  const bindValues: unknown[] = [roomId];

  if (cursorRaw) {
    const cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return errorResponse(request, env, 400, {
        code: "bad_request",
        message: "cursor 参数格式不正确"
      });
    }

    queryText += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    bindValues.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  queryText += " ORDER BY created_at DESC, id DESC LIMIT ?";
  bindValues.push(limit);

  const rows = await env.CHAT_DB.prepare(queryText).bind(...bindValues).all<MessageRecord>();
  const records = rows.results ?? [];
  const items = records.map(mapMessageRecord).reverse();
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

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const url = new URL(request.url);
  const roomId = url.searchParams.get("room") ?? GLOBAL_ROOM_ID;
  if (roomId !== GLOBAL_ROOM_ID) {
    return errorResponse(request, env, 400, {
      code: "invalid_room",
      message: "首版仅支持 global 房间"
    });
  }

  const token = url.searchParams.get("token");
  if (!token) {
    return errorResponse(request, env, 401, {
      code: "invalid_token",
      message: "缺少 token"
    });
  }

  const session = await verifySessionToken(token, env.SESSION_SECRET, getSessionTtlSeconds(env));
  if (!session) {
    return errorResponse(request, env, 401, {
      code: "invalid_token",
      message: "无效或过期的 token"
    });
  }

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(request, env, 400, {
      code: "bad_request",
      message: "必须使用 WebSocket 协议升级"
    });
  }

  const durableObjectId = env.CHAT_ROOM.idFromName(roomId);
  const roomStub = env.CHAT_ROOM.get(durableObjectId);
  const forwardRequest = new Request(request.url, request);
  forwardRequest.headers.set("x-user-id", session.userId);
  forwardRequest.headers.set("x-nickname", session.nickname);
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

    if (url.pathname === API_PATHS.websocket && request.method === "GET") {
      return handleWebSocket(request, env);
    }

    return errorResponse(request, env, 404, {
      code: "bad_request",
      message: "Route not found"
    });
  }
} satisfies ExportedHandler<Env>;
