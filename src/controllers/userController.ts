import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import bcrypt from "bcrypt";
import { generateToken } from "../utils/token.js";
export const CreateUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, email, password } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      return next(new ErrorHandler("User Already Exists", 400));
    }
    if (!name || !email || !password) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    if (password.length < 6) {
      return next(
        new ErrorHandler("Password must be at least 6 characters", 400)
      );
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    if (!hashedPassword) {
      return next(new ErrorHandler("Error in hashing password", 400));
    }
    const result = await prisma.user.create({
      name,
      email,
      password: hashedPassword,
    });

    if (!result) {
      next(new ErrorHandler("Error in creating User", 400));
    }

    //sending token
    const token = generateToken(result.id);
    res.status(200).json({
      success: true,
      message: "Account Created Successfully",
      token,
    });
  }
);

export const LoginUser = TryCatch(
  async (req: any, res: Response, next: NextFunction) => {
    const { email, password } = req.body;

    const result = await prisma.user.findUnique({
      where: { email },
    });
    if (!email || !password) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    if (!result) {
      next(new ErrorHandler("Invalid Email or Password", 400));
    }

    const isPasswordMatched = await bcrypt.compare(password, result?.password);

    if (!isPasswordMatched) {
      next(new ErrorHandler("Invalid Email or Password", 400));
    }
    //sending token
    const token = generateToken(result.id);

    res.status(200).json({
      success: true,
      message: "Login Successfully",
      token,
    });
  }
);

export const getMyProfile = TryCatch(
  async (req: any, res: Response, next: NextFunction) => {
    const userID = req?.user?.id;
    // Check if user is authenticated o
    if (!req?.user?.id) {
      next(new ErrorHandler("Please login to access this resource", 401));
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return next(new ErrorHandler("User Not Found", 404));
    }
    // Exclude password from the response
    const withoutPassword = { ...user };
    delete withoutPassword.password;
    // Return the user data without the password

    res.status(200).json({
      success: true,
      message: "Profile Fetched Successfully",
      user: withoutPassword,
    });
  }
);



export const ExecuteOrder = TryCatch(
  async (req: any, res: Response, next: NextFunction) => {
    const {
      stockName,
      stockQuantity,
      stockPrice,
      stockSymbol,
      type,
      currency,
    } = req.body;

    if (!stockName || !stockQuantity || !stockPrice || !stockSymbol || !type) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });
    if (stockPrice * stockQuantity > user?.balance) {
      return next(new ErrorHandler("Insufficient balance", 400));
    }

    // creating transaction
    try {
      const result = await prisma.transaction.create({
        data: {
          userId: user?.id,
          openingBalance: user?.balance,
          closingBalance:
            type === "sell"
              ? user?.balance + stockPrice * stockQuantity
              : user?.balance - stockPrice * stockQuantity,
        },
        usedBalance: stockPrice * stockQuantity,
        type: type === "buy" ? "withdrawal" : "deposit",
        status: "success",
        currency,
      });

      if (!result) {
        return next(new ErrorHandler("Error in executing order", 400));
      }
      // updating user balance
      const updatedUser = await prisma.user.update({
        where: { id: user?.id },
        data: {
          balance:
            type === "sell"
              ? user?.balance + stockPrice * stockQuantity
              : user?.balance - stockPrice * stockQuantity,
        },
      });
      if (!updatedUser) {
        return next(new ErrorHandler("Error in updating balance", 400));
      }
      // creating order
      const order = await prisma.order.create({
        data: {
          userId: user?.id,
          stockName,
          stockQuantity,
          stockPrice,
          stockSymbol,
          type,
          stockTotal: stockPrice * stockQuantity,
          status: "success",
          transactionId: result.id,
          description: `Order executed for ${stockQuantity} shares of ${stockName} at ${stockPrice} per share.`,
        },
      });

      const userPortfolio = await prisma.portfolio.upsert({
        where: { userId: user?.id },
        update: {
          stocks: {
            upsert: {
              where: { stockSymbol },
              update: {
                stockName,
                stockQuantity:
                  type === "buy"
                    ? { increment: stockQuantity }
                    : { decrement: stockQuantity },
                stockPrice,
              },
              create: {
                stockName,
                stockSymbol,
                stockQuantity,
                stockPrice,
              },
            },
          },
        },
      });
    } catch (error) {
      await prisma.transaction.create({
        data: {
          userId: user?.id,
          openingBalance: user?.balance,
          closingBalance: user?.balance,
          usedBalance: stockPrice * stockQuantity,
          type: type === "buy" ? "withdrawal" : "deposit",
          status: "failed",
          currency,
        },
      });

      await prisma.order.create({
        data: {
          userId: user?.id,
          stockName,
          stockQuantity,
          stockPrice,
          stockSymbol,
          type,
          stockTotal: stockPrice * stockQuantity,
          status: "failed",
          description: `Order execution failed for ${stockQuantity} shares of ${stockName} at ${stockPrice} per share.`,
        },
      });
      return next(new ErrorHandler("Error in executing order", 400));
    }

    res.status(200).json({
      success: true,
      message: "Order Executed Successfully",
    });
  }
);


export const getMyPortfolio=TryCatch(async(req:any,res:Response,next:NextFunction)=>{

    const userId = req.user.id;

    if (!userId) {
        return next(new ErrorHandler("Please login to access this resource", 401));
    }

    const portfolio = await prisma.portfolio.findUnique({
        where: { userId },
    });

    if (!portfolio) {
        return next(new ErrorHandler("Portfolio Not Found", 404));
    }

    res.status(200).json({
        success: true,
        message: "Portfolio Fetched Successfully",
        portfolio,
    });

  })

  export const check=TryCatch(async(req:any,res:Response,next:NextFunction)=>{
    res.send("hello")
  })