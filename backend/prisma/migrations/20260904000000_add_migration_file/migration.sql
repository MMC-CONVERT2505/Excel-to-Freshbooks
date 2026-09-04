-- A named container for one client's migration work: created first, connected to a
-- FreshBooks company afterwards, and every run made under it links back via fileId.
-- Lets the dashboard show file-wise history instead of one flat list keyed only by
-- whichever company happened to be connected at the time.

-- CreateTable
CREATE TABLE "MigrationFile" (
    "id"        SERIAL       NOT NULL,
    "userId"    INTEGER      NOT NULL,
    -- Nullable: a file exists before it is connected to a company.
    "tokenId"   INTEGER,
    "name"      TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationFile_pkey" PRIMARY KEY ("id")
);

-- Two users may each have a file called "Acme"; one user may not have two.
-- CreateIndex
CREATE UNIQUE INDEX "MigrationFile_userId_name_key" ON "MigrationFile"("userId", "name");

-- CreateIndex
CREATE INDEX "MigrationFile_userId_idx" ON "MigrationFile"("userId");

-- CreateIndex
CREATE INDEX "MigrationFile_tokenId_idx" ON "MigrationFile"("tokenId");

-- Deleting a user removes their files; revoking a FreshBooks token must NOT
-- destroy the file or its history, so tokenId is set to NULL instead.
-- AddForeignKey
ALTER TABLE "MigrationFile" ADD CONSTRAINT "MigrationFile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationFile" ADD CONSTRAINT "MigrationFile_tokenId_fkey"
    FOREIGN KEY ("tokenId") REFERENCES "FreshbooksToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Link runs to their file. Nullable so every run recorded before files existed
-- stays valid, and so a run started with no active file still saves cleanly.
-- AlterTable
ALTER TABLE "MigrationRun" ADD COLUMN "fileId" INTEGER;

-- CreateIndex
CREATE INDEX "MigrationRun_fileId_idx" ON "MigrationRun"("fileId");

-- Deleting a file must not delete its migration history — the runs survive with
-- fileId set to NULL, matching how tokenId already behaves.
-- AddForeignKey
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "MigrationFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
