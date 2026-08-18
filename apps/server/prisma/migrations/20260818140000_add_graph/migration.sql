-- CreateTable 知识图谱（实体 + 关系，入库时 LLM 抽取，多跳问答扩展召回）
CREATE TABLE "graph_entities" (
    "id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT '概念',
    "chunk_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_entities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "graph_relations" (
    "id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "target_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "graph_entities_knowledge_base_id_document_id_name_key" ON "graph_entities"("knowledge_base_id", "document_id", "name");
CREATE INDEX "graph_entities_knowledge_base_id_idx" ON "graph_entities"("knowledge_base_id");
CREATE INDEX "graph_entities_name_idx" ON "graph_entities"("name");
CREATE UNIQUE INDEX "graph_relations_knowledge_base_id_document_id_source_name_rel_key" ON "graph_relations"("knowledge_base_id", "document_id", "source_name", "relation", "target_name");
CREATE INDEX "graph_relations_knowledge_base_id_idx" ON "graph_relations"("knowledge_base_id");

-- AddForeignKey
ALTER TABLE "graph_entities" ADD CONSTRAINT "graph_entities_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_entities" ADD CONSTRAINT "graph_entities_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_relations" ADD CONSTRAINT "graph_relations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
