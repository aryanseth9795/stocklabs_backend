import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import bcrypt from "bcrypt";
import { generateToken } from "../utils/token.js";
import { TradeRequestBody } from "../interface/userInterface.js";
import { Prisma } from "@prisma/client";

// Starting of Controller

const cookie_Expiry: number = Number(process.env.COOKIE_EXPIRY) || 3;
const MODE: string = String(process.env.NODE_ENV) || "PRODUCTION";

const cookieOptions = {
  maxAge: cookie_Expiry * 24 * 60 * 60 * 1000 || 3 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: MODE !== "DEVELOPMENT",
  sameSite: (MODE !== "DEVELOPMENT" ? "none" : "lax") as "none" | "lax",
  // path: "/app/home",
};

export const CreateUser = TryCatch(
  async (
    req: Request<{}, {}, Prisma.UserCreateInput>,
    res: Response,
    next: NextFunction
  ) => {
    console.log("api hitted");
    console.log(req.body);
    const { name, email, password } = req.body;
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (!name || !email || !password) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    if (password.length < 6) {
      return next(
        new ErrorHandler("Password must be at least 6 characters", 400)
      );
    }
    if (existingUser) {
      return next(new ErrorHandler("User Already Exists", 400));
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    if (!hashedPassword) {
      return next(new ErrorHandler("Error in hashing password", 400));
    }
    const result = await prisma.user.create({
      data: { name, email, password: hashedPassword },
    });

    if (!result) {
      next(new ErrorHandler("Error in creating User", 400));
    }

    //sending token
    const token = generateToken(result.id);
    // console.log(token);
    console.log(result);
    // console.log(req.body);
    res.status(200).cookie("token", token, cookieOptions).json({
      success: true,
      message: "Account Created Successfully",
    });
  }
);

export const LoginUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, password } = req.body;

    const result = await prisma.user.findUnique({
      where: { email },
    });
    if (!email || !password) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    if (!result) {
      return next(new ErrorHandler("Invalid Email or Password", 400));
    }

    const isPasswordMatched = await bcrypt.compare(password, result?.password);

    if (!isPasswordMatched) {
      next(new ErrorHandler("Invalid Email or Password", 400));
    }
    //sending token
    const token = generateToken(result?.id!);

    res.status(200).cookie("token", token, cookieOptions).json({
      success: true,
      message: "Login Successfully",
      token,
    });
  }
);

export const getMyProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // Check if user is authenticated o
    if (!req?.user?.id) {
      next(new ErrorHandler("Please login to access this resource", 401));
    }

    const user = await prisma.user.findUnique({ where: { id: req?.user?.id } });
    if (!user) {
      return next(new ErrorHandler("User Not Found", 404));
    }
  

    const portfolio = await prisma.portfolio.findMany({ where: { userId: user.id } });

    let totalInvested = 0;
    const stockNames: string[] = [];

    for (let i = 0; i < portfolio.length; i++) {
      const row = portfolio[i];
      totalInvested +=
        typeof row.stockTotal === "number"
          ? row.stockTotal
          : row.stockPrice * row.stockQuantity;
      stockNames[stockNames.length] = row.stockName;
    }

      // Exclude password from the response
    const withoutPassword: any = { ...user ,totalInvested,stockNames};
    delete withoutPassword?.password;
    // Return the user data without the password

    res.status(200).json({
      success: true,
      message: "Profile Fetched Successfully",
      user: withoutPassword,
    });
  }
);

// export const ExecuteOrder = TryCatch(
//   async (req: Request, res: Response, next: NextFunction) => {
//     const {
//       type,
//       stockSymbol,
//       stockName,
//       stockQuantity,
//       stockPrice,

//     } = req.body;

//     if (!stockName || !stockQuantity || !stockPrice || !stockSymbol || !type) {
//       return next(new ErrorHandler("Please provide all fields", 400));
//     }
//     const user = await prisma.user.findUnique({
//       where: { id: req.user!.id },
//     });
//     if (stockPrice * stockQuantity > user?.balance!) {
//       return next(new ErrorHandler("Insufficient balance", 400));
//     }

//     // creating transaction
//     try {
//       const result = await prisma.transaction.create({
//         data: {
//           userId: req.user!.id,
//           openingBalance: user?.balance!,
//           closingBalance:
//             type === "sell"
//               ? user?.balance! + stockPrice * stockQuantity
//               : user?.balance! - stockPrice * stockQuantity,
//           usedBalance: stockPrice * stockQuantity,
//           type: type === "buy" ? "withdrawal" : "deposit",
//           status: "success",

//         },
//       });

//       if (!result) {
//         return next(new ErrorHandler("Error in executing order", 400));
//       }
//       // updating user balance
//       const updatedUser = await prisma.user.update({
//         where: { id: user?.id },
//         data: {
//           balance:
//             type === "sell"
//               ? user?.balance! + stockPrice * stockQuantity
//               : user?.balance! - stockPrice * stockQuantity,
//         },
//       });
//       if (!updatedUser) {
//         return next(new ErrorHandler("Error in updating balance", 400));
//       }
//       // creating order
//       const order = await prisma.order.create({
//         data: {
//           userId: req.user!.id,
//           stockName,
//           stockQuantity,
//           stockPrice,
//           stockSymbol,
//           type,
//           stockTotal: stockPrice * stockQuantity,
//           status: "success",
//           transactionId: result.id,
//           description: `Order executed for ${stockQuantity} shares of ${stockName} at ${stockPrice} per share.`,
//         },
//       });

//       const userPortfolio = await prisma.portfolio.upsert({
//         where: { userId: req.user?.id },
//         update: {
//           stocks: {
//             upsert: {
//               where: { stockSymbol },
//               update: {
//                 stockName,
//                 stockQuantity:
//                   type === "buy"
//                     ? { increment: stockQuantity }
//                     : { decrement: stockQuantity },
//                 stockPrice,
//               },
//               create: {
//                 stockName,
//                 stockSymbol,
//                 stockQuantity,
//                 stockPrice,
//               },
//             },
//           },
//         },
//       });
//     } catch (error) {
//       await prisma.transaction.create({
//         data: {
//           userId: user?.id,
//           openingBalance: user!?.balance,
//           closingBalance: user!?.balance,
//           usedBalance: stockPrice * stockQuantity,
//           type: type === "buy" ? "withdrawal" : "deposit",
//           status: "failed",
//           currency,
//         },
//       });

//       await prisma.order.create({
//         data: {
//           userId: user?.id,
//           stockName,
//           stockQuantity,
//           stockPrice,
//           stockSymbol,
//           type,
//           stockTotal: stockPrice * stockQuantity,
//           status: "failed",
//           description: `Order execution failed for ${stockQuantity} shares of ${stockName} at ${stockPrice} per share.`,
//         },
//       });
//       return next(new ErrorHandler("Error in executing order", 400));
//     }

//     res.status(200).json({
//       success: true,
//       message: "Order Executed Successfully",
//     });
//   }
// );

export const ExecuteOrder = TryCatch(
  async (
    req: Request<{}, {}, TradeRequestBody>,
    res: Response,
    next: NextFunction
  ) => {
    const { userId, stockName, quantity, rate, type } = req.body;
    const txRecord = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // 1) Fetch user
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error("User not found");

        const cost = quantity * rate;
        const openingBalance = user.balance;
        let closingBalance: number;

        // 2) Buy vs Sell logic
        if (type === "buy") {
          if (openingBalance < cost)
            return new ErrorHandler("Insufficient balance", 400);

          const existing = await tx.portfolio.findFirst({
            where: { userId, stockName },
          });

          closingBalance = openingBalance - cost;

          if (existing) {
            await tx.portfolio.update({
              where: { id: existing.id },
              data: {
                stockQuantity: existing.stockQuantity + quantity,
                stockTotal: existing.stockTotal + cost,
              },
            });
          } else {
            await tx.portfolio.create({
              data: {
                userId,
                stockName,
                stockPrice: rate,
                stockQuantity: quantity,
                stockSymbol: stockName,
                stockTotal: cost,
              },
            });
          }
        } else {
          // -- sell
          const existing = await tx.portfolio.findFirst({
            where: { userId, stockName },
          });
          if (!existing || existing.stockQuantity < quantity) {
            return new ErrorHandler(`Not enough ${stockName} to sell`, 400);
          }

          if (existing.stockQuantity === quantity) {
            // sold entire holding → delete record
            await tx.portfolio.delete({ where: { id: existing.id } });
          } else {
            // sold a portion → subtract quantity
            await tx.portfolio.update({
              where: { id: existing.id },
              data: { stockQuantity: existing.stockQuantity - quantity },
            });
          }

          closingBalance = openingBalance + cost;
        }

        // 3) Update user balance
        await tx.user.update({
          where: { id: userId },
          data: { balance: closingBalance },
        });

        // 4) Record Transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            openingBalance,
            closingBalance,
            usedBalance: cost,
            type: type === "buy" ? "withdrawal" : "deposit",
            status: "completed",
          },
        });

        // 5) Record Order
        await tx.order.create({
          data: {
            userId,
            transactionId: transaction.id,
            stockSymbol: stockName,
            stockName,
            stockPrice: rate,
            stockQuantity: quantity,
            stockTotal: cost,
            status: "completed",
            type,
            description:
              type === "buy"
                ? `Bought ${quantity} ${stockName} @ ${rate}`
                : `Sold ${quantity} ${stockName} @ ${rate}`,
          },
        });
        return transaction;
      }
    );

    res.json({ message: "Transaction successful", transaction: txRecord });
  }
);

export const getMyPortfolio = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const portfolio = await prisma.portfolio.findMany({
      where: { userId: req.user!.id },
    });

    if (!portfolio) {
      return next(new ErrorHandler("Portfolio Not Found", 404));
    }

    res.status(200).json({
      success: true,
      message: "Portfolio Fetched Successfully",
      portfolio,
    });
  }
);

export const getMyTransactions = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (!transactions) {
      return next(new ErrorHandler("Transactions Not Found", 404));
    }

    res.status(200).json({
      success: true,
      message: "Transactions Fetched Successfully",
      transactions,
    });
  }
);

export const getMyOrders = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log(req.user);
    const orders = await prisma.order.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (!orders) {
      return next(new ErrorHandler("Orders Not Found", 404));
    }
    res.status(200).json({
      success: true,
      message: "Orders Fetched Successfully",
      orders,
    });
  }
);

export const check = TryCatch(
  async (req: any, res: Response, next: NextFunction) => {
    res.send("hello");
  }
);
