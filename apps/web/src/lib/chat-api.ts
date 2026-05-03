import {
  API_PATHS,
  type ApiErrorResponse,
  type CreateSessionResponse,
  type MessageHistoryResponse,
  type ReconnectSyncResponse,
  type UploadImageResponse
} from "../../../../packages/shared/protocol";

type ApiSuccess = CreateSessionResponse | MessageHistoryResponse | ReconnectSyncResponse | UploadImageResponse;
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

  async createSession(nickname: string): Promise<CreateSessionResponse["data"]> {
    const response = await fetch(`${this.baseUrl}${API_PATHS.session}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ nickname })
    });

    const payload = await parseResponse<CreateSessionResponse>(response);
    return payload.data;
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
