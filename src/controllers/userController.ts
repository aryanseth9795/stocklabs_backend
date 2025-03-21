import { Request, Response, NextFunction } from "express";
import { User } from "../models/userModel";
import TryCatch from "../utils/Trycatch";
import ErrorHandler from "../middlewares/ErrorHandler";
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
