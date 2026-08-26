-- CreateTable
CREATE TABLE "functions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "memory_mb" INTEGER NOT NULL DEFAULT 128,
    "timeout_ms" INTEGER NOT NULL DEFAULT 3000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "functions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "functions_name_key" ON "functions"("name");
