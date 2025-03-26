import { Request, Response, NextFunction } from "express";
import { User } from "../models/userModel";
import { Order } from "../models/orderModel";
import TryCatch from "../utils/Trycatch";
import ErrorHandler from "../middlewares/ErrorHandler";
import bcrypt from "bcrypt";
import { AuthenticatedRequest } from "../interface/userInterface";

export const CreateUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, email, password } = req.body;

    const result = await User.create({
      name,
      email,
      password,
    });

    if (!result) {
      next(new ErrorHandler("Error in creating user", 400));
    }

    res.status(200).json({
      success: true,
      message: "Account Created Successfully",
    });
  }
);

export const LoginUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, password } = req.body;

    const result: any = await User.findOne({ email }).select("+password");

    if (!result) {
      next(new ErrorHandler("Invalid Email or Password", 400));
    }

    const isPasswordMatched = await bcrypt.compare(password, result?.password);

    if (!isPasswordMatched) {
      next(new ErrorHandler("Invalid Email or Password", 400));
    }

    res.status(200).json({
      success: true,
      message: "Login Successfully",
      user: result,
    });
  }
);

export const getMyProfile = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req?.user?.id) {
      next(new ErrorHandler("Please login to access this resource", 401));
    }

    const user = await User.findById(req.user.id);
    res.status(200).json({
      success: true,
      user,
    });
  }
);

export const BuyStock = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req?.user?.id) {
      next(new ErrorHandler("Please login to access this resource", 401));
    }

    const { stockSymbol, stockName, stockPrice, stockQuantity } = req.body;
    const user = await User.findById(req.user.id);

    if (user && user.accountBalance < stockPrice * stockQuantity) {
      return next(new ErrorHandler("Insufficient Balance", 400));
    }
    const order = await Order.create({
      stockSymbol,
      stockName,
      stockPrice,
      stockQuantity,
      user: req.user.id,
    });

    user && (user.accountBalance -= stockPrice * stockQuantity);
    user && (await user.save());

    res.status(200).json({
      success: true,
      message: "Trade Order Excecuted Successfully",
      order,
    });
  }
);

export const SellStock = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { buyid, stockPrice, quantity } = req.body;

    const user = await User.findById(req.user.id);
    const order = await Order.findById(buyid);

    if (!user || !order) {
      return next(new ErrorHandler("Order Not Found", 400));
    }
    order.stockQuantity -= quantity;
    user.accountBalance += stockPrice * quantity;
    await order.save(); 
    await user.save(); 

    res.status(200).json({
      success: true,
      message: "Trade Order Excecuted Successfully",
    });
  }
);
