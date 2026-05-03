CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages (room_id, created_at DESC, id DESC);
