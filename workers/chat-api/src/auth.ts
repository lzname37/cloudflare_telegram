import { API_PATHS, MAX_NICKNAME_LENGTH } from "../../../packages/shared/protocol";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GITHUB_OAUTH_SCOPE = "read:user user:email";

export const GITHUB_STATE_COOKIE_NAME = "cf_chat_github_state";
export const GITHUB_STATE_TTL_SECONDS = 600;

type GithubAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GithubUserResponse = {
  id: number;
  login: string;
  name: string | null;
};

type GithubEmailResponse = {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
};

export type GithubUserProfile = {
  githubId: string;
  email: string;
  nickname: string;
};

type GithubEnv = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeNickname(value: string): string {
  const collapsed = value.trim().replace(/\s+/g, " ");
  const sanitized = collapsed.replace(/[^\w.-]/g, "");
  if (!sanitized) {
    return "";
  }

  return sanitized.slice(0, MAX_NICKNAME_LENGTH);
}

export function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !EMAIL_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

export function deriveNicknameFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const fromEmail = normalizeNickname(localPart);
  if (fromEmail) {
    return fromEmail;
  }

  return `user_${crypto.randomUUID().slice(0, 8)}`;
}

export function deriveNicknameFromGithub(login: string, name: string | null): string {
  const fromName = normalizeNickname(name ?? "");
  if (fromName) {
    return fromName;
  }

  const fromLogin = normalizeNickname(login);
  if (fromLogin) {
    return fromLogin;
  }

  return `user_${crypto.randomUUID().slice(0, 8)}`;
}

export function createGithubState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return bytesToBase64Url(bytes);
}

export function buildGithubStateCookie(request: Request, state: string): string {
  const isSecure = new URL(request.url).protocol === "https:";
  const secure = isSecure ? "; Secure" : "";
  return `${GITHUB_STATE_COOKIE_NAME}=${state}; Max-Age=${GITHUB_STATE_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function buildClearedGithubStateCookie(request: Request): string {
  const isSecure = new URL(request.url).protocol === "https:";
  const secure = isSecure ? "; Secure" : "";
  return `${GITHUB_STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) {
    return null;
  }

  for (const segment of raw.split(";")) {
    const [cookieName, ...rest] = segment.trim().split("=");
    if (cookieName !== name) {
      continue;
    }

    return rest.join("=");
  }

  return null;
}

export function buildGithubAuthorizeUrl(request: Request, clientId: string, state: string): string {
  const redirectUri = new URL(API_PATHS.authGithubCallback, new URL(request.url).origin).toString();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

function requireGithubClientConfig(env: GithubEnv): { clientId: string; clientSecret: string } {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth is not configured");
  }

  return { clientId, clientSecret };
}

async function exchangeGithubCodeForAccessToken(request: Request, env: GithubEnv, code: string): Promise<string> {
  const { clientId, clientSecret } = requireGithubClientConfig(env);
  const redirectUri = new URL(API_PATHS.authGithubCallback, new URL(request.url).origin).toString();

  const payload = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri
  });

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "cloudflare-chat-mvp"
    },
    body: payload.toString()
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed with status ${response.status}`);
  }

  const data = (await response.json()) as GithubAccessTokenResponse;
  if (!data.access_token) {
    const reason = data.error_description ?? data.error ?? "Unknown GitHub token exchange error";
    throw new Error(reason);
  }

  return data.access_token;
}

async function fetchGithubUser(accessToken: string): Promise<GithubUserResponse> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "cloudflare-chat-mvp"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed with status ${response.status}`);
  }

  return (await response.json()) as GithubUserResponse;
}

async function fetchGithubPrimaryEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "cloudflare-chat-mvp"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub email fetch failed with status ${response.status}`);
  }

  const emails = (await response.json()) as GithubEmailResponse[];
  const primaryVerified = emails.find((entry) => entry.primary && entry.verified);
  if (primaryVerified) {
    return primaryVerified.email;
  }

  const firstVerified = emails.find((entry) => entry.verified);
  if (firstVerified) {
    return firstVerified.email;
  }

  throw new Error("No verified email returned by GitHub");
}

export async function resolveGithubProfile(request: Request, env: GithubEnv, code: string): Promise<GithubUserProfile> {
  const accessToken = await exchangeGithubCodeForAccessToken(request, env, code);
  const [user, emailRaw] = await Promise.all([fetchGithubUser(accessToken), fetchGithubPrimaryEmail(accessToken)]);
  const email = normalizeEmail(emailRaw);
  if (!email) {
    throw new Error("GitHub returned an invalid email");
  }

  return {
    githubId: String(user.id),
    email,
    nickname: deriveNicknameFromGithub(user.login, user.name)
  };
}
