import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ALLOWED_IMAGE_ACCEPT,
  API_PATHS,
  GLOBAL_ROOM_ID,
  MAX_IMAGE_SIZE_BYTES,
  MAX_MESSAGE_LENGTH,
  MAX_NICKNAME_LENGTH,
  ROOM_ID_MAX_LENGTH,
  isImageMimeType,
  normalizeAndValidateRoomId,
  type AnyChatMessage,
  type ClientSocketEvent,
  type ServerSocketEvent
} from "../../../packages/shared/protocol";
import { ChatApi } from "./lib/chat-api";

type SessionState = {
  userId: string;
  nickname: string;
  token: string;
};

type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

const SESSION_STORAGE_KEY = "cf_chat_session_v1";
const ROOM_STORAGE_KEY = "cf_chat_room_v1";

function toWsUrl(apiBase: string, token: string, roomId: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = API_PATHS.websocket;
  url.searchParams.set("room", roomId);
  url.searchParams.set("token", token);
  return url.toString();
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

function mergeAndSortMessages(prev: AnyChatMessage[], incoming: AnyChatMessage[]): AnyChatMessage[] {
  const map = new Map(prev.map((item) => [item.id, item]));
  for (const item of incoming) {
    map.set(item.id, item);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id.localeCompare(b.id);
  });
}

function getStoredSession(): SessionState | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed.userId || !parsed.nickname || !parsed.token) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getStoredRoomId(): string {
  const raw = localStorage.getItem(ROOM_STORAGE_KEY);
  const roomId = normalizeAndValidateRoomId(raw);
  return roomId ?? GLOBAL_ROOM_ID;
}

function normalizeIncomingMessage(raw: unknown): AnyChatMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.roomId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.nickname !== "string" ||
    typeof value.createdAt !== "number"
  ) {
    return null;
  }

  if (
    value.kind === "image" &&
    typeof value.imageKey === "string" &&
    typeof value.imageUrl === "string" &&
    typeof value.imageMimeType === "string" &&
    isImageMimeType(value.imageMimeType) &&
    typeof value.imageSizeBytes === "number"
  ) {
    return {
      id: value.id,
      roomId: value.roomId,
      userId: value.userId,
      nickname: value.nickname,
      createdAt: value.createdAt,
      kind: "image",
      imageKey: value.imageKey,
      imageUrl: value.imageUrl,
      imageMimeType: value.imageMimeType,
      imageSizeBytes: value.imageSizeBytes
    };
  }

  if (typeof value.content === "string") {
    return {
      id: value.id,
      roomId: value.roomId,
      userId: value.userId,
      nickname: value.nickname,
      createdAt: value.createdAt,
      kind: "text",
      content: value.content
    };
  }

  return null;
}

function normalizeIncomingMessageList(raw: unknown): AnyChatMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const items: AnyChatMessage[] = [];
  for (const entry of raw) {
    const normalized = normalizeIncomingMessage(entry);
    if (normalized) {
      items.push(normalized);
    }
  }
  return items;
}

export function App() {
  const apiBase = useMemo(
    () => (import.meta.env.VITE_CHAT_API_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/g, ""),
    []
  );
  const chatApi = useMemo(() => new ChatApi(apiBase), [apiBase]);

  const [session, setSession] = useState<SessionState | null>(getStoredSession);
  const [nicknameInput, setNicknameInput] = useState("");
  const [currentRoomId, setCurrentRoomId] = useState<string>(getStoredRoomId);
  const [roomInput, setRoomInput] = useState<string>(getStoredRoomId);
  const [messages, setMessages] = useState<AnyChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [onlineCount, setOnlineCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const lastMessageTimestampRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (messages.length === 0) {
      lastMessageTimestampRef.current = 0;
      return;
    }

    const latestTimestamp = messages[messages.length - 1]?.createdAt ?? 0;
    lastMessageTimestampRef.current = latestTimestamp;
  }, [messages]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close(1000, "App unmounted");
    };
  }, []);

  useEffect(() => {
    if (!session) {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setMessages([]);
      setNextCursor(null);
      setConnectionState("idle");
      setOnlineCount(0);
      wsRef.current?.close(1000, "Signed out");
      return;
    }

    let disposed = false;
    shouldReconnectRef.current = true;
    reconnectAttemptRef.current = 0;
    setMessages([]);
    setNextCursor(null);
    setOnlineCount(0);
    setSendError(null);

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const closeSocket = (code: number, reason: string): void => {
      const socket = wsRef.current;
      if (!socket) {
        return;
      }

      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close(code, reason);
      wsRef.current = null;
    };

    const syncMissingMessages = async (): Promise<void> => {
      if (lastMessageTimestampRef.current <= 0) {
        return;
      }

      const response = await chatApi.getMessagesAfter(session.token, currentRoomId, lastMessageTimestampRef.current);
      if (disposed || response.items.length === 0) {
        return;
      }

      const incoming = normalizeIncomingMessageList(response.items);
      setMessages((prev) => mergeAndSortMessages(prev, incoming));
    };

    const openSocket = (isReconnect: boolean): void => {
      clearReconnectTimer();
      closeSocket(1000, "Open a new socket");
      if (disposed || !shouldReconnectRef.current) {
        return;
      }

      setConnectionState(isReconnect ? "reconnecting" : "connecting");
      const socket = new WebSocket(toWsUrl(apiBase, session.token, currentRoomId));
      wsRef.current = socket;

      socket.onopen = async () => {
        if (disposed) {
          socket.close(1000, "Disposed");
          return;
        }

        reconnectAttemptRef.current = 0;
        setConnectionState("connected");
        setSendError(null);
        setNotice(null);

        if (isReconnect) {
          try {
            await syncMissingMessages();
          } catch (error) {
            console.error(error);
            setNotice("重连成功，但补拉历史消息失败");
          }
        }
      };

      socket.onmessage = (event) => {
        let payload: ServerSocketEvent;
        try {
          payload = JSON.parse(String(event.data)) as ServerSocketEvent;
        } catch {
          return;
        }

        if (payload.type === "message") {
          const normalized = normalizeIncomingMessage(payload.message);
          if (normalized) {
            setMessages((prev) => mergeAndSortMessages(prev, [normalized]));
          }
          return;
        }

        if (payload.type === "presence") {
          setOnlineCount(payload.onlineCount);
          return;
        }

        if (payload.type === "error") {
          setSendError(payload.message);
        }
      };

      socket.onerror = () => {
        setConnectionState("disconnected");
      };

      socket.onclose = () => {
        if (disposed || !shouldReconnectRef.current) {
          return;
        }

        setConnectionState("reconnecting");
        reconnectAttemptRef.current += 1;
        const backoff = Math.min(10000, 1000 * Math.pow(2, reconnectAttemptRef.current - 1));
        reconnectTimerRef.current = setTimeout(() => {
          openSocket(true);
        }, backoff);
      };
    };

    const bootstrap = async (): Promise<void> => {
      setIsBootstrapping(true);
      setNotice(null);
      try {
        const history = await chatApi.getMessages(session.token, currentRoomId, { limit: 50 });
        if (disposed) {
          return;
        }

        const items = normalizeIncomingMessageList(history.items);
        setMessages(items);
        setNextCursor(history.nextCursor);
        openSocket(false);
      } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : "初始化失败";
        setNotice(message);
      } finally {
        if (!disposed) {
          setIsBootstrapping(false);
        }
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      closeSocket(1000, "Session or room changed");
    };
  }, [apiBase, chatApi, currentRoomId, session]);

  async function handleSignIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nickname = nicknameInput.trim();
    if (!nickname || nickname.length > MAX_NICKNAME_LENGTH) {
      setNotice(`昵称不能为空且长度不能超过 ${MAX_NICKNAME_LENGTH}`);
      return;
    }

    try {
      const created = await chatApi.createSession(nickname);
      const nextSession: SessionState = {
        userId: created.userId,
        nickname: created.nickname,
        token: created.token
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
      setNicknameInput("");
      setNotice(null);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "创建会话失败";
      setNotice(message);
    }
  }

  function handleSignOut(): void {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSession(null);
    setCurrentRoomId(GLOBAL_ROOM_ID);
    setRoomInput(GLOBAL_ROOM_ID);
    localStorage.setItem(ROOM_STORAGE_KEY, GLOBAL_ROOM_ID);
    setNotice("已退出当前会话");
  }

  function handleJoinRoom(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeAndValidateRoomId(roomInput);
    if (!normalized) {
      setNotice("房间 ID 仅支持 a-z、0-9、_、- 且长度 1-32");
      return;
    }

    if (normalized === currentRoomId) {
      setNotice(`当前已在房间 #${normalized}`);
      return;
    }

    setCurrentRoomId(normalized);
    setRoomInput(normalized);
    setNotice(`已切换到房间 #${normalized}`);
    setSendError(null);
    localStorage.setItem(ROOM_STORAGE_KEY, normalized);
  }

  async function handleLoadMore(): Promise<void> {
    if (!session || !nextCursor || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    try {
      const data = await chatApi.getMessages(session.token, currentRoomId, {
        cursor: nextCursor,
        limit: 50
      });
      const items = normalizeIncomingMessageList(data.items);
      setMessages((prev) => mergeAndSortMessages(prev, items));
      setNextCursor(data.nextCursor);
    } catch (error) {
      console.error(error);
      setNotice(error instanceof Error ? error.message : "加载历史消息失败");
    } finally {
      setIsLoadingMore(false);
    }
  }

  function handleSendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content) {
      setSendError("消息不能为空");
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      setSendError(`消息长度不能超过 ${MAX_MESSAGE_LENGTH}`);
      return;
    }

    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSendError("连接未建立，无法发送。请稍后重试。");
      return;
    }

    const payload: ClientSocketEvent = {
      type: "send_text",
      content
    };
    socket.send(JSON.stringify(payload));
    setDraft("");
    setSendError(null);
  }

  async function handleSelectImage(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    if (!session) {
      setSendError("请先登录");
      return;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      setSendError(`图片大小不能超过 ${Math.floor(MAX_IMAGE_SIZE_BYTES / (1024 * 1024))}MB`);
      return;
    }

    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSendError("连接未建立，无法发送图片。");
      return;
    }

    setIsUploadingImage(true);
    setSendError(null);

    try {
      const uploaded = await chatApi.uploadImage(session.token, currentRoomId, file);
      const liveSocket = wsRef.current;
      if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) {
        throw new Error("连接已断开，图片上传成功但未发送，请重试");
      }

      const payload: ClientSocketEvent = {
        type: "send_image",
        imageKey: uploaded.imageKey,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes
      };
      liveSocket.send(JSON.stringify(payload));
    } catch (error) {
      console.error(error);
      setSendError(error instanceof Error ? error.message : "发送图片失败");
    } finally {
      setIsUploadingImage(false);
    }
  }

  function triggerImagePicker(): void {
    imageInputRef.current?.click();
  }

  return (
    <div className="page-shell">
      <aside className="sidebar">
        <div className="brand">Cloudflare Chat</div>
        <p className="sidebar-meta">Multi Room + Image / MVP</p>
        <div className="status-chip">
          <span className={`status-dot status-${connectionState}`} />
          <span>{connectionState}</span>
        </div>
        <div className="status-chip">
          <span className="status-dot status-online" />
          <span>在线人数 {onlineCount}</span>
        </div>
        <form className="room-form" onSubmit={handleJoinRoom}>
          <label htmlFor="room-id-input">房间 ID</label>
          <div className="room-form-row">
            <input
              id="room-id-input"
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value)}
              placeholder="例如: general"
              maxLength={ROOM_ID_MAX_LENGTH}
              autoComplete="off"
            />
            <button type="submit">加入</button>
          </div>
          <small>规则: a-z 0-9 _ - (1-32)</small>
        </form>
        <div className="sidebar-footer">
          <small>API: {apiBase}</small>
        </div>
      </aside>

      <main className="chat-panel">
        {!session ? (
          <section className="signin-card">
            <h1>进入聊天室</h1>
            <p>输入昵称后开始聊天（匿名模式）。</p>
            <form onSubmit={(event) => void handleSignIn(event)}>
              <input
                value={nicknameInput}
                onChange={(event) => setNicknameInput(event.target.value)}
                placeholder="请输入昵称"
                maxLength={MAX_NICKNAME_LENGTH}
              />
              <button type="submit">创建会话</button>
            </form>
          </section>
        ) : (
          <section className="chat-wrapper">
            <header className="chat-header">
              <div>
                <strong>#{currentRoomId}</strong>
                <p>{session.nickname}</p>
              </div>
              <button className="ghost-btn" onClick={handleSignOut} type="button">
                退出
              </button>
            </header>

            <div className="messages" ref={messageListRef}>
              {nextCursor ? (
                <button
                  className="load-more"
                  type="button"
                  disabled={isLoadingMore}
                  onClick={() => void handleLoadMore()}
                >
                  {isLoadingMore ? "加载中..." : "加载更早消息"}
                </button>
              ) : null}
              {isBootstrapping ? <p className="hint">正在加载历史消息...</p> : null}
              {messages.map((message) => {
                const mine = message.userId === session.userId;
                return (
                  <article key={message.id} className={`bubble ${mine ? "mine" : ""}`}>
                    <header>
                      <strong>{message.nickname}</strong>
                      <time>{formatClock(message.createdAt)}</time>
                    </header>
                    {message.kind === "image" ? (
                      <figure className="image-content">
                        <img src={message.imageUrl} alt="chat image" loading="lazy" />
                        <figcaption>
                          {message.imageMimeType} / {formatBytes(message.imageSizeBytes)}
                        </figcaption>
                      </figure>
                    ) : (
                      <p>{message.content}</p>
                    )}
                  </article>
                );
              })}
              {!isBootstrapping && messages.length === 0 ? <p className="hint">还没有消息，发送第一条吧。</p> : null}
            </div>

            <form className="composer" onSubmit={handleSendMessage}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`输入消息（最多 ${MAX_MESSAGE_LENGTH} 字）`}
                maxLength={MAX_MESSAGE_LENGTH}
              />
              <div className="composer-actions">
                <button className="secondary-btn" type="button" onClick={triggerImagePicker} disabled={isUploadingImage}>
                  {isUploadingImage ? "上传中..." : "发图"}
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept={ALLOWED_IMAGE_ACCEPT}
                  className="hidden-input"
                  onChange={(event) => void handleSelectImage(event)}
                />
                <button type="submit">发送</button>
              </div>
            </form>
          </section>
        )}

        {sendError ? <p className="toast toast-error">{sendError}</p> : null}
        {notice ? <p className="toast">{notice}</p> : null}
      </main>
    </div>
  );
}
