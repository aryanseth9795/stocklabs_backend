import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import { Prisma } from "@prisma/client";
import { getLivePriceINR, type AssetType } from "../utils/priceCache.js";
import {
  validateQuantity,
  validateString,
  validateEnum,
} from "../utils/validate.js";

// ─── Short Sell ───────────────────────────────────────────────────────────────
// Opens a short position: hold margin = entryPrice * qty from user balance,
// create ShortPosition(status=open), Transaction, and Order records.
export const executeShortSell = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;

    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );

    const stockName = validateString(req.body.stockName, "stockName");
    const stockSymbol = validateString(req.body.stockSymbol, "stockSymbol");
    const quantity = validateQuantity(req.body.quantity);
    const assetType = validateEnum(
      req.body.assetType ?? "crypto",
      ["crypto", "commodity"] as const,
      "assetType",
    ) as AssetType;

    // Entry price is the server's, not the client's. A client-chosen entry price
    // lets a user open a short at any level they like (S-02).
    const rate = getLivePriceINR(stockSymbol, assetType);
    if (rate === null)
      return next(
        new ErrorHandler(
          `No live price available for ${stockSymbol}. Please try again shortly.`,
          503,
        ),
      );

    const margin = quantity * rate;

    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new ErrorHandler("User not found", 404);
        if (user.balance < margin)
          throw new ErrorHandler(
            `Insufficient balance. Required margin: ₹${margin.toFixed(2)}`,
            400,
          );

        const openingBalance = user.balance;
        const closingBalance = openingBalance - margin;

        // Debit margin from user balance
        await tx.user.update({
          where: { id: userId },
          data: { balance: closingBalance },
        });

        // Create ShortPosition
        const shortPosition = await tx.shortPosition.create({
          data: {
            userId,
            assetType,
            stockSymbol,
            stockName,
            entryPrice: rate,
            quantity,
            totalValue: margin,
            status: "open",
          },
        });

        // Create Transaction record
        const transaction = await tx.transaction.create({
          data: {
            userId,
            openingBalance,
            closingBalance,
            usedBalance: margin,
            type: "Debit",
            status: "completed",
          },
        });

        // Create Order record (short_sell mode)
        await tx.order.create({
          data: {
            userId,
            transactionId: transaction.id,
            stockSymbol,
            stockName,
            stockPrice: rate,
            stockQuantity: quantity,
            stockTotal: margin,
            status: "completed",
            type: "sell",
            orderMode: "short_sell",
            description: `Short Sell: ${quantity} ${stockName} @ ₹${rate.toFixed(2)}`,
          },
        });

        return { shortPosition, transaction };
      },
    );

    res.status(200).json({
      success: true,
      message: "Short position opened successfully",
      shortPosition: result.shortPosition,
      executedPrice: rate,
    });
  },
);

// ─── Close Short Position ─────────────────────────────────────────────────────
// Covers an open short: realise P&L = (entryPrice - exitPrice) * qty,
// return margin ± P&L to user balance.
export const closeShortPosition = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;

    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );

    const shortPositionId = validateString(
      req.body.shortPositionId,
      "shortPositionId",
    );

    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const short = await tx.shortPosition.findUnique({
          where: { id: shortPositionId },
        });
        if (!short) throw new ErrorHandler("Short position not found", 404);
        if (short.userId !== userId) throw new ErrorHandler("Unauthorized", 403);
        if (short.status !== "open")
          throw new ErrorHandler("Position already closed", 409);

        // Exit price from the server. This one mattered most: P&L is
        // (entryPrice - exitPrice) * quantity, so a client-supplied exit price
        // was a direct dial on how much money to create (S-02).
        const exitPrice = getLivePriceINR(
          short.stockSymbol,
          short.assetType as AssetType,
        );
        if (exitPrice === null)
          throw new ErrorHandler(
            `No live price available for ${short.stockSymbol}. Please try again shortly.`,
            503,
          );

        const profitLoss = (short.entryPrice - exitPrice) * short.quantity;
        const returnAmount = short.totalValue + profitLoss; // margin ± P&L

        // Claim the position with a conditional write. The status check above is
        // a plain read under READ COMMITTED, so two concurrent covers (or a cover
        // racing the auto-cut job) both saw "open" and both credited the balance —
        // the position closes once but pays out twice (S-06). Only one
        // transaction can move the row out of "open"; the loser aborts here,
        // before any money moves.
        const claimed = await tx.shortPosition.updateMany({
          where: { id: shortPositionId, status: "open" },
          data: {
            status: "closed",
            exitPrice,
            profitLoss,
            closedAt: new Date(),
          },
        });
        if (claimed.count === 0)
          throw new ErrorHandler("Position already closed", 409);

        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new ErrorHandler("User not found", 404);

        const openingBalance = user.balance;
        const closingBalance = openingBalance + returnAmount;

        // Return margin + P&L to user
        await tx.user.update({
          where: { id: userId },
          data: { balance: closingBalance },
        });

        const closedShort = await tx.shortPosition.findUnique({
          where: { id: shortPositionId },
        });

        // Transaction record
        const transaction = await tx.transaction.create({
          data: {
            userId,
            openingBalance,
            closingBalance,
            usedBalance: Math.abs(returnAmount),
            type: "Credit",
            status: "completed",
          },
        });

        // Order record (short_cover mode)
        await tx.order.create({
          data: {
            userId,
            transactionId: transaction.id,
            stockSymbol: short.stockSymbol,
            stockName: short.stockName,
            stockPrice: exitPrice,
            stockQuantity: short.quantity,
            stockTotal: exitPrice * short.quantity,
            status: "completed",
            type: "buy",
            orderMode: "short_cover",
            description: `Short Cover: ${short.quantity} ${short.stockName} @ ₹${exitPrice.toFixed(2)} | P&L: ₹${profitLoss.toFixed(2)}`,
          },
        });

        return { closedShort, profitLoss, returnAmount, exitPrice };
      },
    );

    res.status(200).json({
      success: true,
      message:
        result.profitLoss >= 0
          ? `Position closed with profit ₹${result.profitLoss.toFixed(2)}`
          : `Position closed with loss ₹${Math.abs(result.profitLoss).toFixed(2)}`,
      profitLoss: result.profitLoss,
      shortPosition: result.closedShort,
      executedPrice: result.exitPrice,
    });
  },
);

// ─── Get Short Positions ──────────────────────────────────────────────────────
export const getShortPositions = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );

    const { status } = req.query;

    const whereClause: Prisma.ShortPositionWhereInput = { userId };
    if (status)
      whereClause.status = validateEnum(
        status,
        ["open", "closed", "auto_cut"] as const,
        "status",
      );

    const positions = await prisma.shortPosition.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({
      success: true,
      positions,
    });
  },
);
