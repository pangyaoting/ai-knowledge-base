-- 会话支持绑定多个知识库（多对多）：新建关联表 + 回填旧数据 + 删除旧的单库列
-- CreateTable
CREATE TABLE "session_knowledge_bases" (
    "session_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    CONSTRAINT "session_knowledge_bases_pkey" PRIMARY KEY ("session_id","knowledge_base_id")
);

-- CreateIndex
CREATE INDEX "session_knowledge_bases_knowledge_base_id_idx" ON "session_knowledge_bases"("knowledge_base_id");

-- AddForeignKey
ALTER TABLE "session_knowledge_bases" ADD CONSTRAINT "session_knowledge_bases_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_knowledge_bases" ADD CONSTRAINT "session_knowledge_bases_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 回填：把旧版单库绑定迁到关联表（先迁数据再删列，不丢历史绑定）
INSERT INTO "session_knowledge_bases" ("session_id", "knowledge_base_id")
SELECT "id", "knowledge_base_id" FROM "chat_sessions" WHERE "knowledge_base_id" IS NOT NULL;

-- DropColumn（CASCADE 同时删掉旧外键约束）
ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "knowledge_base_id" CASCADE;