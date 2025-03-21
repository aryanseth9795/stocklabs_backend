import { Request, Response, NextFunction } from "express";
import ErrorHandler from "./ErrorHandler";

const errorMiddleware = (
  err: ErrorHandler,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  err.message ||= "Internal Server Error";
  err.statusCode ||= 500;

  res.status(err.statusCode).json({ success: false, message: err.message });
};

export default errorMiddleware;
