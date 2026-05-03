import { DurableObject } from "cloudflare:workers";
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_MESSAGE_LENGTH,
  isImageMimeType,
  isRoomScopedImageKey,
  type AnyChatMessage,
  type ApiErrorCode,
  type ClientSocketEvent,
  type ImageMimeType,
  type ServerSocketEvent
} from "../../../packages/shared/protocol";
import { SlidingWindowRateLimiter } from "./rate-limit";
import { resolveRoomId } from "./utils";

type RoomEnv = {
  CHAT_DB: D1Database;
};

type SocketAttachment = {
  roomId: string;
  userId: string;
  nickname: string;
  mediaBaseUrl: string;
};

const MESSAGE_RATE_LIMIT = 12;
const MESSAGE_RATE_WINDOW_MS = 10_000;

function buildImageUrl(mediaBaseUrl: string, imageKey: string): string {
  return `${mediaBaseUrl}/${encodeURIComponent(imageKey)}`;
}

export class ChatRoom extends DurableObject<RoomEnv> {
  private readonly rateLimiter = new SlidingWindowRateLimiter();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const roomFromHeader = request.headers.get("x-room-id");
    const roomFromQuery = url.searchParams.get("room");
    const roomId = resolveRoomId(roomFromHeader ?? roomFromQuery);
    const userId = request.headers.get("x-user-id");
    const nickname = request.headers.get("x-nickname");
    const mediaBaseUrl = request.headers.get("x-media-base-url");

    if (!roomId || !userId || !nickname || !mediaBaseUrl) {
      return new Response("Unauthorized", { status: 401 });
    }

    const websocketPair = new WebSocketPair();
    const client = websocketPair[0];
    const server = websocketPair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      roomId,
      userId,
      nickname,
      mediaBaseUrl
    } satisfies SocketAttachment);
    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      this.sendSocketError(ws, "unauthorized", "Missing socket session");
      ws.close(1008, "Missing session");
      return;
    }

    const payloadText = typeof message === "string" ? message : new TextDecoder().decode(message);
    let event: ClientSocketEvent;
    try {
      event = JSON.parse(payloadText) as ClientSocketEvent;
    } catch {
      this.sendSocketError(ws, "bad_request", "Invalid message payload");
      return;
    }

    if (event.type === "ping") {
      this.sendSocketEvent(ws, {
        type: "ack",
        requestType: "ping",
        timestamp: Date.now()
      });
      return;
    }

    const rateLimitKey = `${attachment.roomId}:${attachment.userId}`;
    if (!this.rateLimiter.consume(rateLimitKey, MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS)) {
      this.sendSocketError(ws, "rate_limited", "Sending messages too fast");
      return;
    }

    if (event.type === "send_message" || event.type === "send_text") {
      await this.handleSendText(ws, attachment, event.content);
      return;
    }

    if (event.type === "send_image") {
      await this.handleSendImage(ws, attachment, event.imageKey, event.mimeType, event.sizeBytes);
      return;
    }

    this.sendSocketError(ws, "bad_request", "Unsupported event type");
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {
    this.broadcastPresence();
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    this.broadcastPresence();
  }

  private async handleSendText(ws: WebSocket, attachment: SocketAttachment, rawContent: string): Promise<void> {
    const content = rawContent.trim();
    if (!content) {
      this.sendSocketError(ws, "message_empty", "Message cannot be empty");
      return;
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      this.sendSocketError(ws, "message_too_long", `Message is too long (max ${MAX_MESSAGE_LENGTH})`);
      return;
    }

    const chatMessage: AnyChatMessage = {
      id: crypto.randomUUID(),
      roomId: attachment.roomId,
      userId: attachment.userId,
      nickname: attachment.nickname,
      createdAt: Date.now(),
      kind: "text",
      content
    };

    await this.broadcastAndPersist(chatMessage, ws);
  }

  private async handleSendImage(
    ws: WebSocket,
    attachment: SocketAttachment,
    imageKey: string,
    mimeType: ImageMimeType,
    sizeBytes: number
  ): Promise<void> {
    if (typeof imageKey !== "string" || !isRoomScopedImageKey(imageKey, attachment.roomId, attachment.userId)) {
      this.sendSocketError(ws, "invalid_image_key", "Image key is not valid for this room");
      return;
    }

    if (!isImageMimeType(mimeType)) {
      this.sendSocketError(ws, "invalid_image", "Unsupported image MIME type");
      return;
    }

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      this.sendSocketError(ws, "invalid_image", "Invalid image size");
      return;
    }

    if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
      this.sendSocketError(ws, "image_too_large", "Image exceeds size limit");
      return;
    }

    const chatMessage: AnyChatMessage = {
      id: crypto.randomUUID(),
      roomId: attachment.roomId,
      userId: attachment.userId,
      nickname: attachment.nickname,
      createdAt: Date.now(),
      kind: "image",
      imageKey,
      imageMimeType: mimeType,
      imageSizeBytes: sizeBytes,
      imageUrl: buildImageUrl(attachment.mediaBaseUrl, imageKey)
    };

    await this.broadcastAndPersist(chatMessage, ws);
  }

  private async broadcastAndPersist(message: AnyChatMessage, ws: WebSocket): Promise<void> {
    this.broadcast({
      type: "message",
      message
    });

    try {
      await this.persistMessage(message);
    } catch (error) {
      console.error("Failed to persist chat message", error);
      this.sendSocketError(ws, "internal_error", "Message broadcasted but persistence failed");
    }
  }

  private async persistMessage(message: AnyChatMessage): Promise<void> {
    const messageType = message.kind;
    const content = message.kind === "text" ? message.content : "";
    const imageKey = message.kind === "image" ? message.imageKey : null;
    const imageMimeType = message.kind === "image" ? message.imageMimeType : null;
    const imageSizeBytes = message.kind === "image" ? message.imageSizeBytes : null;

    await this.env.CHAT_DB.batch([
      this.env.CHAT_DB.prepare(
        `
          INSERT INTO messages (
            id, room_id, user_id, nickname, message_type, content, image_key, image_mime_type, image_size_bytes, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).bind(
        message.id,
        message.roomId,
        message.userId,
        message.nickname,
        messageType,
        content,
        imageKey,
        imageMimeType,
        imageSizeBytes,
        message.createdAt
      ),
      this.env.CHAT_DB.prepare(
        `
          UPDATE users
          SET last_seen_at = ?
          WHERE user_id = ?
        `
      ).bind(message.createdAt, message.userId)
    ]);
  }

  private broadcast(event: ServerSocketEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private broadcastPresence(): void {
    const onlineCount = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN).length;
    this.broadcast({
      type: "presence",
      onlineCount
    });
  }

  private sendSocketEvent(ws: WebSocket, event: ServerSocketEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private sendSocketError(ws: WebSocket, code: ApiErrorCode, message: string): void {
    this.sendSocketEvent(ws, {
      type: "error",
      code,
      message
    });
  }
}
