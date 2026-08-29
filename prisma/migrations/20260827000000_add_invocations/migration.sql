-- CreateTable
CREATE TABLE "invocations" (
    "id" TEXT NOT NULL,
    "function_id" TEXT NOT NULL,
    "version_id" TEXT,
    "request_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cold_start" BOOLEAN NOT NULL DEFAULT true,
    "duration_ms" INTEGER NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invocations_request_id_key" ON "invocations"("request_id");

-- CreateIndex
CREATE INDEX "invocations_function_id_created_at_idx" ON "invocations"("function_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "invocations" ADD CONSTRAINT "invocations_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invocations" ADD CONSTRAINT "invocations_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "function_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
