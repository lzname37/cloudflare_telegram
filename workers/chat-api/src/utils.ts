import {
  API_PATHS,
  GLOBAL_ROOM_ID,
  isValidRoomId,
  normalizeRoomId,
  type ApiErrorCode,
  type ApiErrorResponse
} from "../../../packages/shared/protocol";

type OriginEnv = {
  ALLOWED_ORIGINS?: string;
};

export type ErrorResponseInput = {
  code: ApiErrorCode;
  message: string;
};

function normalizeOriginValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/g, "");
  }
}

function parseAllowedOrigins(raw?: string): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((item) => normalizeOriginValue(item))
      .filter((item): item is string => Boolean(item))
  );
}

export function resolveAllowedOrigin(request: Request, env: OriginEnv): string | null {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (allowedOrigins.size === 0) {
    return null;
  }

  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    return null;
  }

  const normalizedOrigin = normalizeOriginValue(originHeader);
  if (!normalizedOrigin) {
    return null;
  }

  return allowedOrigins.has(normalizedOrigin) ? normalizedOrigin : null;
}

export function buildCorsHeaders(request: Request, env: OriginEnv): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");

  const allowedOrigin = resolveAllowedOrigin(request, env);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
  }

  return headers;
}

export function jsonResponse(request: Request, env: OriginEnv, body: unknown, status = 200): Response {
  const headers = buildCorsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(
  request: Request,
  env: OriginEnv,
  status: number,
  error: ErrorResponseInput
): Response {
  const body: ApiErrorResponse = {
    ok: false,
    error
  };
  return jsonResponse(request, env, body, status);
}

export function normalizeNickname(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export function getClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`;
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const parts = cursor.split(":");
  if (parts.length < 2) {
    return null;
  }

  const createdAt = Number(parts[0]);
  const id = parts.slice(1).join(":");
  if (!Number.isFinite(createdAt) || !id) {
    return null;
  }

  return { createdAt, id };
}

export function resolveRoomId(raw: string | null | undefined): string | null {
  const normalized = normalizeRoomId(raw ?? GLOBAL_ROOM_ID);
  return isValidRoomId(normalized) ? normalized : null;
}

export function buildMediaUrl(request: Request, imageKey: string): string {
  const url = new URL(request.url);
  url.pathname = `${API_PATHS.media}/${encodeURIComponent(imageKey)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
