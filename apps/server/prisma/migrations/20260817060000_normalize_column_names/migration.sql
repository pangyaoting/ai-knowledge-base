-- 列名规范化：camelCase → snake_case（统一 PostgreSQL 惯例）
-- 手动编写：Prisma 自动迁移会把"重命名"误判为"删列+加列"（非空列有数据时无法执行），
-- 用 RENAME COLUMN 原地改名，保留已有数据。

ALTER TABLE "chunks" RENAME COLUMN "documentId" TO "document_id";
ALTER TABLE "chunks" RENAME COLUMN "chunkIndex" TO "chunk_index";

ALTER TABLE "documents" RENAME COLUMN "knowledgeBaseId" TO "knowledge_base_id";
ALTER TABLE "documents" RENAME COLUMN "fileSize" TO "file_size";
ALTER TABLE "documents" RENAME COLUMN "fileType" TO "file_type";

ALTER TABLE "knowledge_bases" RENAME COLUMN "ownerId" TO "owner_id";

-- 索引名 / 外键约束名同步规范化（保证新装数据库与现有库结构完全一致）
ALTER INDEX "chunks_documentId_idx" RENAME TO "chunks_document_id_idx";
ALTER INDEX "documents_knowledgeBaseId_idx" RENAME TO "documents_knowledge_base_id_idx";
ALTER INDEX "knowledge_bases_ownerId_idx" RENAME TO "knowledge_bases_owner_id_idx";

ALTER TABLE "chunks" RENAME CONSTRAINT "chunks_documentId_fkey" TO "chunks_document_id_fkey";
ALTER TABLE "documents" RENAME CONSTRAINT "documents_knowledgeBaseId_fkey" TO "documents_knowledge_base_id_fkey";
ALTER TABLE "knowledge_bases" RENAME CONSTRAINT "knowledge_bases_ownerId_fkey" TO "knowledge_bases_owner_id_fkey";
