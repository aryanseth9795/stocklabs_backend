import { Request, Response, NextFunction } from "express";
import { User } from "../models/userModel";
import TryCatch from "../utils/Trycatch";
import ErrorHandler from "../middlewares/ErrorHandler";
import bcrypt from "bcrypt";


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
  async (req: Request, res: Response, next: NextFunction) => {
    const user = await User.findById(req?.user?._id);
    res.status(200).json({
      success: true,
      user,
    });
  }
);