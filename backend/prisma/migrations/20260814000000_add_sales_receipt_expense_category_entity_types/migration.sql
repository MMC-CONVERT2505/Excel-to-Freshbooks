-- Sales receipts and expense categories previously reused the INVOICE and EXPENSE
-- members. MigrationPhase is unique per (runId, entity), so pushing invoices and sales
-- receipts in the same run made the second overwrite the first's phase — and with it the
-- skipped/error records behind that phase's issue report. Same for expenses vs
-- expense categories. Give each its own member.
--
-- PostgreSQL 12+ permits ALTER TYPE ... ADD VALUE inside a transaction as long as the
-- new value is not referenced in that same transaction. Nothing here references them,
-- and IF NOT EXISTS keeps the migration idempotent on re-run.

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'SALES_RECEIPT';

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'EXPENSE_CATEGORY';
