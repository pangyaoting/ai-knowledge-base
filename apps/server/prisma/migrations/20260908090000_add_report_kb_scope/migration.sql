-- 报告创建时持久化检索范围（scope + knowledgeBaseIds），失败重试可精确回填，不退化成全库
ALTER TABLE "reports" ADD COLUMN "kb_scope" JSONB;
