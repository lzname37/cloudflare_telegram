import {
  API_PATHS,
  type ApiErrorResponse,
  type AuthSessionResponse,
  type LoginWithEmailRequest,
  type MessageHistoryResponse,
  type ReconnectSyncResponse,
  type RegisterWithEmailRequest,
  type UploadImageResponse
} from "../../../../packages/shared/protocol";

type ApiSuccess = AuthSessionResponse | MessageHistoryResponse | ReconnectSyncResponse | UploadImageResponse;
type ApiFailure = ApiErrorResponse;
type ApiPayload = ApiSuccess | ApiFailure;

function isApiFailure(payload: ApiPayload): payload is ApiFailure {
  return payload.ok === false;
}

async function parseResponse<T extends ApiPayload>(response: Response): Promise<T> {
  let payload: ApiPayload;
  try {
    payload = (await response.json()) as ApiPayload;
  } catch {
    throw new Error("服务返回了非 JSON 响应");
  }

  if (!response.ok || isApiFailure(payload)) {
    const message = isApiFailure(payload) ? payload.error.message : "请求失败";
    throw new Error(message);
  }

  return payload as T;
}

export class ChatApi {
  constructor(private readonly baseUrl: string) {}

  getGithubOauthStartUrl(): string {
    return `${this.baseUrl}${API_PATHS.authGithubStart}`;
  }

  async registerWithEmail(payload: RegisterWithEmailRequest): Promise<AuthSessionResponse["data"]> {
    const response = await fetch(`${this.baseUrl}${API_PATHS.authEmailRegister}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const parsed = await parseResponse<AuthSessionResponse>(response);
    return parsed.data;
  }

  async loginWithEmail(payload: LoginWithEmailRequest): Promise<AuthSessionResponse["data"]> {
    const response = await fetch(`${this.baseUrl}${API_PATHS.authEmailLogin}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const parsed = await parseResponse<AuthSessionResponse>(response);
    return parsed.data;
  }

  async getMessages(
    token: string,
    roomId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<MessageHistoryResponse["data"]> {
    const query = new URLSearchParams();
    query.set("room", roomId);
    if (options?.cursor) {
      query.set("cursor", options.cursor);
    }
    if (options?.limit) {
      query.set("limit", String(options.limit));
    }

    const response = await fetch(`${this.baseUrl}${API_PATHS.messages}?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const payload = await parseResponse<MessageHistoryResponse>(response);
    return payload.data;
  }

  async getMessagesAfter(token: string, roomId: string, afterTimestamp: number): Promise<ReconnectSyncResponse["data"]> {
    const query = new URLSearchParams();
    query.set("room", roomId);
    query.set("after", String(afterTimestamp));
    const response = await fetch(`${this.baseUrl}${API_PATHS.messages}?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const payload = await parseResponse<ReconnectSyncResponse>(response);
    return payload.data;
  }

  async uploadImage(token: string, roomId: string, file: File): Promise<UploadImageResponse["data"]> {
    const query = new URLSearchParams();
    query.set("room", roomId);

    const formData = new FormData();
    formData.set("file", file);

    const response = await fetch(`${this.baseUrl}${API_PATHS.uploadImage}?${query.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });

    const payload = await parseResponse<UploadImageResponse>(response);
    return payload.data;
  }
}
