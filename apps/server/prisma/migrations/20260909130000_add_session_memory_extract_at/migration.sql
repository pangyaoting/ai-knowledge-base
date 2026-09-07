-- 会话级"用户事实抽取游标"（记忆模块 B）
-- 记录该会话上次已抽取到哪条消息（按 createdAt），下次只抽游标之后的新消息，避免每轮重复调用 LLM
ALTER TABLE "chat_sessions" ADD COLUMN "memory_extract_at" TIMESTAMP(3);
