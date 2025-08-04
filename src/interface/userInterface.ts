
import { JwtPayload } from "jsonwebtoken";

export type UserPayload = JwtPayload | string;



export interface Cors {
  origin: string[];
  methods: string[];
  credentials: boolean;
  sameSite?: string;
}
