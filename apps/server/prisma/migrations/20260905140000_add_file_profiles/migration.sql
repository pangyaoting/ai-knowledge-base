-- A 文件档案层：file_profiles 表
-- 每个文档入库时生成一段"档案"（文件名 + 用途摘要 + 符号清单），单独向量化。
-- 检索先档案语义命中（中文问题 → 定位到文件），再在锁定的文件内做内容检索——
-- 解决"整个项目喂进去、问某文件内容找不到"（文件边界在通用检索里被抹掉的问题）。

CREATE TABLE "file_profiles" (
  "id" TEXT PRIMARY KEY,
  "document_id" TEXT NOT NULL UNIQUE REFERENCES "documents"("id") ON DELETE CASCADE,
  "filename" TEXT NOT NULL,
  "profile_text" TEXT NOT NULL,
  "embedding" vector(1024)
);

CREATE INDEX "file_profiles_document_id_idx" ON "file_profiles" ("document_id");
CREATE INDEX "file_profiles_embedding_idx" ON "file_profiles" USING hnsw ("embedding" vector_cosine_ops);
