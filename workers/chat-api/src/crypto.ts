import type { SessionPayload } from "../../../packages/shared/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken(payload: SessionPayload, secret: string): Promise<string> {
  const payloadBase64 = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(secret, payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  ttlSeconds: number
): Promise<SessionPayload | null> {
  const [payloadBase64, signature] = token.split(".");
  if (!payloadBase64 || !signature) {
    return null;
  }

  const expectedSignature = await sign(secret, payloadBase64);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadBase64))) as SessionPayload;
  } catch {
    return null;
  }

  if (!payload.userId || !payload.nickname || !Number.isFinite(payload.issuedAt)) {
    return null;
  }

  if (ttlSeconds > 0) {
    const maxAge = ttlSeconds * 1000;
    if (Date.now() - payload.issuedAt > maxAge) {
      return null;
    }
  }

  return payload;
}
