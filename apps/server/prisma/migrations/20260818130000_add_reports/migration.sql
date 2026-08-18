-- CreateTable 研究报告（异步生成，前端轮询 status/step）
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "step" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT,
    "sections" JSONB,
    "sources" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_owner_id_idx" ON "reports"("owner_id");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
