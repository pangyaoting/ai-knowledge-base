-- 重构：删除"默认配置/默认模型"概念（用户处处显式选择模型，无隐式默认）
ALTER TABLE "model_configs" DROP COLUMN IF EXISTS "is_default";
