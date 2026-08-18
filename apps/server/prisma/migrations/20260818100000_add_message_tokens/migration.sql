-- 数据看板：消息表记录流式请求的 Token 用量（stream_options.include_usage）
ALTER TABLE "chat_messages" ADD COLUMN "prompt_tokens" INTEGER;
ALTER TABLE "chat_messages" ADD COLUMN "completion_tokens" INTEGER;