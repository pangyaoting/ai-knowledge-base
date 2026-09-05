-- 索引版本号：记录每个文档上次按哪一版处理规则入库。
-- 处理逻辑升级（分块/符号/档案/向量化规则变化）时 bump 代码里的 INDEX_VERSION，
-- 旧文档（index_version < 当前版本）在下次访问知识库时自动后台重算，用户无感。

ALTER TABLE "documents" ADD COLUMN "index_version" INTEGER NOT NULL DEFAULT 1;
