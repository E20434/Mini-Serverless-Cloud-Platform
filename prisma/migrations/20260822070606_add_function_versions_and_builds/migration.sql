/*
  Warnings:

  - You are about to drop the column `file_path` on the `functions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "functions" DROP COLUMN "file_path";

-- CreateTable
CREATE TABLE "function_versions" (
    "id" TEXT NOT NULL,
    "function_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "image_tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "function_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "builds" (
    "id" TEXT NOT NULL,
    "function_id" TEXT NOT NULL,
    "source_object_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "image_tag" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "builds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "function_versions_function_id_version_number_key" ON "function_versions"("function_id", "version_number");

-- AddForeignKey
ALTER TABLE "function_versions" ADD CONSTRAINT "function_versions_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "builds" ADD CONSTRAINT "builds_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
