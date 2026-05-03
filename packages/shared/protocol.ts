export const GLOBAL_ROOM_ID = "global";
export const MAX_NICKNAME_LENGTH = 24;
export const MAX_MESSAGE_LENGTH = 500;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "invalid_room"
  | "invalid_token"
  | "invalid_nickname"
  | "message_empty"
  | "message_too_long"
  | "rate_limited"
  | "internal_error";

export interface ApiErrorResponse {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export interface SessionPayload {
  userId: string;
  nickname: string;
  issuedAt: number;
}

export interface CreateSessionRequest {
  nickname: string;
}

export interface CreateSessionResponse {
  ok: true;
  data: {
    userId: string;
    nickname: string;
    token: string;
  };
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  content: string;
  createdAt: number;
}

export interface MessageHistoryResponse {
  ok: true;
  data: {
    roomId: string;
    items: ChatMessage[];
    nextCursor: string | null;
  };
}

export interface ReconnectSyncResponse {
  ok: true;
  data: {
    roomId: string;
    items: ChatMessage[];
  };
}

export type ClientSocketEvent =
  | {
      type: "send_message";
      content: string;
    }
  | {
      type: "ping";
    };

export type ServerSocketEvent =
  | {
      type: "message";
      message: ChatMessage;
    }
  | {
      type: "presence";
      onlineCount: number;
    }
  | {
      type: "error";
      code: ApiErrorCode;
      message: string;
    }
  | {
      type: "ack";
      requestType: "ping";
      timestamp: number;
    };

export const API_PATHS = {
  session: "/api/session",
  messages: "/api/messages",
  websocket: "/ws"
} as const;
