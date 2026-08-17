-- 混合检索：pg_trgm 扩展 + chunks.content 三元组 GIN 索引（关键词检索用）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX chunks_content_trgm_idx ON chunks USING GIN (content gin_trgm_ops);