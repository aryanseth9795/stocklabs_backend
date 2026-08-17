import { Request, Response, NextFunction } from "express";
import prisma from "../db/db.js";
import TryCatch from "../utils/Trycatch.js";
import ErrorHandler from "../middlewares/ErrorHandler.js";
import bcrypt from "bcrypt";
import {
  generateToken,
  generateTokenPair,
  verifyRefreshToken,
} from "../utils/token.js";
import { TradeRequestBody } from "../interface/userInterface.js";
import { Prisma } from "@prisma/client";
import { sendWelcomeEmail, sendOtpEmail } from "../utils/mailer.js";
import { env, isDevelopment } from "../config/env.js";
import { getLivePriceINR } from "../utils/priceCache.js";
import {
  validateQuantity,
  validateEnum,
  validateString,
  validateEmail,
} from "../utils/validate.js";
import crypto from "crypto";
import { rCmd } from "../db/redis.js";
import { istDayKey } from "../utils/istDay.js";

type OtpRecord = {
  otp: string;
  /** Informational. The authoritative expiry is the key's Redis TTL. */
  expiresAt: number;
  issuedAt: number;
  /**
   * Written once as 0 and never read. The live count is `otp:att:<email>`,
   * incremented atomically — see the comment on the attempt cap below. It stays
   * in the record so the stored blob keeps its documented shape; do not start
   * reading it.
   */
  attempts: number;
};

/**
 * OTP state lives in Redis, keyed by email (review D-3).
 *
 * It used to be an in-process `Map`, which is a correctness bug the moment more
 * than one instance serves traffic: an OTP is only verifiable on the instance
 * that issued it, so roughly (N-1)/N of reset attempts fail; the resend cooldown
 * is bypassable by landing on a different instance; and OTP_MAX_ATTEMPTS becomes
 * an effective 5×N guesses. It also lost every pending OTP on restart.
 *
 * Three keys, each doing one job that Redis does natively and correctly:
 *   • `otp:<email>`     the record, with a native TTL instead of a hand-rolled
 *                       expiry comparison — an expired OTP is gone, not merely
 *                       rejected
 *   • `otp:cd:<email>`  the resend cooldown, claimed with SET NX so two
 *                       simultaneous requests cannot both win. Separate from the
 *                       record on purpose: it must keep holding after the OTP is
 *                       consumed or expires
 *   • `otp:att:<email>` the attempt counter, an atomic INCR so the cap is
 *                       enforced fleet-wide
 */
const otpKey = (email: string): string => `otp:${email}`;
const otpCooldownKey = (email: string): string => `otp:cd:${email}`;
const otpAttemptsKey = (email: string): string => `otp:att:${email}`;

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_TTL_SECONDS = OTP_TTL_MS / 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute
const OTP_RESEND_COOLDOWN_SECONDS = OTP_RESEND_COOLDOWN_MS / 1000;

/** How long an OTP Redis command may take before the request is failed. */
const OTP_REDIS_TIMEOUT_MS = 3_000;

/**
 * Run one OTP Redis command, failing CLOSED.
 *
 * If Redis is unreachable the reset flow returns 500. There is deliberately no
 * in-process fallback: a fallback map would re-create the (N-1)/N failure rate
 * AND split the attempt cap N ways, which is worse than a visible outage on one
 * endpoint. The timeout is needed because the client's offline queue holds
 * commands rather than rejecting them — without it a dead Redis produces a hung
 * request instead of an error.
 */
async function otpRedis<T>(op: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${OTP_REDIS_TIMEOUT_MS}ms`)),
          OTP_REDIS_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    console.error("[OTP] Redis unavailable:", (err as Error)?.message ?? err);
    throw new ErrorHandler(
      "Password reset is temporarily unavailable. Please try again shortly.",
      500,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Constant-time string comparison, so a wrong OTP can't be narrowed down by
 *  timing. Length is compared first because timingSafeEqual requires equal
 *  lengths — OTP length is fixed and not secret, so this leaks nothing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parse a stored OTP record, treating anything unreadable as "no OTP".
 *
 * The value now crosses a process boundary, so it is input rather than a local
 * object: a truncated or hand-edited blob must produce the ordinary 400 telling
 * the user to request a new code, not a 500 from JSON.parse or from
 * timingSafeEqualStr being handed a non-string.
 */
function safeParseOtpRecord(raw: string): OtpRecord | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.otp === "string" ? (parsed as OtpRecord) : null;
  } catch {
    return null;
  }
}

// Starting of Controller

// Read via the env module so dotenv has definitely run. Previously these were
// module-level process.env reads that produced the string "undefined", which made
// `MODE !== "DEVELOPMENT"` always true and forced secure/none cookies in local
// development — the lax branch never ran once (S-20).
const cookieOptions = {
  maxAge: env.COOKIE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: !isDevelopment,
  sameSite: (isDevelopment ? "lax" : "none") as "lax" | "none",
};

export const CreateUser = TryCatch(
  async (
    req: Request<{}, {}, Prisma.UserCreateInput>,
    res: Response,
    next: NextFunction,
  ) => {
    const { name, email, password } = req.body;

    // Validate BEFORE querying. The lookup used to run first, so a request
    // without an email hit Prisma with `email: undefined` and returned a 500
    // instead of the 400 the checks below were written to produce (S-18).
    if (!name || !email || !password) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    if (password.length < 6) {
      return next(
        new ErrorHandler("Password must be at least 6 characters", 400),
      );
    }

    // Normalise so "Aryan@x.com" and "aryan@x.com" are one account, not two.
    const normalisedEmail = validateEmail(email);
    const trimmedName = validateString(name, "name");

    const existingUser = await prisma.user.findUnique({
      where: { email: normalisedEmail },
    });
    if (existingUser) {
      return next(new ErrorHandler("User Already Exists", 400));
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    if (!hashedPassword) {
      return next(new ErrorHandler("Error in hashing password", 400));
    }
    const result = await prisma.user.create({
      data: {
        name: trimmedName,
        email: normalisedEmail,
        password: hashedPassword,
      },
    });

    //sending tokens
    const token = generateToken(result.id);
    const { accessToken, refreshToken } = generateTokenPair(result.id);

    // Fire-and-forget welcome email (non-blocking)
    sendWelcomeEmail(result.email, result.name).catch(() => {});

    // Set cookie for web clients, return tokens for mobile
    res.status(201).cookie("token", token, cookieOptions).json({
      success: true,
      message: "Account Created Successfully",
      accessToken,
      refreshToken,
    });
  },
);

export const LoginUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, password } = req.body;

    // Validate before querying, and normalise identically to signup so an
    // account created as "Aryan@x.com" can be logged into as "aryan@x.com".
    if (!email || !password) {
      return next(new ErrorHandler("Please provide all fields", 400));
    }
    const normalisedEmail = String(email).trim().toLowerCase();

    const result = await prisma.user.findUnique({
      where: { email: normalisedEmail },
    });
    if (!result) {
      return next(new ErrorHandler("Invalid Email or Password", 400));
    }

    const isPasswordMatched = await bcrypt.compare(password, result.password);

    if (!isPasswordMatched) {
      return next(new ErrorHandler("Invalid Email or Password", 400));
    }
    //sending tokens
    const token = generateToken(result.id);
    const { accessToken, refreshToken } = generateTokenPair(result.id);

    // Set cookie for web clients, return tokens for mobile
    res.status(200).cookie("token", token, cookieOptions).json({
      success: true,
      message: "Login Successfully",
      accessToken,
      refreshToken,
    });
  },
);

export const getMyProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // `return` matters: without it execution continued into a query with
    // `id: undefined`, and the error middleware fired a second time on an
    // already-sent response (S-17).
    if (!req?.user?.id) {
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return next(new ErrorHandler("User Not Found", 404));
    }

    const portfolio = await prisma.portfolio.findMany({
      where: { userId: user.id },
    });

    let totalInvested = 0;
    const stockNames: string[] = [];

    for (let i = 0; i < portfolio.length; i++) {
      const row = portfolio[i];
      totalInvested +=
        typeof row.stockTotal === "number"
          ? row.stockTotal
          : row.stockPrice * row.stockQuantity;
      stockNames[stockNames.length] = row.stockName;
    }

    // Exclude password from the response
    const withoutPassword: any = { ...user, totalInvested, stockNames };
    delete withoutPassword?.password;
    // Return the user data without the password

    res.status(200).json({
      success: true,
      message: "Profile Fetched Successfully",
      user: withoutPassword,
    });
  },
);

/**
 * Execute a delivery buy/sell order.
 *
 * Two rules this endpoint now enforces that it previously did not:
 *  1. The account traded is ALWAYS the authenticated user (`req.user.id`).
 *     It used to come from `req.body.userId`, letting anyone trade on anyone
 *     else's account (S-03).
 *  2. The fill price is ALWAYS the server's live price. The client's `rate` is
 *     ignored; sending one is harmless but has no effect (S-02).
 */
export const ExecuteOrder = TryCatch(
  async (
    req: Request<{}, {}, TradeRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    const userId = req.user?.id;
    if (!userId) {
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    }

    const { stockName: rawStockName, orderMode = "delivery" } =
      req.body as TradeRequestBody & { orderMode?: string };

    const stockName = validateString(rawStockName, "stockName");
    const type = validateEnum(req.body.type, ["buy", "sell"] as const, "type");
    const quantity = validateQuantity(req.body.quantity);

    // Server-authoritative price. No fallback to the client's value: if we have
    // no fresh quote we refuse the order rather than fill it at whatever the
    // caller claims the market is.
    const rate = getLivePriceINR(stockName, "crypto");
    if (rate === null) {
      return next(
        new ErrorHandler(
          `No live price available for ${stockName}. Please try again shortly.`,
          503,
        ),
      );
    }

    const txRecord = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // 1) Fetch user
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new ErrorHandler("User not found", 404);

        const cost = quantity * rate;
        const openingBalance = user.balance;
        let closingBalance: number;

        // 2) Buy vs Sell logic
        if (type === "buy") {
          // NOTE: `throw`, not `return`. Returning an ErrorHandler from the
          // transaction callback resolved it, and the caller then responded
          // 200 "Transaction successful" for a trade that never happened (S-04).
          if (openingBalance < cost)
            throw new ErrorHandler("Insufficient balance", 400);

          closingBalance = openingBalance - cost;

          // upsert on the actual unique constraint: two concurrent buys of the
          // same symbol used to both see "no row", both insert, and the loser
          // died on a P2002 unique violation surfaced as a 500 (S-21).
          await tx.portfolio.upsert({
            where: { userId_stockSymbol: { userId, stockSymbol: stockName } },
            update: {
              stockQuantity: { increment: quantity },
              stockTotal: { increment: cost },
            },
            create: {
              userId,
              stockName,
              stockPrice: rate,
              stockQuantity: quantity,
              stockSymbol: stockName,
              stockTotal: cost,
            },
          });
        } else {
          // -- sell
          const existing = await tx.portfolio.findUnique({
            where: { userId_stockSymbol: { userId, stockSymbol: stockName } },
          });
          if (!existing || existing.stockQuantity < quantity) {
            throw new ErrorHandler(`Not enough ${stockName} to sell`, 400);
          }

          if (existing.stockQuantity === quantity) {
            // sold entire holding → delete record
            await tx.portfolio.delete({ where: { id: existing.id } });
          } else {
            // Sold a portion. Cost basis is reduced proportionally at the
            // average price paid — subtracting the sale proceeds instead would
            // corrupt the basis (the same defect fixed in commodities, S-11).
            const avgPrice = existing.stockTotal / existing.stockQuantity;
            await tx.portfolio.update({
              where: { id: existing.id },
              data: {
                stockQuantity: existing.stockQuantity - quantity,
                stockTotal: existing.stockTotal - avgPrice * quantity,
              },
            });
          }

          closingBalance = openingBalance + cost;
        }

        // 3) Update user balance
        await tx.user.update({
          where: { id: userId },
          data: { balance: closingBalance },
        });

        // 4) Record Transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            openingBalance,
            closingBalance,
            usedBalance: cost,
            type: type === "buy" ? "Debit" : "Credit",
            status: "completed",
          },
        });

        // 5) Record Order
        await tx.order.create({
          data: {
            userId,
            transactionId: transaction.id,
            stockSymbol: stockName,
            stockName,
            stockPrice: rate,
            stockQuantity: quantity,
            stockTotal: cost,
            status: "completed",
            type,
            orderMode,
            description:
              type === "buy"
                ? `Bought ${quantity} ${stockName} @ ${rate}`
                : `Sold ${quantity} ${stockName} @ ${rate}`,
          },
        });
        return transaction;
      },
    );

    res.json({
      success: true,
      message: "Transaction successful",
      transaction: txRecord,
      // The price the order actually filled at, so clients display the real
      // number rather than the one they optimistically sent.
      executedPrice: rate,
    });
  },
);


export const getMyPortfolio = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const portfolio = await prisma.portfolio.findMany({
      where: { userId: req.user!.id },
    });

    if (!portfolio) {
      return next(new ErrorHandler("Portfolio Not Found", 404));
    }

    res.status(200).json({
      success: true,
      message: "Portfolio Fetched Successfully",
      portfolio,
    });
  },
);

export const getMyTransactions = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (!transactions) {
      return next(new ErrorHandler("Transactions Not Found", 404));
    }

    res.status(200).json({
      success: true,
      message: "Transactions Fetched Successfully",
      transactions,
    });
  },
);

export const getMyOrders = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    console.log(req.user);
    const orders = await prisma.order.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (!orders) {
      return next(new ErrorHandler("Orders Not Found", 404));
    }
    res.status(200).json({
      success: true,
      message: "Orders Fetched Successfully",
      orders,
    });
  },
);

export const logout = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    res
      .clearCookie("token", { ...cookieOptions, maxAge: 0 })
      .json({ success: true, message: "Logout successful" });
  },
);

export const check = TryCatch(
  async (req: any, res: Response, next: NextFunction) => {
    res.send("hello");
  },
);

/**
 * Step 1 – Request password reset: generates a 6-digit OTP and emails it.
 */
export const requestPasswordReset = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email } = req.body;
    if (!email) return next(new ErrorHandler("Email is required", 400));

    const normalisedEmail = String(email).trim().toLowerCase();

    // Generic response either way, so the endpoint can't be used to test which
    // addresses have accounts.
    const genericResponse = {
      success: true,
      message: "If that email exists, an OTP has been sent.",
    };

    // Cooldown: without it this endpoint is an unauthenticated email-send
    // amplifier pointed at any address the caller chooses (S-10).
    //
    // SET NX EX is the check and the claim in one atomic round trip, so two
    // requests arriving at two replicas in the same millisecond cannot both
    // decide they are first. A null reply means someone already holds it.
    const claimed = await otpRedis(() =>
      rCmd.set(
        otpCooldownKey(normalisedEmail),
        "1",
        "EX",
        OTP_RESEND_COOLDOWN_SECONDS,
        "NX",
      ),
    );
    if (claimed === null) {
      return res.status(429).json({
        success: false,
        message: "An OTP was just sent. Please wait a minute before retrying.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalisedEmail },
    });
    if (!user) {
      return res.status(200).json(genericResponse);
    }

    // crypto.randomInt, not Math.random — this is a credential-reset token.
    const otp = String(crypto.randomInt(100000, 1000000));
    const now = Date.now();
    const record: OtpRecord = {
      otp,
      expiresAt: now + OTP_TTL_MS,
      issuedAt: now,
      attempts: 0,
    };

    await otpRedis(() =>
      rCmd.set(
        otpKey(normalisedEmail),
        JSON.stringify(record),
        "EX",
        OTP_TTL_SECONDS,
      ),
    );
    // A new code gets a new attempt budget, and this is also what stops a
    // counter left behind by a burnt-out OTP from being charged against it.
    await otpRedis(() => rCmd.del(otpAttemptsKey(normalisedEmail)));

    await sendOtpEmail(normalisedEmail, otp);

    res.status(200).json(genericResponse);
  },
);

/**
 * Step 2 – Reset password: validates OTP and updates password.
 */
export const resetPasswordWithOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword)
      return next(
        new ErrorHandler("email, otp and newPassword are required", 400),
      );

    if (newPassword.length < 6)
      return next(
        new ErrorHandler("Password must be at least 6 characters", 400),
      );

    const normalisedEmail = String(email).trim().toLowerCase();

    // An expired OTP has been deleted by Redis rather than merely being past a
    // stored timestamp, so "expired" and "never issued" are the same answer
    // here: request a new one.
    const raw = await otpRedis(() => rCmd.get(otpKey(normalisedEmail)));
    const record = raw ? safeParseOtpRecord(raw) : null;
    if (!record)
      return next(
        new ErrorHandler(
          "No OTP found for this email. Please request a new one.",
          400,
        ),
      );

    // Attempt cap. A 6-digit code with unlimited guesses inside a 10-minute
    // window is 900k possibilities against no resistance at all (S-10).
    //
    // INCR, not an `attempts` field inside the record: read-modify-write on the
    // stored JSON races both across replicas and across parallel requests on one
    // replica, so an attacker firing 50 guesses at once would land all 50 before
    // any of them wrote a count back. INCR is the whole cap in one operation.
    // The counter carries the OTP's TTL so it cannot outlive the code it guards.
    const attempts = await otpRedis(async () => {
      const key = otpAttemptsKey(normalisedEmail);
      const n = await rCmd.incr(key);
      if (n === 1) await rCmd.expire(key, OTP_TTL_SECONDS);
      return n;
    });

    if (attempts > OTP_MAX_ATTEMPTS) {
      await otpRedis(() => rCmd.del(otpKey(normalisedEmail)));
      return next(
        new ErrorHandler(
          "Too many incorrect attempts. Please request a new OTP.",
          429,
        ),
      );
    }

    if (!timingSafeEqualStr(record.otp, String(otp))) {
      return next(new ErrorHandler("Invalid OTP.", 400));
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email: normalisedEmail },
      data: { password: hashedPassword },
    });

    // OTP consumed. The cooldown key is deliberately left in place: a used code
    // is no reason to reopen the email-send amplifier for another minute.
    await otpRedis(() =>
      rCmd.del(otpKey(normalisedEmail), otpAttemptsKey(normalisedEmail)),
    );

    res.status(200).json({
      success: true,
      message: "Password reset successfully.",
    });
  },
);

/**
 * Refresh Token endpoint
 * Generates a new access/refresh token pair using a valid refresh token
 */
export const refreshToken = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { refreshToken: token } = req.body;

    if (!token) {
      return next(new ErrorHandler("Refresh token is required", 400));
    }

    // Verify the refresh token
    const decoded = verifyRefreshToken(token);
    if (!decoded) {
      return next(new ErrorHandler("Invalid or expired refresh token", 401));
    }

    // Check if user still exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });
    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    // Generate new token pair
    const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(
      user.id,
    );

    res.status(200).json({
      success: true,
      message: "Token refreshed successfully",
      accessToken,
      refreshToken: newRefreshToken,
    });
  },
);

/**
 * Update user profile (name and/or password)
 */
export const updateProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req?.user?.id) {
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    }

    const { name, currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    const updateData: { name?: string; password?: string } = {};

    // Update name if provided
    if (name && name.trim()) {
      updateData.name = name.trim();
    }

    // Update password if both current and new are provided
    if (newPassword) {
      if (!currentPassword) {
        return next(
          new ErrorHandler(
            "Current password is required to change password",
            400,
          ),
        );
      }

      const isPasswordMatched = await bcrypt.compare(
        currentPassword,
        user.password,
      );
      if (!isPasswordMatched) {
        return next(new ErrorHandler("Current password is incorrect", 400));
      }

      if (newPassword.length < 6) {
        return next(
          new ErrorHandler("New password must be at least 6 characters", 400),
        );
      }

      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    if (Object.keys(updateData).length === 0) {
      return next(new ErrorHandler("No updates provided", 400));
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
    });

    // Exclude password from response
    const { password: _, ...userWithoutPassword } = updatedUser;

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: userWithoutPassword,
    });
  },
);

/**
 * Profit/Loss statistics.
 *
 * CAVEAT (review S-19): `realizedPL` here is `totalSell - totalBuy` — net cash
 * flow, not realised profit. A position that is still open counts as a full
 * loss until it is sold, so a user who has only ever bought sees a large
 * negative number. The arithmetic is right; the label is misleading.
 *
 * Computing true realised P/L means matching each sell against the cost basis
 * of the lots it closes (FIFO or average). Left as-is deliberately because all
 * three clients render this field today and changing its meaning silently would
 * be worse than the current inaccuracy.
 */
export const getProfitLoss = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler("Please login first", 401));
    }
    const userId = req.user.id;
    const { days } = req.query;

    // Calculate date range (default: 365 days).
    // Guarded: `?days=abc` used to yield NaN, which made setDate produce an
    // Invalid Date and Prisma throw a 500 on the `gte` filter (S-19).
    const parsedDays = days !== undefined ? Number(days) : 365;
    if (!Number.isFinite(parsedDays) || parsedDays < 1) {
      return next(
        new ErrorHandler("days must be a positive number of days", 400),
      );
    }
    const daysNum = Math.min(Math.floor(parsedDays), 3650); // cap at ~10 years
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    // Fetch all orders within date range
    const orders = await prisma.order.findMany({
      where: {
        userId,
        status: "completed",
        createdAt: {
          gte: startDate,
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Calculate P/L per symbol
    const symbolStats: Record<
      string,
      {
        totalBuy: number;
        totalSell: number;
        buyVolume: number;
        sellVolume: number;
        buyCount: number;
        sellCount: number;
      }
    > = {};

    for (const order of orders) {
      const symbol = order.stockSymbol;

      if (!symbolStats[symbol]) {
        symbolStats[symbol] = {
          totalBuy: 0,
          totalSell: 0,
          buyVolume: 0,
          sellVolume: 0,
          buyCount: 0,
          sellCount: 0,
        };
      }

      if (order.type === "buy") {
        symbolStats[symbol].totalBuy += order.stockTotal;
        symbolStats[symbol].buyVolume += order.stockQuantity;
        symbolStats[symbol].buyCount++;
      } else {
        symbolStats[symbol].totalSell += order.stockTotal;
        symbolStats[symbol].sellVolume += order.stockQuantity;
        symbolStats[symbol].sellCount++;
      }
    }

    // Calculate overall statistics
    let realizedPL = 0;
    let totalBuyAmount = 0;
    let totalSellAmount = 0;
    let totalBuyCount = 0;
    let totalSellCount = 0;

    const symbolBreakdown = Object.entries(symbolStats).map(
      ([symbol, stats]) => {
        const symbolPL = stats.totalSell - stats.totalBuy;
        realizedPL += symbolPL;
        totalBuyAmount += stats.totalBuy;
        totalSellAmount += stats.totalSell;
        totalBuyCount += stats.buyCount;
        totalSellCount += stats.sellCount;

        return {
          symbol,
          realizedPL: symbolPL,
          totalBuy: stats.totalBuy,
          totalSell: stats.totalSell,
          buyVolume: stats.buyVolume,
          sellVolume: stats.sellVolume,
          buyCount: stats.buyCount,
          sellCount: stats.sellCount,
        };
      },
    );

    // Daily realized P/L, for the account page's chart.
    //
    // The chart is a date axis, but this endpoint only ever returned per-symbol
    // totals — so the client synthesised a timeline by walking backwards one day
    // per array index, labelling the first symbol "today", the second
    // "yesterday", and so on. Every date on that chart was fiction.
    //
    // Same definition as the total above (sells minus buys) so that
    // sum(dailyPL) === realizedPL exactly; the chart and the stat card beside it
    // can never disagree. Asserted in tests/profitLoss.test.ts.
    const dailyTotals = new Map<string, number>();
    for (const order of orders) {
      const day = istDayKey(order.createdAt);
      const delta =
        order.type === "buy" ? -order.stockTotal : order.stockTotal;
      dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + delta);
    }

    // Zero-fill every day in the window. A day with no trades is a real zero,
    // not a gap — and filling it here means the client never has to invent a
    // data point, which is the failure this replaces.
    const dailyPL: Array<{ date: string; value: number }> = [];
    const cursor = new Date(startDate);
    const todayKey = istDayKey(new Date());
    for (let i = 0; i <= daysNum; i++) {
      const key = istDayKey(cursor);
      dailyPL.push({ date: key, value: dailyTotals.get(key) ?? 0 });
      if (key === todayKey) break;
      cursor.setDate(cursor.getDate() + 1);
    }

    res.status(200).json({
      success: true,
      data: {
        realizedPL,
        totalBuyAmount,
        totalSellAmount,
        totalBuyCount,
        totalSellCount,
        totalTrades: totalBuyCount + totalSellCount,
        avgTradeSize:
          totalBuyCount + totalSellCount > 0
            ? (totalBuyAmount + totalSellAmount) /
              (totalBuyCount + totalSellCount)
            : 0,
        dailyPL,
        symbolBreakdown,
        period: `${daysNum} days`,
      },
    });
  },
);
