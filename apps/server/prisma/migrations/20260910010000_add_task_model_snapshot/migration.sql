-- 报告/自主研究 Agent：创建时的模型快照列（无 FK：配置删除后解析失败 → 快速失败报错，
-- 而非静默回退；与"无默认配置"重构配套）
ALTER TABLE "reports" ADD COLUMN "model_config_id" TEXT;
ALTER TABLE "reports" ADD COLUMN "model" TEXT;

ALTER TABLE "agent_tasks" ADD COLUMN "model_config_id" TEXT;
ALTER TABLE "agent_tasks" ADD COLUMN "model" TEXT;
