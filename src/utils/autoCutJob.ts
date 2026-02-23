import cron from "node-cron";
import prisma from "../db/db.js";

// boardCache is exported from app.ts – imported here for live prices
// We use a dynamic import so this file can be loaded before app.ts sets up

let _boardCache: Record<string, { stockPrice: number; stockPriceINR: number }> =
  {};

/**
 * Called from app.ts to give the CRON job access to the live board cache.
 */
export function setBoardCacheRef(
  cache: Record<string, { stockPrice: number; stockPriceINR: number }>,
) {
  _boardCache = cache;
}

/**
 * Also store commodity prices (updated by SSE relay in app.ts).
 * Shape: { GOLD: 161668, SILVER: 265350, ... }
 */
export const commodityPriceCache: Record<string, number> = {};

async function runAutoCut() {
  console.log("[AutoCut] Starting midnight auto-cut job…");

  const openPositions = await prisma.shortPosition.findMany({
    where: { status: "open" },
  });

  if (openPositions.length === 0) {
    console.log("[AutoCut] No open short positions to cut.");
    return;
  }

  console.log(
    `[AutoCut] Found ${openPositions.length} open short position(s). Processing…`,
  );

  for (const pos of openPositions) {
    try {
      let currentPrice: number | null = null;

      if (pos.assetType === "commodity") {
        currentPrice = commodityPriceCache[pos.stockSymbol] ?? null;
      } else {
        // Crypto – check boardCache (in-memory) for the INR price
        const sym = pos.stockSymbol.toUpperCase();
        const entry = _boardCache[sym];
        if (entry) currentPrice = entry.stockPriceINR ?? entry.stockPrice;
      }

      if (currentPrice === null) {
        console.warn(
          `[AutoCut] No price found for ${pos.stockSymbol}, skipping.`,
        );
        continue;
      }

      const exitPrice = currentPrice;
      const profitLoss = (pos.entryPrice - exitPrice) * pos.quantity;
      const returnAmount = pos.totalValue + profitLoss;

      await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: pos.userId } });
        if (!user) throw new Error(`User ${pos.userId} not found`);

        const openingBalance = user.balance;
        const closingBalance = openingBalance + returnAmount;

        await tx.user.update({
          where: { id: pos.userId },
          data: { balance: closingBalance },
        });

        await tx.shortPosition.update({
          where: { id: pos.id },
          data: {
            status: "auto_cut",
            exitPrice,
            profitLoss,
            closedAt: new Date(),
          },
        });

        const txRecord = await tx.transaction.create({
          data: {
            userId: pos.userId,
            openingBalance,
            closingBalance,
            usedBalance: Math.abs(returnAmount),
            type: "Credit",
            status: "completed",
          },
        });

        await tx.order.create({
          data: {
            userId: pos.userId,
            transactionId: txRecord.id,
            stockSymbol: pos.stockSymbol,
            stockName: pos.stockName,
            stockPrice: exitPrice,
            stockQuantity: pos.quantity,
            stockTotal: exitPrice * pos.quantity,
            status: "completed",
            type: "buy",
            orderMode: "short_cover",
            description: `[Auto-Cut] ${pos.quantity} ${pos.stockName} @ ₹${exitPrice.toFixed(2)} | P&L: ₹${profitLoss.toFixed(2)}`,
          },
        });
      });

      console.log(
        `[AutoCut] Closed ${pos.stockSymbol} (${pos.id}) | P&L: ₹${profitLoss.toFixed(2)}`,
      );
    } catch (err) {
      console.error(`[AutoCut] Failed for position ${pos.id}:`, err);
    }
  }

  console.log("[AutoCut] Midnight auto-cut job completed.");
}

/**
 * Starts the midnight auto-cut CRON job (IST = UTC+5:30 → UTC 18:30).
 * Schedule: every day at 18:30 UTC = 00:00 IST
 */
export function startAutoCutJob() {
  // "30 18 * * *" = 18:30 UTC = 00:00 IST
  cron.schedule("30 18 * * *", runAutoCut, {
    timezone: "Asia/Kolkata",
  });
  console.log(
    "[AutoCut] Midnight auto-cut job scheduled (IST 00:00 / Asia/Kolkata).",
  );
}
