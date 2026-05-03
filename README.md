# Cloudflare Telegram-like Chat MVP

基于 Cloudflare Pages + Workers + Durable Objects + D1 的单房间聊天应用。

## 架构

- 前端：`Vite + React + TypeScript`（部署到 Pages）
- API 与实时：`Cloudflare Worker`（HTTP API + WebSocket Gateway）
- 会话广播：`Durable Object`（`ChatRoom`）
- 历史消息：`Cloudflare D1`
- 登录：匿名昵称 + HMAC token

## 目录

```text
.
├─ apps/web                 # Pages 前端
├─ workers/chat-api         # Worker + Durable Object
├─ packages/shared          # 前后端共享协议类型
└─ README.md
```

## 快速开始（本地）

1. 安装依赖

```bash
npm install
```

2. 初始化 D1 数据库（本地）

```bash
cd workers/chat-api
npx wrangler d1 create chat-db
npx wrangler d1 execute chat-db --local --file=./migrations/0001_init.sql
```

3. 配置 Worker

- 打开 `workers/chat-api/wrangler.jsonc`
- 替换 `d1_databases[0].database_id`
- 配置允许来源 `ALLOWED_ORIGINS`（开发环境可先用 `http://localhost:5173`）
- 本地开发时复制 `workers/chat-api/.dev.vars.example` 为 `.dev.vars`
- 设置会话密钥：

```bash
npx wrangler secret put SESSION_SECRET
```

4. 启动开发

```bash
# 终端 1
npm run dev:worker

# 终端 2
cd apps/web
cp .env.example .env.local
# 编辑 VITE_CHAT_API_BASE=http://127.0.0.1:8787
npm run dev
```

## GitHub + Cloudflare Pages 上线

1. 创建 GitHub 空仓库并推送代码

```bash
git init
git add .
git commit -m "feat: bootstrap cloudflare chat mvp"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

2. 部署 Worker

```bash
cd workers/chat-api
npx wrangler d1 execute chat-db --remote --file=./migrations/0001_init.sql
npx wrangler deploy
```

3. 在 Cloudflare Pages 绑定 GitHub 仓库

- Framework preset: `None` 或 `Vite`
- Build command: `npm run build --workspace @chat/web`
- Build output directory: `apps/web/dist`
- 环境变量（Preview/Production）：
  - `VITE_CHAT_API_BASE=https://<your-worker-subdomain>.workers.dev`

4. 更新 Worker CORS 白名单

- 将 `ALLOWED_ORIGINS` 设置为你的 Pages 域名（支持逗号分隔多个域名）
- 例如：`https://your-project.pages.dev,https://chat.example.com`

## API 约定（MVP）

- `POST /api/session`
  - 输入：`{ "nickname": "alice" }`
  - 输出：`{ ok: true, data: { userId, nickname, token } }`
- `GET /api/messages?room=global&limit=50&cursor=...`
  - Header：`Authorization: Bearer <token>`
  - 输出：历史消息分页
- `GET /api/messages?room=global&after=<timestamp>`
  - Header：`Authorization: Bearer <token>`
  - 输出：重连后补拉新消息
- `GET /ws?room=global&token=<token>`
  - WebSocket 双向消息通道

## 已实现能力

- 匿名昵称登录
- 单房间实时聊天（WebSocket）
- 历史消息持久化与分页
- 自动重连 + 重连后补拉
- 基础输入校验与限流

## 安全与限制（MVP）

- 仅允许 `ALLOWED_ORIGINS` 中的来源调用 API
- token 为 HMAC 签名，支持 TTL 过期（`SESSION_TTL_SECONDS`）
- 首版仅支持文本消息与单房间 `global`
