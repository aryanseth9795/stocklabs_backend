// src/types/global.d.ts
import { UserPayload } from '../interface/userInterface';

declare global {
  namespace Express {
    interface Request {
      /** set by your auth middleware */
      user?: {
        id?: UserPayload;
        // …any other properties you attach
      };
    }
  }
}

// make this file a module so TS picks it up
export {};
