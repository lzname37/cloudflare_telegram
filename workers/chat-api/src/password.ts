const PBKDF2_ALGORITHM = "pbkdf2_sha256";
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const encoder = new TextEncoder();

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

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }

  return diff === 0;
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: saltCopy.buffer
    },
    keyMaterial,
    PBKDF2_KEY_LENGTH * 8
  );

  return new Uint8Array(derivedBits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const derived = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);

  return `${PBKDF2_ALGORITHM}$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = encodedHash.split("$");
  if (!algorithm || !iterationsRaw || !saltRaw || !hashRaw || algorithm !== PBKDF2_ALGORITHM) {
    return false;
  }

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }

  let salt: Uint8Array;
  let storedHash: Uint8Array;
  try {
    salt = base64UrlToBytes(saltRaw);
    storedHash = base64UrlToBytes(hashRaw);
  } catch {
    return false;
  }

  const derived = await derivePbkdf2(password, salt, iterations);
  return timingSafeEqualBytes(derived, storedHash);
}
