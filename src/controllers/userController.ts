import { Request, Response, NextFunction } from "express";
import { User } from "../models/userModel";
import TryCatch from "../utils/Trycatch";
export const CreateUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, email, password } = req.body;

    const result = await User.create({
      name,
      email,
      password,
    });
    res.status(200).json({
      success: true,
      message: "Account Created Successfully",
    });
  }
);
