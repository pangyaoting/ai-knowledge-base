-- 增量向量化：文档内容哈希（SHA-256），上传时同名同哈希直接跳过，不重复解析/嵌入
ALTER TABLE "documents" ADD COLUMN "content_hash" TEXT;
