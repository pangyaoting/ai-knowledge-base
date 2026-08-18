-- 会话消息全文检索：为 chat_messages.content 建 pg_trgm GIN 索引（加速 ILIKE '%关键词%'）
CREATE INDEX IF NOT EXISTS chat_messages_content_trgm_idx
  ON chat_messages USING GIN (content gin_trgm_ops);
