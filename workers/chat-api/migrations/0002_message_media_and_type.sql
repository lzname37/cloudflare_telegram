ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN image_key TEXT;
ALTER TABLE messages ADD COLUMN image_mime_type TEXT;
ALTER TABLE messages ADD COLUMN image_size_bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_messages_room_type_time ON messages (room_id, message_type, created_at DESC, id DESC);
