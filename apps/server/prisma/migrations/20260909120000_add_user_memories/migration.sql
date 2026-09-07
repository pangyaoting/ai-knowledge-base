-- 跨会话事实记忆（记忆模块 B）
CREATE TABLE "user_memories" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "source_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_memories_owner_id_idx" ON "user_memories"("owner_id");
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
