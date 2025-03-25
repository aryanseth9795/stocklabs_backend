import { Request } from "express";
import { JwtPayload } from "jsonwebtoken";


 export type UserPayload = JwtPayload | string;


 export interface AuthenticatedRequest extends Request {
  user: {
    id: UserPayload;
  };
}