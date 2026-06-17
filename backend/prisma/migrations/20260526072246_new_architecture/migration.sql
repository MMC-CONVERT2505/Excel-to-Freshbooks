/*
  Warnings:

  - You are about to drop the column `expiresIn` on the `FreshbooksToken` table. All the data in the column will be lost.
  - The `createdAt` column on the `FreshbooksToken` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `durationMs` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `entity` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `errors` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `failed` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `pushed` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `ranAt` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `skipped` on the `MigrationRun` table. All the data in the column will be lost.
  - You are about to drop the column `total` on the `MigrationRun` table. All the data in the column will be lost.
  - Added the required column `expiresAt` to the `FreshbooksToken` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `MigrationRun` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('CHART_OF_ACCOUNTS', 'CLIENT', 'VENDOR', 'ITEM', 'SERVICE', 'INVOICE', 'EXPENSE', 'INCOME', 'CREDIT_NOTE', 'BILL', 'BILL_PAYMENT', 'INVOICE_PAYMENT');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PhaseStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ErrorCategory" AS ENUM ('VALIDATION', 'AUTHENTICATION', 'AUTHORIZATION', 'RATE_LIMIT', 'NETWORK', 'DUPLICATE', 'BUSINESS_RULE', 'SERVER_ERROR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TokenRefreshStatus" AS ENUM ('SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "FreshbooksToken" DROP COLUMN "expiresIn",
ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "tokenType" SET DEFAULT 'Bearer',
DROP COLUMN "createdAt",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "MigrationRun" DROP COLUMN "durationMs",
DROP COLUMN "entity",
DROP COLUMN "errors",
DROP COLUMN "failed",
DROP COLUMN "pushed",
DROP COLUMN "ranAt",
DROP COLUMN "skipped",
DROP COLUMN "total",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "label" TEXT,
ADD COLUMN     "parentRunId" INTEGER,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "triggeredBy" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "TokenRefreshLog" (
    "id" SERIAL NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "status" "TokenRefreshStatus" NOT NULL,
    "errorMessage" TEXT,
    "oldExpiresAt" TIMESTAMP(3),
    "newExpiresAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenRefreshLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationPhase" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "entity" "EntityType" NOT NULL,
    "status" "PhaseStatus" NOT NULL DEFAULT 'PENDING',
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "sourceFile" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationPhase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRecord" (
    "id" SERIAL NOT NULL,
    "phaseId" INTEGER NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "naturalKey" TEXT,
    "sourcePayload" JSONB NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationError" (
    "id" SERIAL NOT NULL,
    "recordId" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "category" "ErrorCategory" NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "field" TEXT,
    "message" TEXT NOT NULL,
    "rawResponse" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenRefreshLog_tokenId_attemptedAt_idx" ON "TokenRefreshLog"("tokenId", "attemptedAt");

-- CreateIndex
CREATE INDEX "MigrationPhase_status_idx" ON "MigrationPhase"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationPhase_runId_entity_key" ON "MigrationPhase"("runId", "entity");

-- CreateIndex
CREATE INDEX "MigrationRecord_phaseId_status_idx" ON "MigrationRecord"("phaseId", "status");

-- CreateIndex
CREATE INDEX "MigrationRecord_status_nextRetryAt_idx" ON "MigrationRecord"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "MigrationRecord_naturalKey_idx" ON "MigrationRecord"("naturalKey");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRecord_phaseId_sourceRow_key" ON "MigrationRecord"("phaseId", "sourceRow");

-- CreateIndex
CREATE INDEX "MigrationError_recordId_attempt_idx" ON "MigrationError"("recordId", "attempt");

-- CreateIndex
CREATE INDEX "MigrationError_category_occurredAt_idx" ON "MigrationError"("category", "occurredAt");

-- CreateIndex
CREATE INDEX "FreshbooksToken_isActive_expiresAt_idx" ON "FreshbooksToken"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "MigrationRun_status_heartbeatAt_idx" ON "MigrationRun"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "MigrationRun_createdAt_idx" ON "MigrationRun"("createdAt");

-- AddForeignKey
ALTER TABLE "TokenRefreshLog" ADD CONSTRAINT "TokenRefreshLog_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "FreshbooksToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "MigrationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationPhase" ADD CONSTRAINT "MigrationPhase_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MigrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRecord" ADD CONSTRAINT "MigrationRecord_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "MigrationPhase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationError" ADD CONSTRAINT "MigrationError_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "MigrationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
