import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ALLOWED_IMAGE_ACCEPT,
  API_PATHS,
  GLOBAL_ROOM_ID,
  MAX_IMAGE_SIZE_BYTES,
  MAX_MESSAGE_LENGTH,
  MIN_PASSWORD_LENGTH,
  ROOM_ID_MAX_LENGTH,
  isImageMimeType,
  normalizeAndValidateRoomId,
  type AnyChatMessage,
  type AuthSessionData,
  type ClientSocketEvent,
  type ServerSocketEvent
} from "../../../packages/shared/protocol";
import { ChatApi } from "./lib/chat-api";

type SessionState = AuthSessionData;
type AuthMode = "login" | "register";
type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

const SESSION_STORAGE_KEY = "cf_chat_session_v2";
const ROOM_STORAGE_KEY = "cf_chat_room_v1";
const LEGACY_SESSION_STORAGE_KEY = "cf_chat_session_v1";
const OAUTH_SESSION_QUERY_KEY = "auth_session";
const OAUTH_ERROR_QUERY_KEY = "auth_error";

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

function isValidSessionState(raw: unknown): raw is SessionState {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const value = raw as Record<string, unknown>;
  return (
    typeof value.userId === "string" &&
    typeof value.nickname === "string" &&
    typeof value.email === "string" &&
    typeof value.token === "string"
  );
}

function getStoredSession(): SessionState | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidSessionState(parsed) ? parsed : null;
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

function decodeOAuthSession(raw: string): SessionState | null {
  try {
    const bytes = base64UrlToBytes(raw);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as unknown;
    return isValidSessionState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapOAuthError(errorCode: string): string {
  if (errorCode === "oauth_state_invalid") {
    return "GitHub 登录失败：状态校验未通过，请重试。";
  }
  if (errorCode === "oauth_failed") {
    return "GitHub 登录失败，请稍后重试。";
  }
  return "登录失败，请稍后重试。";
}

export function App() {
  const apiBase = useMemo(
    () => (import.meta.env.VITE_CHAT_API_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/g, ""),
    []
  );
  const chatApi = useMemo(() => new ChatApi(apiBase), [apiBase]);

  const [session, setSession] = useState<SessionState | null>(getStoredSession);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
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
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const lastMessageTimestampRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);

    const url = new URL(window.location.href);
    const oauthSessionRaw = url.searchParams.get(OAUTH_SESSION_QUERY_KEY);
    const oauthErrorRaw = url.searchParams.get(OAUTH_ERROR_QUERY_KEY);

    if (!oauthSessionRaw && !oauthErrorRaw) {
      return;
    }

    if (oauthSessionRaw) {
      const parsedSession = decodeOAuthSession(oauthSessionRaw);
      if (parsedSession) {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(parsedSession));
        setSession(parsedSession);
        setAuthError(null);
        setNotice("已通过 GitHub 登录。");
      } else {
        setAuthError("GitHub 登录响应无效，请重试。");
      }
    }

    if (oauthErrorRaw) {
      setAuthError(mapOAuthError(oauthErrorRaw));
    }

    url.searchParams.delete(OAUTH_SESSION_QUERY_KEY);
    url.searchParams.delete(OAUTH_ERROR_QUERY_KEY);
    window.history.replaceState({}, document.title, url.toString());
  }, []);

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
            setNotice("重连成功，但补拉历史消息失败。");
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

  async function handleEmailAuthSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmittingAuth) {
      return;
    }

    const email = emailInput.trim().toLowerCase();
    const password = passwordInput;

    if (!email) {
      setAuthError("请输入邮箱地址。");
      return;
    }

    if (!password) {
      setAuthError("请输入密码。");
      return;
    }

    if (authMode === "register" && password.length < MIN_PASSWORD_LENGTH) {
      setAuthError(`密码长度至少为 ${MIN_PASSWORD_LENGTH} 位。`);
      return;
    }

    setIsSubmittingAuth(true);
    setAuthError(null);
    setNotice(null);

    try {
      const nextSession =
        authMode === "register"
          ? await chatApi.registerWithEmail({ email, password })
          : await chatApi.loginWithEmail({ email, password });
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
      setPasswordInput("");
      setNotice(authMode === "register" ? "注册并登录成功。" : "登录成功。");
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "登录失败";
      setAuthError(message);
    } finally {
      setIsSubmittingAuth(false);
    }
  }

  function handleGithubAuth(): void {
    window.location.assign(chatApi.getGithubOauthStartUrl());
  }

  function handleSignOut(): void {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSession(null);
    setCurrentRoomId(GLOBAL_ROOM_ID);
    setRoomInput(GLOBAL_ROOM_ID);
    localStorage.setItem(ROOM_STORAGE_KEY, GLOBAL_ROOM_ID);
    setNotice("已退出当前会话。");
  }

  function handleJoinRoom(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeAndValidateRoomId(roomInput);
    if (!normalized) {
      setNotice("房间 ID 仅支持 a-z、0-9、_、-，且长度 1-32。");
      return;
    }

    if (normalized === currentRoomId) {
      setNotice(`当前已在房间 #${normalized}。`);
      return;
    }

    setCurrentRoomId(normalized);
    setRoomInput(normalized);
    setNotice(`已切换到房间 #${normalized}。`);
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

  function sendCurrentDraft(): void {
    const content = draft.trim();
    if (!content) {
      setSendError("消息不能为空。");
      return;
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      setSendError(`消息长度不能超过 ${MAX_MESSAGE_LENGTH}。`);
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

  function handleSendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    sendCurrentDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter") {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      sendCurrentDraft();
    }
  }

  async function handleSelectImage(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    if (!session) {
      setSendError("请先登录。");
      return;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      setSendError(`图片大小不能超过 ${Math.floor(MAX_IMAGE_SIZE_BYTES / (1024 * 1024))}MB。`);
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
        throw new Error("连接已断开，图片上传成功但未发送，请重试。");
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
            <h1>登录后进入聊天室</h1>
            <p>支持邮箱密码或 GitHub OAuth 登录。</p>

            <div className="auth-mode-switch">
              <button
                type="button"
                className={authMode === "login" ? "auth-mode-btn active" : "auth-mode-btn"}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError(null);
                }}
              >
                邮箱登录
              </button>
              <button
                type="button"
                className={authMode === "register" ? "auth-mode-btn active" : "auth-mode-btn"}
                onClick={() => {
                  setAuthMode("register");
                  setAuthError(null);
                }}
              >
                邮箱注册
              </button>
            </div>

            <form onSubmit={(event) => void handleEmailAuthSubmit(event)}>
              <input
                value={emailInput}
                type="email"
                autoComplete="email"
                onChange={(event) => setEmailInput(event.target.value)}
                placeholder="请输入邮箱"
              />
              <input
                value={passwordInput}
                type="password"
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
                onChange={(event) => setPasswordInput(event.target.value)}
                placeholder={
                  authMode === "register" ? `请输入密码（至少 ${MIN_PASSWORD_LENGTH} 位）` : "请输入密码"
                }
              />
              <button type="submit" disabled={isSubmittingAuth}>
                {isSubmittingAuth ? "提交中..." : authMode === "register" ? "注册并登录" : "登录"}
              </button>
            </form>

            <div className="oauth-divider">或</div>
            <button type="button" className="github-btn" onClick={handleGithubAuth}>
              使用 GitHub 登录
            </button>

            {authError ? <p className="auth-error">{authError}</p> : null}
          </section>
        ) : (
          <section className="chat-wrapper">
            <header className="chat-header">
              <div>
                <strong>#{currentRoomId}</strong>
                <p>
                  {session.nickname} ({session.email})
                </p>
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
                onKeyDown={handleComposerKeyDown}
                placeholder={`输入消息（最多 ${MAX_MESSAGE_LENGTH} 字，Ctrl/Cmd+Enter 发送）`}
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
