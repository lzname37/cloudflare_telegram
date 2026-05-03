import {
  API_PATHS,
  DEFAULT_HISTORY_LIMIT,
  GLOBAL_ROOM_ID,
  MAX_HISTORY_LIMIT,
  MAX_IMAGE_SIZE_BYTES,
  MIN_PASSWORD_LENGTH,
  createImageObjectKey,
  isImageMimeType,
  isSafeImageKey,
  type AnyChatMessage,
  type AuthSessionData,
  type AuthSessionResponse,
  type ImageMimeType,
  type LoginWithEmailRequest,
  type MessageHistoryResponse,
  type ReconnectSyncResponse,
  type RegisterWithEmailRequest,
  type SessionPayload,
  type UploadImageResponse
} from "../../../packages/shared/protocol";
import {
  GITHUB_STATE_COOKIE_NAME,
  buildClearedGithubStateCookie,
  buildGithubAuthorizeUrl,
  buildGithubStateCookie,
  createGithubState,
  deriveNicknameFromEmail,
  normalizeEmail,
  readCookie,
  resolveGithubProfile
} from "./auth";
import { createSessionToken, verifySessionToken } from "./crypto";
import { hashPassword, verifyPassword } from "./password";
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

type UserRecord = {
  user_id: string;
  nickname: string;
  email: string | null;
  password_hash: string | null;
  github_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
};

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  CHAT_DB: D1Database;
  CHAT_MEDIA: R2Bucket;
  SESSION_SECRET: string;
  ALLOWED_ORIGINS?: string | string[] | readonly string[];
  SESSION_TTL_SECONDS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  WEB_APP_ORIGIN?: string;
}

const AUTH_RATE_LIMIT_PER_MINUTE = 20;
const authRateLimiter = new SlidingWindowRateLimiter();

function getSessionTtlSeconds(env: Env): number {
  const ttl = Number(env.SESSION_TTL_SECONDS ?? 604800);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 604800;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAuthSession(data: AuthSessionData): string {
  const serialized = JSON.stringify(data);
  return bytesToBase64Url(new TextEncoder().encode(serialized));
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

function buildAuthSession(userId: string, nickname: string, email: string, token: string): AuthSessionResponse {
  return {
    ok: true,
    data: {
      userId,
      nickname,
      email,
      token
    }
  };
}

async function createSignedSession(userId: string, nickname: string, email: string, env: Env): Promise<AuthSessionData> {
  const payload: SessionPayload = {
    userId,
    nickname,
    issuedAt: Date.now()
  };

  const token = await createSessionToken(payload, env.SESSION_SECRET);
  return {
    userId,
    nickname,
    email,
    token
  };
}

async function findUserByEmail(env: Env, email: string): Promise<UserRecord | null> {
  const row = await env.CHAT_DB.prepare(
    `
      SELECT user_id, nickname, email, password_hash, github_id, first_seen_at, last_seen_at
      FROM users
      WHERE email = ?
      LIMIT 1
    `
  )
    .bind(email)
    .first<UserRecord>();

  return row ?? null;
}

async function findUserByGithubId(env: Env, githubId: string): Promise<UserRecord | null> {
  const row = await env.CHAT_DB.prepare(
    `
      SELECT user_id, nickname, email, password_hash, github_id, first_seen_at, last_seen_at
      FROM users
      WHERE github_id = ?
      LIMIT 1
    `
  )
    .bind(githubId)
    .first<UserRecord>();

  return row ?? null;
}

function getWebAppUrlOrError(request: Request, env: Env): { webAppUrl: URL } | { error: Response } {
  const raw = env.WEB_APP_ORIGIN?.trim();
  if (!raw) {
    return {
      error: errorResponse(request, env, 500, {
        code: "internal_error",
        message: "WEB_APP_ORIGIN is not configured"
      })
    };
  }

  try {
    return { webAppUrl: new URL(raw) };
  } catch {
    return {
      error: errorResponse(request, env, 500, {
        code: "internal_error",
        message: "WEB_APP_ORIGIN is invalid"
      })
    };
  }
}

function buildRedirectToWebApp(env: Env, pathParams: (url: URL) => void): URL | null {
  const raw = env.WEB_APP_ORIGIN?.trim();
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    pathParams(url);
    return url;
  } catch {
    return null;
  }
}

function redirectToWebAppError(request: Request, env: Env, errorCode: string, clearCookie: string): Response {
  const redirectUrl = buildRedirectToWebApp(env, (url) => {
    url.searchParams.set("auth_error", errorCode);
  });

  if (!redirectUrl) {
    return errorResponse(request, env, 500, {
      code: "oauth_failed",
      message: "WEB_APP_ORIGIN is not configured"
    });
  }

  const headers = buildCorsHeaders(request, env);
  headers.set("Location", redirectUrl.toString());
  headers.append("Set-Cookie", clearCookie);
  return new Response(null, { status: 302, headers });
}

function redirectToWebAppWithSession(request: Request, env: Env, session: AuthSessionData, clearCookie: string): Response {
  const redirectUrl = buildRedirectToWebApp(env, (url) => {
    url.searchParams.set("auth_session", encodeAuthSession(session));
  });

  if (!redirectUrl) {
    return errorResponse(request, env, 500, {
      code: "oauth_failed",
      message: "WEB_APP_ORIGIN is not configured"
    });
  }

  const headers = buildCorsHeaders(request, env);
  headers.set("Location", redirectUrl.toString());
  headers.append("Set-Cookie", clearCookie);
  return new Response(null, { status: 302, headers });
}

async function parseCredentialPayload<T extends RegisterWithEmailRequest | LoginWithEmailRequest>(
  request: Request
): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function validateAuthRateLimit(request: Request, env: Env, keyPrefix: string): Response | null {
  const ip = getClientIp(request);
  if (!authRateLimiter.consume(`${keyPrefix}:${ip}`, AUTH_RATE_LIMIT_PER_MINUTE, 60_000)) {
    return errorResponse(request, env, 429, {
      code: "rate_limited",
      message: "Too many authentication requests"
    });
  }

  return null;
}

async function handleLegacyCreateSession(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  return errorResponse(request, env, 410, {
    code: "bad_request",
    message: "Anonymous session login is disabled. Use email or GitHub login."
  });
}

async function handleRegisterWithEmail(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const limited = validateAuthRateLimit(request, env, "register");
  if (limited) {
    return limited;
  }

  const payload = await parseCredentialPayload<RegisterWithEmailRequest>(request);
  if (!payload || typeof payload.email !== "string" || typeof payload.password !== "string") {
    return errorResponse(request, env, 400, {
      code: "bad_request",
      message: "Invalid JSON body"
    });
  }

  const email = normalizeEmail(payload.email);
  if (!email) {
    return errorResponse(request, env, 400, {
      code: "invalid_email",
      message: "Invalid email address"
    });
  }

  if (payload.password.length < MIN_PASSWORD_LENGTH) {
    return errorResponse(request, env, 400, {
      code: "invalid_password",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    });
  }

  const passwordHash = await hashPassword(payload.password);
  const now = Date.now();
  const userId = crypto.randomUUID();
  const nickname = deriveNicknameFromEmail(email);

  try {
    await env.CHAT_DB.prepare(
      `
        INSERT INTO users (user_id, nickname, email, password_hash, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
      .bind(userId, nickname, email, passwordHash, now, now)
      .run();
  } catch (error) {
    const message = String(error);
    if (message.includes("UNIQUE constraint failed")) {
      return errorResponse(request, env, 409, {
        code: "email_taken",
        message: "Email is already registered"
      });
    }

    console.error("Email registration failed", error);
    return errorResponse(request, env, 500, {
      code: "internal_error",
      message: "Failed to create account"
    });
  }

  const session = await createSignedSession(userId, nickname, email, env);
  return jsonResponse(request, env, buildAuthSession(session.userId, session.nickname, session.email, session.token), 201);
}

async function handleLoginWithEmail(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const limited = validateAuthRateLimit(request, env, "login");
  if (limited) {
    return limited;
  }

  const payload = await parseCredentialPayload<LoginWithEmailRequest>(request);
  if (!payload || typeof payload.email !== "string" || typeof payload.password !== "string") {
    return errorResponse(request, env, 400, {
      code: "bad_request",
      message: "Invalid JSON body"
    });
  }

  const email = normalizeEmail(payload.email);
  if (!email) {
    return errorResponse(request, env, 400, {
      code: "invalid_email",
      message: "Invalid email address"
    });
  }

  const user = await findUserByEmail(env, email);
  if (!user) {
    return errorResponse(request, env, 404, {
      code: "account_not_found",
      message: "Account not found"
    });
  }

  if (!user.password_hash) {
    return errorResponse(request, env, 401, {
      code: "invalid_password",
      message: "Password login is not available for this account"
    });
  }

  const matched = await verifyPassword(payload.password, user.password_hash);
  if (!matched) {
    return errorResponse(request, env, 401, {
      code: "invalid_password",
      message: "Invalid password"
    });
  }

  const now = Date.now();
  await env.CHAT_DB.prepare(
    `
      UPDATE users
      SET last_seen_at = ?
      WHERE user_id = ?
    `
  )
    .bind(now, user.user_id)
    .run();

  const session = await createSignedSession(user.user_id, user.nickname, email, env);
  return jsonResponse(request, env, buildAuthSession(session.userId, session.nickname, session.email, session.token), 200);
}

async function handleGithubOauthStart(request: Request, env: Env): Promise<Response> {
  const originError = assertAllowedOrigin(request, env);
  if (originError) {
    return originError;
  }

  const webAppConfig = getWebAppUrlOrError(request, env);
  if ("error" in webAppConfig) {
    return webAppConfig.error;
  }
  void webAppConfig.webAppUrl;

  const clientId = env.GITHUB_CLIENT_ID?.trim();
  if (!clientId) {
    return errorResponse(request, env, 500, {
      code: "oauth_failed",
      message: "GitHub OAuth is not configured"
    });
  }

  const state = createGithubState();
  const authorizeUrl = buildGithubAuthorizeUrl(request, clientId, state);

  const headers = buildCorsHeaders(request, env);
  headers.set("Location", authorizeUrl);
  headers.append("Set-Cookie", buildGithubStateCookie(request, state));
  return new Response(null, { status: 302, headers });
}

async function handleGithubOauthCallback(request: Request, env: Env): Promise<Response> {
  const clearStateCookie = buildClearedGithubStateCookie(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, GITHUB_STATE_COOKIE_NAME);

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectToWebAppError(request, env, "oauth_state_invalid", clearStateCookie);
  }

  try {
    const githubProfile = await resolveGithubProfile(request, env, code);
    const now = Date.now();

    let user = await findUserByEmail(env, githubProfile.email);
    if (user) {
      if (user.github_id && user.github_id !== githubProfile.githubId) {
        return redirectToWebAppError(request, env, "oauth_failed", clearStateCookie);
      }

      await env.CHAT_DB.prepare(
        `
          UPDATE users
          SET github_id = ?, last_seen_at = ?
          WHERE user_id = ?
        `
      )
        .bind(githubProfile.githubId, now, user.user_id)
        .run();
    } else {
      user = await findUserByGithubId(env, githubProfile.githubId);
      if (user) {
        await env.CHAT_DB.prepare(
          `
            UPDATE users
            SET email = ?, last_seen_at = ?
            WHERE user_id = ?
          `
        )
          .bind(githubProfile.email, now, user.user_id)
          .run();
      } else {
        const userId = crypto.randomUUID();
        await env.CHAT_DB.prepare(
          `
            INSERT INTO users (user_id, nickname, email, github_id, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `
        )
          .bind(userId, githubProfile.nickname, githubProfile.email, githubProfile.githubId, now, now)
          .run();

        user = {
          user_id: userId,
          nickname: githubProfile.nickname,
          email: githubProfile.email,
          password_hash: null,
          github_id: githubProfile.githubId,
          first_seen_at: now,
          last_seen_at: now
        };
      }
    }

    if (!user.email) {
      return redirectToWebAppError(request, env, "oauth_failed", clearStateCookie);
    }

    const session = await createSignedSession(user.user_id, user.nickname, user.email, env);
    return redirectToWebAppWithSession(request, env, session, clearStateCookie);
  } catch (error) {
    console.error("GitHub OAuth callback failed", error);
    return redirectToWebAppError(request, env, "oauth_failed", clearStateCookie);
  }
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
      return handleLegacyCreateSession(request, env);
    }

    if (url.pathname === API_PATHS.authEmailRegister && request.method === "POST") {
      return handleRegisterWithEmail(request, env);
    }

    if (url.pathname === API_PATHS.authEmailLogin && request.method === "POST") {
      return handleLoginWithEmail(request, env);
    }

    if (url.pathname === API_PATHS.authGithubStart && request.method === "GET") {
      return handleGithubOauthStart(request, env);
    }

    if (url.pathname === API_PATHS.authGithubCallback && request.method === "GET") {
      return handleGithubOauthCallback(request, env);
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
