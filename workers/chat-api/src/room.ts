import { DurableObject } from "cloudflare:workers";
import {
  MAX_MESSAGE_LENGTH,
  type ApiErrorCode,
  type ChatMessage,
  type ClientSocketEvent,
  type ServerSocketEvent
} from "../../../packages/shared/protocol";
import { SlidingWindowRateLimiter } from "./rate-limit";

type RoomEnv = {
  CHAT_DB: D1Database;
};

type SocketAttachment = {
  roomId: string;
  userId: string;
  nickname: string;
};

const MESSAGE_RATE_LIMIT = 12;
const MESSAGE_RATE_WINDOW_MS = 10_000;

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

    const roomId = url.searchParams.get("room") ?? "global";
    const userId = request.headers.get("x-user-id");
    const nickname = request.headers.get("x-nickname");

    if (!userId || !nickname) {
      return new Response("Unauthorized", { status: 401 });
    }

    const websocketPair = new WebSocketPair();
    const client = websocketPair[0];
    const server = websocketPair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      roomId,
      userId,
      nickname
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
      this.sendSocketError(ws, "unauthorized", "会话已失效");
      ws.close(1008, "Missing session");
      return;
    }

    const payloadText =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    let event: ClientSocketEvent;
    try {
      event = JSON.parse(payloadText) as ClientSocketEvent;
    } catch {
      this.sendSocketError(ws, "bad_request", "消息格式错误");
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

    if (event.type !== "send_message") {
      this.sendSocketError(ws, "bad_request", "不支持的事件类型");
      return;
    }

    const content = event.content.trim();
    if (!content) {
      this.sendSocketError(ws, "message_empty", "消息内容不能为空");
      return;
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      this.sendSocketError(ws, "message_too_long", `消息长度不能超过 ${MAX_MESSAGE_LENGTH} 字符`);
      return;
    }

    const rateLimitKey = `${attachment.roomId}:${attachment.userId}`;
    if (!this.rateLimiter.consume(rateLimitKey, MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS)) {
      this.sendSocketError(ws, "rate_limited", "消息发送过于频繁，请稍后重试");
      return;
    }

    const chatMessage: ChatMessage = {
      id: crypto.randomUUID(),
      roomId: attachment.roomId,
      userId: attachment.userId,
      nickname: attachment.nickname,
      content,
      createdAt: Date.now()
    };

    this.broadcast({
      type: "message",
      message: chatMessage
    });

    try {
      await this.persistMessage(chatMessage);
    } catch (error) {
      console.error("Failed to persist chat message", error);
      this.sendSocketError(ws, "internal_error", "消息已发送，但持久化失败");
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {
    this.broadcastPresence();
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    this.broadcastPresence();
  }

  private async persistMessage(message: ChatMessage): Promise<void> {
    await this.env.CHAT_DB.batch([
      this.env.CHAT_DB.prepare(
        `
          INSERT INTO messages (id, room_id, user_id, nickname, content, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      ).bind(
        message.id,
        message.roomId,
        message.userId,
        message.nickname,
        message.content,
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
