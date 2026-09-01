-- AlterTable
ALTER TABLE "model_configs" ADD COLUMN "models" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "model_configs" SET "models" = ARRAY["model"] WHERE "models" = ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "model" TEXT;
