import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import { Prisma } from "@prisma/client";
import { commodityPriceCache } from "../utils/autoCutJob.js";
import https from "https";
import http from "http";

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
 * Proxies the upstream commodity SSE to the client.
 * Handles upstream cold-start timeouts by retrying every 10 s,
 * and sends keepalive comments every 20 s so the client doesn't time out.
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

  let closed = false;
  let upstreamReq: http.ClientRequest | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    upstreamReq?.destroy();
  };

  // Keepalive comment every 20s so client knows we're alive
  heartbeatTimer = setInterval(() => {
    if (!closed) {
      try {
        res.write(": keepalive\n\n");
      } catch {
        cleanup();
      }
    }
  }, 20_000);

  const connect = () => {
    if (closed) return;

    const url = new URL(COMMODITY_SSE_URL);
    const lib = url.protocol === "https:" ? https : http;

    upstreamReq = lib.get(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { Accept: "text/event-stream" },
        timeout: 30_000, // 30s socket timeout
      },
      (upstreamRes) => {
        if (closed) {
          upstreamRes.destroy();
          return;
        }

        let buffer = "";

        upstreamRes.on("data", (chunk: Buffer) => {
          if (closed) return;
          const text = chunk.toString();
          buffer += text;

          // Parse SSE events from buffer to update price cache
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let eventType = "";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataStr += line.slice(5).trim();
            } else if (line === "" && dataStr) {
              if (eventType === "prices:update") {
                try {
                  const payload = JSON.parse(dataStr);
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
                  /* ignore */
                }
              }
              eventType = "";
              dataStr = "";
            }
          }

          // Forward raw chunk directly to client
          try {
            res.write(text);
          } catch {
            cleanup();
          }
        });

        upstreamRes.on("end", () => {
          if (!closed) {
            console.warn("[Commodity SSE] Upstream ended, retrying in 10s…");
            retryTimer = setTimeout(connect, 10_000);
          }
        });

        upstreamRes.on("error", (err) => {
          console.error("[Commodity SSE] Upstream stream error:", err.message);
          if (!closed) {
            retryTimer = setTimeout(connect, 10_000);
          }
        });
      },
    );

    upstreamReq.on("timeout", () => {
      console.warn("[Commodity SSE] Upstream request timed out, retrying…");
      upstreamReq?.destroy();
      if (!closed) {
        retryTimer = setTimeout(connect, 10_000);
      }
    });

    upstreamReq.on("error", (err) => {
      console.error("[Commodity SSE] Request error:", err.message);
      if (!closed) {
        retryTimer = setTimeout(connect, 10_000);
      }
    });
  };

  // Disconnect handling
  req.on("close", cleanup);
  res.on("close", cleanup);

  connect();
};

// ─── Execute Commodity Order ──────────────────────────────────────────────────
export const executeCommodityOrder = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { symbol, quantity, rate, type } = req.body;
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
            throw new Error("Insufficient commodity holdings to sell");

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
