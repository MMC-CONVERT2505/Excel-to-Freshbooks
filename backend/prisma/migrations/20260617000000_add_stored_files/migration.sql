-- CreateEnum
CREATE TYPE "StoredFileType" AS ENUM ('QBD_EXPORT', 'EXCEL_TEMPLATE');

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" SERIAL NOT NULL,
    "filename" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "fileType" "StoredFileType" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_filename_fileType_key" ON "StoredFile"("filename", "fileType");

-- CreateIndex
CREATE INDEX "StoredFile_expiresAt_idx" ON "StoredFile"("expiresAt");
