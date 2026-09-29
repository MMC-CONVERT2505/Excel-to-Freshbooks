-- Adds ESTIMATE, PROJECT and TIME_ENTRY for the three new migration modules.
-- Same rationale as the earlier SALES_RECEIPT/EXPENSE_CATEGORY migration: each
-- module needs its own EntityType so its MigrationPhase never collides with
-- another module's phase within the same run.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe on PG12+ (this project runs
-- postgres:15) as long as the new value is not referenced in the same
-- transaction, and IF NOT EXISTS keeps this idempotent on re-run.

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'ESTIMATE';

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'PROJECT';

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'TIME_ENTRY';
