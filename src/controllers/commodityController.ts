import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import { Prisma } from "@prisma/client";
import { getLivePriceINR } from "../utils/priceCache.js";
import { validateQuantity, validateEnum } from "../utils/validate.js";
import { addSubscriber } from "../utils/commodityFeed.js";
import { COMMODITY_NAMES } from "../constants/Commodities.js";

// ─── SSE Relay ────────────────────────────────────────────────────────────────
/**
 * GET /commodity/stream
 *
 * Fans out the server's single upstream price feed to this client.
 *
 * This used to open its own upstream connection per request, which meant N
 * clients produced N connections to the third-party service — and, more
 * seriously, that the server only knew commodity prices while somebody happened
 * to be watching. The feed now runs from boot in src/utils/commodityFeed.ts and
 * this handler just subscribes to it (review A-01).
 */
export const streamCommodityPrices = (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  const unsubscribe = addSubscriber(res);

  // Keepalive so intermediaries don't drop an idle connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      cleanup();
    }
  }, 20_000);

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    unsubscribe();
  }

  req.on("close", cleanup);
  res.on("close", cleanup);
};

// ─── Execute Commodity Order ──────────────────────────────────────────────────
export const executeCommodityOrder = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );

    // `type` is validated against an allow-list. The control flow below ends in
    // an `else` that executes a SELL, so any unrecognised value — "SELL", a
    // typo, anything crafted — used to silently sell the user's holding (S-12).
    const type = validateEnum(
      req.body.type,
      ["buy", "sell", "short_sell"] as const,
      "type",
    );
    const symbol = validateEnum(
      req.body.symbol,
      Object.keys(COMMODITY_NAMES) as (keyof typeof COMMODITY_NAMES)[],
      "symbol",
    );
    const quantity = validateQuantity(req.body.quantity);

    // Server-authoritative price (S-02).
    const rate = getLivePriceINR(symbol, "commodity");
    if (rate === null)
      return next(
        new ErrorHandler(
          `No live price available for ${symbol}. Please try again shortly.`,
          503,
        ),
      );

    const name = COMMODITY_NAMES[symbol] ?? symbol;
    const cost = quantity * rate;

    if (type === "short_sell") {
      const result = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.findUnique({ where: { id: userId } });
          if (!user) throw new ErrorHandler("User not found", 404);
          if (user.balance < cost)
            throw new ErrorHandler(
              `Insufficient balance. Required margin: ₹${cost.toFixed(2)}`,
              400,
            );

          const openingBalance = user.balance;
          const closingBalance = openingBalance - cost;

          await tx.user.update({
            where: { id: userId },
            data: { balance: closingBalance },
          });

          const shortPosition = await tx.shortPosition.create({
            data: {
              userId,
              assetType: "commodity",
              stockSymbol: symbol,
              stockName: name,
              entryPrice: rate,
              quantity,
              totalValue: cost,
              status: "open",
            },
          });

          const transaction = await tx.transaction.create({
            data: {
              userId,
              openingBalance,
              closingBalance,
              usedBalance: cost,
              type: "Debit",
              status: "completed",
            },
          });

          await tx.order.create({
            data: {
              userId,
              transactionId: transaction.id,
              stockSymbol: symbol,
              stockName: name,
              stockPrice: rate,
              stockQuantity: quantity,
              stockTotal: cost,
              status: "completed",
              type: "sell",
              orderMode: "short_sell",
              description: `[Commodity] Short Sell: ${quantity} ${name} @ ₹${rate.toFixed(2)}`,
            },
          });

          return shortPosition;
        },
      );

      return res.status(200).json({
        success: true,
        message: "Commodity short position opened successfully",
        shortPosition: result,
        executedPrice: rate,
      });
    }

    // Delivery buy / sell
    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new ErrorHandler("User not found", 404);

        const openingBalance = user.balance;

        if (type === "buy") {
          if (user.balance < cost)
            throw new ErrorHandler(
              `Insufficient balance. Required: ₹${cost.toFixed(2)}`,
              400,
            );

          const closingBalance = openingBalance - cost;
          await tx.user.update({
            where: { id: userId },
            data: { balance: closingBalance },
          });

          const existing = await tx.commodityPortfolio.findUnique({
            where: { userId_symbol: { userId, symbol } },
          });

          if (existing) {
            const newQty = existing.quantity + quantity;
            const newTotal = existing.total + cost;
            await tx.commodityPortfolio.update({
              where: { userId_symbol: { userId, symbol } },
              data: {
                quantity: newQty,
                total: newTotal,
                price: newTotal / newQty,
              },
            });
          } else {
            await tx.commodityPortfolio.create({
              data: {
                userId,
                symbol,
                name,
                price: rate,
                quantity,
                total: cost,
              },
            });
          }

          const transaction = await tx.transaction.create({
            data: {
              userId,
              openingBalance,
              closingBalance,
              usedBalance: cost,
              type: "Debit",
              status: "completed",
            },
          });

          await tx.order.create({
            data: {
              userId,
              transactionId: transaction.id,
              stockSymbol: symbol,
              stockName: name,
              stockPrice: rate,
              stockQuantity: quantity,
              stockTotal: cost,
              status: "completed",
              type: "buy",
              orderMode: "delivery",
              description: `[Commodity] Buy: ${quantity} ${name} @ ₹${rate.toFixed(2)}`,
            },
          });

          return { type: "buy", closingBalance };
        } else {
          const holding = await tx.commodityPortfolio.findUnique({
            where: { userId_symbol: { userId, symbol } },
          });

          if (!holding || holding.quantity < quantity)
            throw new ErrorHandler("Insufficient commodity holdings to sell", 400);

          const saleAmount = cost;
          const closingBalance = openingBalance + saleAmount;

          await tx.user.update({
            where: { id: userId },
            data: { balance: closingBalance },
          });

          const newQty = holding.quantity - quantity;
          if (newQty < 0.0001) {
            await tx.commodityPortfolio.delete({
              where: { userId_symbol: { userId, symbol } },
            });
          } else {
            // `total` is COST BASIS, so remove it at the average price paid —
            // not at the sale price. Subtracting `cost` (the proceeds) meant
            // selling into a rising market drove the basis negative and
            // poisoned the average price on the next buy (S-11).
            await tx.commodityPortfolio.update({
              where: { userId_symbol: { userId, symbol } },
              data: {
                quantity: newQty,
                total: holding.total - holding.price * quantity,
              },
            });
          }

          const transaction = await tx.transaction.create({
            data: {
              userId,
              openingBalance,
              closingBalance,
              usedBalance: saleAmount,
              type: "Credit",
              status: "completed",
            },
          });

          await tx.order.create({
            data: {
              userId,
              transactionId: transaction.id,
              stockSymbol: symbol,
              stockName: name,
              stockPrice: rate,
              stockQuantity: quantity,
              stockTotal: cost,
              status: "completed",
              type: "sell",
              orderMode: "delivery",
              description: `[Commodity] Sell: ${quantity} ${name} @ ₹${rate.toFixed(2)}`,
            },
          });

          return { type: "sell", closingBalance };
        }
      },
    );

    res.status(200).json({
      success: true,
      message: `Commodity ${type} order executed successfully`,
      ...result,
      executedPrice: rate,
    });
  },
);

// ─── Get Commodity Portfolio ──────────────────────────────────────────────────
export const getCommodityPortfolio = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );

    const holdings = await prisma.commodityPortfolio.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    res.status(200).json({ success: true, holdings });
  },
);
