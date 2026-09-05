-- P2 父子分块（Parent-Child Chunking）：
-- chunks 增加 parent_id 自关联——子块（小片，带向量）用于检索定位，父块（整节/整表，不带向量）命中后喂模型。
-- parent_id 为空 = 普通块（txt/pdf/code 等无父块结构，检索直接用自身）。
-- FK 不建：父块与子块同属一个文档，删除时按 document_id 级联清理，无孤儿风险。

ALTER TABLE "chunks" ADD COLUMN "parent_id" TEXT;

CREATE INDEX "chunks_parent_id_idx" ON "chunks" ("parent_id");
