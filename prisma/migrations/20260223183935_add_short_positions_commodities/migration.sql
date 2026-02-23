-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "orderMode" TEXT NOT NULL DEFAULT 'delivery';

-- CreateTable
CREATE TABLE "public"."ShortPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL DEFAULT 'crypto',
    "stockSymbol" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "totalValue" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exitPrice" DOUBLE PRECISION,
    "profitLoss" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShortPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CommodityPortfolio" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommodityPortfolio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShortPosition_userId_idx" ON "public"."ShortPosition"("userId");

-- CreateIndex
CREATE INDEX "ShortPosition_userId_status_idx" ON "public"."ShortPosition"("userId", "status");

-- CreateIndex
CREATE INDEX "ShortPosition_status_idx" ON "public"."ShortPosition"("status");

-- CreateIndex
CREATE INDEX "CommodityPortfolio_userId_idx" ON "public"."CommodityPortfolio"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommodityPortfolio_userId_symbol_key" ON "public"."CommodityPortfolio"("userId", "symbol");

-- AddForeignKey
ALTER TABLE "public"."ShortPosition" ADD CONSTRAINT "ShortPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommodityPortfolio" ADD CONSTRAINT "CommodityPortfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
