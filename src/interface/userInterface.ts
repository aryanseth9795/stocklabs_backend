
import { JwtPayload } from "jsonwebtoken";

export type UserPayload = {userId: string} & JwtPayload ;



export interface Cors {
  origin: string[];
  methods: string[];
  credentials: boolean;
  sameSite?: string;
}


export interface TradeRequestBody {
  userId: string
  stockName: string
  quantity: number
  rate: number,
  type: "buy" | "sell"
}