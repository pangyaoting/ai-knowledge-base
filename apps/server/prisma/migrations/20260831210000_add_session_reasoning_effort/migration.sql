-- 会话推理等级（低≈关闭 / 高 / 最高），透传给 reasoning_effort 参数
ALTER TABLE "chat_sessions" ADD COLUMN "reasoning_effort" TEXT;
