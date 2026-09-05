-- C 代码符号级索引：code_symbols 表
-- 每个代码文件入库时用 TS Compiler API 解析出符号（函数/类/接口/组件 + 行号 + 实现代码 body），
-- 检索时问题命中符号名 → 直接返回该符号的实现源码（符号级精确命中，不靠文本相似度碰运气）。

CREATE TABLE "code_symbols" (
  "id" TEXT PRIMARY KEY,
  "document_id" TEXT NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "filename" TEXT NOT NULL,
  "symbol_name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "signature" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL DEFAULT '',
  "start_line" INTEGER NOT NULL,
  "end_line" INTEGER NOT NULL
);

CREATE INDEX "code_symbols_document_id_idx" ON "code_symbols" ("document_id");
CREATE INDEX "code_symbols_symbol_name_idx" ON "code_symbols" ("symbol_name");
