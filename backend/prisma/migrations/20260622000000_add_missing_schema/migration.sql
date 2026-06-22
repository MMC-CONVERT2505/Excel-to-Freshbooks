-- AlterTable: add isCurrent and companyLabel to FreshbooksToken
ALTER TABLE "FreshbooksToken"
  ADD COLUMN "isCurrent"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "companyLabel" TEXT;

-- Index for isCurrent lookups
CREATE INDEX "FreshbooksToken_isCurrent_idx" ON "FreshbooksToken"("isCurrent");

-- AlterTable: add tokenId FK to MigrationRun
ALTER TABLE "MigrationRun"
  ADD COLUMN "tokenId" INTEGER;

-- Index for MigrationRun.tokenId
CREATE INDEX "MigrationRun_tokenId_idx" ON "MigrationRun"("tokenId");

-- FK: MigrationRun.tokenId -> FreshbooksToken.id
ALTER TABLE "MigrationRun"
  ADD CONSTRAINT "MigrationRun_tokenId_fkey"
  FOREIGN KEY ("tokenId") REFERENCES "FreshbooksToken"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Add JOURNAL_ENTRY to EntityType enum
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'JOURNAL_ENTRY';

-- CreateTable: UploadedSheet
CREATE TABLE "UploadedSheet" (
    "id"         SERIAL NOT NULL,
    "tokenId"    INTEGER,
    "entity"     TEXT NOT NULL,
    "filename"   TEXT NOT NULL,
    "rowCount"   INTEGER NOT NULL,
    "rows"       JSONB NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadedSheet_pkey" PRIMARY KEY ("id")
);

-- Indexes for UploadedSheet
CREATE INDEX "UploadedSheet_tokenId_entity_idx" ON "UploadedSheet"("tokenId", "entity");
CREATE INDEX "UploadedSheet_expiresAt_idx" ON "UploadedSheet"("expiresAt");

-- FK: UploadedSheet.tokenId -> FreshbooksToken.id
ALTER TABLE "UploadedSheet"
  ADD CONSTRAINT "UploadedSheet_tokenId_fkey"
  FOREIGN KEY ("tokenId") REFERENCES "FreshbooksToken"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
