-- CreateTable
CREATE TABLE "FreshbooksToken" (
    "id" SERIAL NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL,
    "expiresIn" INTEGER NOT NULL,
    "createdAt" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreshbooksToken_pkey" PRIMARY KEY ("id")
);
