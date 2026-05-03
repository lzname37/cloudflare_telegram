export const GLOBAL_ROOM_ID = "global";
export const MAX_NICKNAME_LENGTH = 24;
export const MAX_MESSAGE_LENGTH = 500;
export const MIN_PASSWORD_LENGTH = 8;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;
export const ROOM_ID_MIN_LENGTH = 1;
export const ROOM_ID_MAX_LENGTH = 32;
export const ROOM_ID_PATTERN = /^[a-z0-9_-]+$/;
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const ALLOWED_IMAGE_ACCEPT = ALLOWED_IMAGE_MIME_TYPES.join(",");
export type ImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "invalid_room"
  | "invalid_token"
  | "invalid_nickname"
  | "invalid_email"
  | "invalid_password"
  | "email_taken"
  | "account_not_found"
  | "oauth_state_invalid"
  | "oauth_failed"
  | "message_empty"
  | "message_too_long"
  | "invalid_image"
  | "image_too_large"
  | "invalid_image_key"
  | "not_found"
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
    email?: string;
    token: string;
  };
}

export interface RegisterWithEmailRequest {
  email: string;
  password: string;
}

export interface LoginWithEmailRequest {
  email: string;
  password: string;
}

export interface AuthSessionData {
  userId: string;
  nickname: string;
  email: string;
  token: string;
}

export interface AuthSessionResponse {
  ok: true;
  data: AuthSessionData;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  createdAt: number;
  kind: "text" | "image";
}

export interface TextChatMessage extends ChatMessage {
  kind: "text";
  content: string;
}

export interface ImageChatMessage extends ChatMessage {
  kind: "image";
  imageKey: string;
  imageUrl: string;
  imageMimeType: ImageMimeType;
  imageSizeBytes: number;
}

export type AnyChatMessage = TextChatMessage | ImageChatMessage;

export interface UploadedImage {
  roomId: string;
  imageKey: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
}

export interface MessageHistoryResponse {
  ok: true;
  data: {
    roomId: string;
    items: AnyChatMessage[];
    nextCursor: string | null;
  };
}

export interface ReconnectSyncResponse {
  ok: true;
  data: {
    roomId: string;
    items: AnyChatMessage[];
  };
}

export interface UploadImageResponse {
  ok: true;
  data: UploadedImage;
}

export interface UploadImageMeta {
  imageKey: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
}

export type UploadImageRequestEvent = {
  type: "send_image";
  imageKey: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
};

export type SendTextRequestEvent =
  | {
      type: "send_message";
      content: string;
    }
  | {
      type: "send_text";
      content: string;
    };

export type PingEvent = {
  type: "ping";
};

export type SendImageEvent = {
  type: "send_image";
  imageKey: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
};

export type ClientSocketEvent = SendTextRequestEvent | SendImageEvent | PingEvent;

export type ServerSocketEvent =
  | {
      type: "message";
      message: AnyChatMessage;
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

export function normalizeRoomId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isValidRoomId(roomId: string): boolean {
  return (
    roomId.length >= ROOM_ID_MIN_LENGTH &&
    roomId.length <= ROOM_ID_MAX_LENGTH &&
    ROOM_ID_PATTERN.test(roomId)
  );
}

export function normalizeAndValidateRoomId(value: string | null | undefined): string | null {
  const roomId = normalizeRoomId(value);
  return isValidRoomId(roomId) ? roomId : null;
}

export function isImageMimeType(value: string): value is ImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function getImageExtension(mimeType: ImageMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export function isSafeImageKey(imageKey: string): boolean {
  if (!imageKey) {
    return false;
  }

  if (imageKey.startsWith("/") || imageKey.includes("..") || imageKey.includes("\\")) {
    return false;
  }

  return /^[a-z0-9_./-]+$/.test(imageKey);
}

export function buildMediaPath(imageKey: string): string {
  return `${API_PATHS.media}/${encodeURIComponent(imageKey)}`;
}

export function getRoomScopedImagePrefix(roomId: string, userId: string): string {
  return `${roomId}/${userId}/`;
}

export function isRoomScopedImageKey(imageKey: string, roomId: string, userId: string): boolean {
  return isSafeImageKey(imageKey) && imageKey.startsWith(getRoomScopedImagePrefix(roomId, userId));
}

export function createImageObjectKey(roomId: string, userId: string, mimeType: ImageMimeType): string {
  const timestamp = Date.now();
  const extension = getImageExtension(mimeType);
  return `${getRoomScopedImagePrefix(roomId, userId)}${timestamp}_${crypto.randomUUID()}.${extension}`;
}

export function toImageChatMessage(
  base: Pick<ChatMessage, "id" | "roomId" | "userId" | "nickname" | "createdAt">,
  image: UploadedImage,
  imageUrl: string
): ImageChatMessage {
  return {
    ...base,
    kind: "image",
    imageKey: image.imageKey,
    imageMimeType: image.mimeType,
    imageSizeBytes: image.sizeBytes,
    imageUrl
  };
}

export function toTextChatMessage(
  base: Pick<ChatMessage, "id" | "roomId" | "userId" | "nickname" | "createdAt">,
  content: string
): TextChatMessage {
  return {
    ...base,
    kind: "text",
    content
  };
}

export const API_PATHS = {
  session: "/api/session",
  authEmailRegister: "/api/auth/email/register",
  authEmailLogin: "/api/auth/email/login",
  authGithubStart: "/api/auth/github/start",
  authGithubCallback: "/api/auth/github/callback",
  messages: "/api/messages",
  websocket: "/ws",
  uploadImage: "/api/uploads/image",
  media: "/api/media"
} as const;
