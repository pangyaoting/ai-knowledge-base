-- 会话内滚动摘要（记忆模块 A）：早期对话被挤出窗口后折叠进 summary，随每轮注入
ALTER TABLE "chat_sessions" ADD COLUMN "summary" TEXT,
ADD COLUMN "summary_at" TIMESTAMP(3);
