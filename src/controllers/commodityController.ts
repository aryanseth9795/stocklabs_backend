import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import { Prisma } from "@prisma/client";
import { commodityPriceCache } from "../utils/autoCutJob.js";
import https from "https";

const COMMODITY_SSE_URL =
  "https://ssj-server-om8r.onrender.com/api/prices/stream";

const COMMODITY_NAMES: Record<string, string> = {
  GOLD: "Gold",
  SILVER: "Silver",
  CRUDEOIL: "Crude Oil",
  COPPER: "Copper",
};

// ─── SSE Relay ────────────────────────────────────────────────────────────────
/**
 * GET /commodity/stream
 * Proxies the upstream commodity SSE to the client as a pass-through SSE.
 * Also updates the in-memory commodityPriceCache for the auto-cut job.
 */
export const streamCommodityPrices = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const upstreamReq = https.get(COMMODITY_SSE_URL, (upstreamRes) => {
    upstreamRes.on("data", (chunk: Buffer) => {
      const text = chunk.toString();

      // Update in-memory price cache for auto-cut job
      if (text.includes("prices:update")) {
        const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) {
          try {
            const payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
            const list = payload?.live?.list;
            if (Array.isArray(list)) {
              list.forEach((item: any) => {
                const price = parseFloat(item.lastPrice);
                if (!isNaN(price)) {
                  commodityPriceCache[item.symbol] = price;
                }
              });
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }

      // Forward to client
      res.write(text);
    });

    upstreamRes.on("end", () => {
      res.end();
    });

    upstreamRes.on("error", (err) => {
      console.error("[Commodity SSE] Upstream error:", err);
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`,
      );
      res.end();
    });
  });

  upstreamReq.on("error", (err) => {
    console.error("[Commodity SSE] Request error:", err);
    res.write(
      `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`,
    );
    res.end();
  });

  // Clean up on client disconnect
  req.on("close", () => {
    upstreamReq.destroy();
  });
};

// ─── Execute Commodity Order ──────────────────────────────────────────────────
/**
 * POST /commodity/execute
 * Supports buy, sell (delivery), and short_sell.
 * For short_sell, delegates to the ShortPosition table.
 */
export const executeCommodityOrder = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { symbol, quantity, rate, type } = req.body;
    // type: "buy" | "sell" | "short_sell"
    const userId = req.user?.id;
    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    if (!symbol || !quantity || !rate || !type)
      return next(new ErrorHandler("Please provide all required fields", 400));

    const name = COMMODITY_NAMES[symbol] ?? symbol;
    const cost = quantity * rate;

    if (type === "short_sell") {
      // Delegate to ShortPosition logic (same pattern as shortController but inline for commodity)
      const result = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.findUnique({ where: { id: userId } });
          if (!user) throw new Error("User not found");
          if (user.balance < cost)
            throw new Error(
              `Insufficient balance. Required margin: ₹${cost.toFixed(2)}`,
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
      });
    }

    // Delivery buy / sell
    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error("User not found");

        const openingBalance = user.balance;

        if (type === "buy") {
          if (user.balance < cost)
            throw new Error(
              `Insufficient balance. Required: ₹${cost.toFixed(2)}`,
            );

          const closingBalance = openingBalance - cost;
          await tx.user.update({
            where: { id: userId },
            data: { balance: closingBalance },
          });

          // Upsert CommodityPortfolio
          const existing = await tx.commodityPortfolio.findUnique({
            where: { userId_symbol: { userId, symbol } },
          });

          if (existing) {
            const newQty = existing.quantity + quantity;
            const newTotal = existing.total + cost;
            const newAvgPrice = newTotal / newQty;
            await tx.commodityPortfolio.update({
              where: { userId_symbol: { userId, symbol } },
              data: { quantity: newQty, total: newTotal, price: newAvgPrice },
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
          // Sell
          const holding = await tx.commodityPortfolio.findUnique({
            where: { userId_symbol: { userId, symbol } },
          });

          if (!holding || holding.quantity < quantity)
            throw new Error("Insufficient commodity holdings to sell");

          const saleAmount = cost;
          const closingBalance = openingBalance + saleAmount;

          await tx.user.update({
            where: { id: userId },
            data: { balance: closingBalance },
          });

          const newQty = holding.quantity - quantity;
          if (newQty === 0) {
            await tx.commodityPortfolio.delete({
              where: { userId_symbol: { userId, symbol } },
            });
          } else {
            await tx.commodityPortfolio.update({
              where: { userId_symbol: { userId, symbol } },
              data: { quantity: newQty, total: holding.total - cost },
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
