-- 多图消息：存 JSON 数组字符串（用户消息可同时上传/粘贴多张图片）
ALTER TABLE "chat_messages" ADD COLUMN "image_data_urls" TEXT;
