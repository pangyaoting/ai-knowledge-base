-- 给 chunks 表添加 embedding 向量列（pgvector 类型，1024 维 = bge-m3 输出维度）
-- 并创建 HNSW 近似最近邻索引（cosine 距离），支撑阶段 3 的向量检索
-- 注意：Prisma 不支持 vector 类型，该列在 schema.prisma 中用 Unsupported("vector(1024)") 占位

ALTER TABLE "chunks" ADD COLUMN "embedding" vector(1024);

-- HNSW 索引：百万级向量检索毫秒级；vector_cosine_ops 表示用余弦相似度
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);
