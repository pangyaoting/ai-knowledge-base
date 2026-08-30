-- 自主研究任务：新增执行摘要列（先摘要后展开，报告顶部展示，正文小节可折叠）
ALTER TABLE "agent_tasks" ADD COLUMN "summary" TEXT;
