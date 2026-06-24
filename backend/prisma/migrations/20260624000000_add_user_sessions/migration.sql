-- CreateTable: UserSession — one row per browser session, isolated per user
CREATE TABLE "UserSession" (
    "id"                TEXT NOT NULL,
    "tokenId"           INTEGER NOT NULL,
    "pendingBusinesses" JSONB,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- Index for expiry cleanup job
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

-- FK: UserSession.tokenId -> FreshbooksToken.id (cascade delete)
ALTER TABLE "UserSession"
  ADD CONSTRAINT "UserSession_tokenId_fkey"
  FOREIGN KEY ("tokenId") REFERENCES "FreshbooksToken"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
