-- CreateTable 用户模型配置（BYO 大模型 API：key 加密存储，token 用户买单）
CREATE TABLE "model_configs" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
    "api_key" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_configs_owner_id_idx" ON "model_configs"("owner_id");

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 会话可选绑定模型配置
ALTER TABLE "chat_sessions" ADD COLUMN "model_config_id" TEXT;
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_model_config_id_fkey" FOREIGN KEY ("model_config_id") REFERENCES "model_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
