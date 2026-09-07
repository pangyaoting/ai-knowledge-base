-- 会话记忆开关（记忆管理）：false = 停用本会话的摘要折叠与注入
ALTER TABLE "chat_sessions" ADD COLUMN "memory_enabled" BOOLEAN NOT NULL DEFAULT true;
