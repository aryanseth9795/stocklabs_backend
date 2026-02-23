import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import { Prisma } from "@prisma/client";

// ─── Short Sell ───────────────────────────────────────────────────────────────
// Opens a short position: hold margin = entryPrice * qty from user balance,
// create ShortPosition(status=open), Transaction, and Order records.
export const executeShortSell = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      stockName,
      stockSymbol,
      quantity,
      rate,
      assetType = "crypto",
    } = req.body;
    const userId = req.user?.id;

    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    if (!stockName || !stockSymbol || !quantity || !rate)
      return next(new ErrorHandler("Please provide all required fields", 400));
    if (quantity <= 0 || rate <= 0)
      return next(new ErrorHandler("Quantity and rate must be positive", 400));

    const margin = quantity * rate;

    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error("User not found");
        if (user.balance < margin)
          throw new Error(
            `Insufficient balance. Required margin: ₹${margin.toFixed(2)}`,
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
    });
  },
);

// ─── Close Short Position ─────────────────────────────────────────────────────
// Covers an open short: realise P&L = (entryPrice - exitPrice) * qty,
// return margin ± P&L to user balance.
export const closeShortPosition = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { shortPositionId, rate } = req.body;
    const userId = req.user?.id;

    if (!userId)
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    if (!shortPositionId || rate === undefined)
      return next(
        new ErrorHandler("shortPositionId and rate are required", 400),
      );

    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const short = await tx.shortPosition.findUnique({
          where: { id: shortPositionId },
        });
        if (!short) throw new Error("Short position not found");
        if (short.userId !== userId) throw new Error("Unauthorized");
        if (short.status !== "open") throw new Error("Position already closed");

        const exitPrice = rate;
        const profitLoss = (short.entryPrice - exitPrice) * short.quantity;
        const returnAmount = short.totalValue + profitLoss; // margin ± P&L

        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error("User not found");

        const openingBalance = user.balance;
        const closingBalance = openingBalance + returnAmount;

        // Return margin + P&L to user
        await tx.user.update({
          where: { id: userId },
          data: { balance: closingBalance },
        });

        // Update ShortPosition
        const closedShort = await tx.shortPosition.update({
          where: { id: shortPositionId },
          data: {
            status: "closed",
            exitPrice,
            profitLoss,
            closedAt: new Date(),
          },
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

        return { closedShort, profitLoss, returnAmount };
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

    const whereClause: any = { userId };
    if (status) whereClause.status = status as string;

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
