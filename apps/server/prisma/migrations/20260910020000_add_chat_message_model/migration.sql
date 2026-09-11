-- 数据看板：回答消息记录实际使用的模型名（按模型归因 token）
-- 加列前的历史消息为 NULL → 看板直接不计入（不做"未记录"桶、不猜测）
ALTER TABLE "chat_messages" ADD COLUMN "model" TEXT;
CREATE INDEX "chat_messages_model_idx" ON "chat_messages"("model");
