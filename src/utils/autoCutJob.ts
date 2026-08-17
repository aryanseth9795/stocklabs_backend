import cron from "node-cron";
import prisma from "../db/db.js";
import { getLivePriceINR, type AssetType } from "../utils/priceCache.js";

// Prices come from src/utils/priceCache.ts, which owns both the crypto board and
// the commodity cache. That module exists so app.ts and the controllers can
// share one price source without an import cycle — it replaces the
// setBoardCacheRef() back-reference this file used to need.

/**
 * The scheduled task, so shutdown can stop it. It used to be discarded, which
 * was fine when nothing ever shut down cleanly.
 */
let task: cron.ScheduledTask | null = null;

/**
 * The current run, if one is in flight.
 *
 * Stopping the scheduler does not abort a run already underway, and this loop
 * moves money one $transaction at a time — disconnecting Prisma mid-loop would
 * abort a short cover partway through. The window is one minute a day, but the
 * cost of landing in it is a user credited or not credited for a position.
 */
let inFlight: Promise<void> | null = null;

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
      const currentPrice = getLivePriceINR(
        pos.stockSymbol,
        pos.assetType as AssetType,
      );

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
        // Claim the position first, conditionally. Without this, a user
        // covering manually at the same moment this job runs is credited twice
        // for one position (S-06). If the row is no longer open, someone else
        // got there first and we must not touch the balance.
        const claimed = await tx.shortPosition.updateMany({
          where: { id: pos.id, status: "open" },
          data: {
            status: "auto_cut",
            exitPrice,
            profitLoss,
            closedAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          console.log(
            `[AutoCut] Position ${pos.id} was already closed, skipping.`,
          );
          return;
        }

        const user = await tx.user.findUnique({ where: { id: pos.userId } });
        if (!user) throw new Error(`User ${pos.userId} not found`);

        const openingBalance = user.balance;
        const closingBalance = openingBalance + returnAmount;

        await tx.user.update({
          where: { id: pos.userId },
          data: { balance: closingBalance },
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
  // Midnight expressed directly in the target timezone — node-cron does the
  // conversion. The old expression was "30 18 * * *", correct for UTC, but it
  // was ALSO passed timezone: "Asia/Kolkata", so it fired at 18:30 IST and
  // force-closed every open short in the middle of the trading day (S-07).
  task = cron.schedule(
    "0 0 * * *",
    () => {
      inFlight = runAutoCut().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    { timezone: "Asia/Kolkata" },
  );
  console.log(
    "[AutoCut] Midnight auto-cut job scheduled (IST 00:00 / Asia/Kolkata).",
  );
}

/**
 * Stop scheduling, then wait for any run already in progress to finish so that
 * shutdown never tears down Prisma mid-transaction.
 */
export async function stopAutoCutJob(): Promise<void> {
  if (task) {
    await task.stop();
    task = null;
  }
  if (inFlight) {
    console.log("[AutoCut] Waiting for in-flight run to finish…");
    await inFlight.catch(() => {});
  }
}

/** Whether the cron is currently scheduled — surfaced on /readyz. */
export function autoCutScheduled(): boolean {
  return task !== null;
}
