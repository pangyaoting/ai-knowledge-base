-- 会话增加"是否使用知识库"开关
-- false = 纯对话模式（不检索知识库，仅普通 LLM 对话）；true 且无绑定 = 检索全部知识库
ALTER TABLE "chat_sessions" ADD COLUMN "use_knowledge_base" BOOLEAN NOT NULL DEFAULT true;
