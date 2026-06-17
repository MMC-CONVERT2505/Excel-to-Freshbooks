-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" SERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "pushed" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);
