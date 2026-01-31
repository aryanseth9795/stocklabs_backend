// ---------------------------- app.ts ----------------------------
// Relay server: one Binance WS in, many Socket.IO clients out.
// ◆ Keeps a single upstream WebSocket to Binance for *all* tracked symbols.
// ◆ Caches the latest tick per stream in Redis (snapshot).
// ◆ Publishes each tick on Redis Pub/Sub (horizontal scaling).
// ◆ Maintains an in-memory **Top-50 board** (depth mid-price only).
// ◆ Every client automatically receives the board; portfolio symbols are optional.

import { createServer } from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "dotenv";
import { Server } from "socket.io";
import RedisPkg from "ioredis";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import errorMiddleware from "./src/middlewares/errorMiddleware.js";
import { TOP50 } from "./src/constants/StockList.js";
import userRoute from "./src/routes/userRoute.js";
import { Row } from "./src/types/types.js";
import ErrorHandler from "./src/middlewares/ErrorHandler.js";
import type { Socket } from "socket.io";
import cookie from "cookie";
import prisma from "./src/db/db.js";
import axios from "axios";

config(); // load .env

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const JWT_SECRET = process.env.JWT_SECRET || "aryanseth";
const USD_INR = Number(process.env.USD_INR) || 86;
const ENVMODE = process.env.NODE_ENV || "DEVELOPMENT";

console.log(`Starting relay in ${ENVMODE} mode...`);
const Redis: any = (RedisPkg as any).default || RedisPkg;
const rCmd = new Redis(REDIS_URL);
const rSub = new Redis(REDIS_URL);

const BOARD = TOP50;
const BOARD_STREAM = BOARD.map((s) => `${s.toLowerCase()}@ticker`).join("/");

const corsOptions: {
  origin: string[];
  methods: string[];
  credentials: boolean;
  sameSite?: string;
} = {
  origin: ["https://stocklabs.aryantechie.in", CLIENT_URL],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
};

// Setting SameSite to None in Production
if (ENVMODE !== "DEVELOPMENT") {
  corsOptions.sameSite = "None";
  // cookieOptions.sameSite = "None";
}

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.get("/ping", (req, res) => {
  res.json({ message: "Server is running" });
});

app.use("/api/v1/", userRoute);
app.use(errorMiddleware);

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [CLIENT_URL, "https://stocklabs.aryantechie.in"],
    credentials: true,
  },
});

//in-memory board cache
const boardCache: Record<string, Row> = {};
const boardSnapshot = () => BOARD.map((s) => boardCache[s]).filter(Boolean);

//// helper: fetch all 50 from Redis and log
async function logTop50FromRedis() {
  const keys = BOARD.map((s) => `tick:${s.toLowerCase()}-ticker`);
  const raws: (string | null)[] = await rCmd.mget(keys);
  const rows: Row[] = raws
    .filter((r): r is string => Boolean(r))
    .map((r) => JSON.parse(r));
  console.log("=== TOP 50 SNAPSHOT ===");
  console.table(rows);
}

// log once on startup, then every minute
logTop50FromRedis().catch(console.error);
setInterval(() => logTop50FromRedis().catch(console.error), 60 * 1000);

//// normalize incoming ticker data
function normaliseTicker(t: any): Row {
  const priceUsd = +t.c;
  const changeUsd = +t.p;
  return {
    stockName: `${t.s.toLowerCase()}`,
    stocksymbol: t.s,
    stockPrice: priceUsd,
    stockPriceINR: +(priceUsd * USD_INR).toFixed(2),
    stockChange: changeUsd,
    stockChangeINR: +(changeUsd * USD_INR).toFixed(2),
    stockChangePercentage: +t.P,
    ts: new Date().toLocaleTimeString(),
  };
}

const liveUpstream = new Set<string>(BOARD);

const upstream = new WebSocket(
  `wss://fstream.binance.com/stream?streams=${BOARD_STREAM}`,
);
upstream.on("message", async (buf) => {
  const { data } = JSON.parse(buf.toString());
  const row = normaliseTicker(data);
  await rCmd
    .pipeline()
    .set(`tick:${row.stockName}`, JSON.stringify(row))
    .publish(`tick.${row.stockName}`, JSON.stringify(row))
    .exec();
});

//// Redis → Socket.IO
rSub.psubscribe("tick.*");
rSub.on("pmessage", (_pattern: string, _channel: string, raw: string) => {
  const row: Row = JSON.parse(raw);
  const sym = row.stockName.split("-")[0].toUpperCase();
  io.to(row.stockName).emit("tick", row);
  if (BOARD.includes(sym)) {
    boardCache[sym] = row;
    io.to("top50").emit("board", boardSnapshot());
  }
});

//// track online users
const userSockets = new Map<string, string>();
const guestSockets = new Set<string>();
setInterval(
  () =>
    console.table({
      time: new Date().toLocaleTimeString(),
      users: userSockets.size,
      guests: guestSockets.size,
      total: userSockets.size + guestSockets.size,
      id: guestSockets.size ? Array.from(guestSockets)[0] : null,
    }),
  60 * 1_000,
);

io.use((socket: Socket, next) => {
  try {
    let token: string | undefined;

    // Priority 1: Check auth object (mobile clients)
    if (socket.handshake.auth?.token) {
      token = socket.handshake.auth.token;
    }
    // Priority 2: Check query params (fallback)
    else if (socket.handshake.query?.token) {
      token = socket.handshake.query.token as string;
    }
    // Priority 3: Check cookies (web clients)
    else {
      const raw = socket.handshake.headers.cookie ?? "";
      const parsed = cookie.parse(raw);
      token = parsed.token;
    }

    if (!token) return next(); // Allow guest connections

    // Try to verify token
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    socket.data.userId = String(decoded.userId);
    console.log("Socket connected with user ID:", socket.data.userId);
    next();
  } catch (err) {
    // Token invalid/expired - still allow connection as guest
    console.log("Socket auth failed:", (err as Error).message);
    next();
  }
});

const PORTFOLIO_POLL_MS = 2000;

type Portfolio = {
  id: string;
  userId: string;
  stockSymbol: string;
  stockQuantity: number;
  stockPrice: number;
  stockTotal: number;
  createdAt: Date;
  updatedAt: Date;
};

type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  email: string;
  balance: number;
};

async function getPortfolioSymbols(
  userId: string,
): Promise<[User, Portfolio[], string[]]> {
  const portfolios = await prisma.portfolio.findMany({
    where: { userId },
  });
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error("User not found");
  }
  const userInfo = {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    balance: user.balance,
  };
  return [
    userInfo,
    portfolios,
    portfolios.map((p: Portfolio) => p.stockSymbol as string),
  ];
}

io.on("connection", async (sock) => {
  const uid = sock.data.userId as string | undefined;
  console.log("New socket connection:", sock.id, "User ID:", uid);
  if (uid) {
    if (userSockets.has(uid))
      io.sockets.sockets.get(userSockets.get(uid)!)?.disconnect();
    userSockets.set(uid, sock.id);
  } else {
    guestSockets.add(sock.id);
  }

  sock.on("landing", () => {
    console.log("landing");

    // send once right away
    sock.emit("landing", boardSnapshot());

    // clear old poller if user re-triggers
    if (sock.data?.landingPoll) {
      clearInterval(sock.data.landingPoll as NodeJS.Timeout);
    }

    // start new poller
    sock.data = sock.data || {};
    sock.data.landingPoll = setInterval(() => {
      try {
        sock.emit("landing", boardSnapshot());
      } catch {
        /* noop */
      }
    }, 2000);
  });

  // optional manual stop from client
  sock.on("landing:stop", () => {
    if (sock.data?.landingPoll)
      clearInterval(sock.data.landingPoll as NodeJS.Timeout);
    sock.data.landingPoll = undefined;
  });

  // add (optional) wire type near your other types
  type PortfolioTickBatch = {
    ts: string; // ISO send time
    ticks: Row[]; // all wanted symbols in one shot
  };

  sock.on("portfolio", async () => {
    if (!uid) {
      sock.emit("error", new ErrorHandler("Unauthorized: Please log in.", 401));
      return;
    }

    const [userdata, positions, symbols] = await getPortfolioSymbols(uid);
    const want = new Set(symbols.map((s) => s.toUpperCase()));
    const symOf = (row: Row) =>
      (row.stocksymbol || row.stockName?.split("-")[0] || "").toUpperCase();

    // 1) send static data ONCE (unchanged)
    sock.emit("Portfolio_info", { userdata, positions });

    // helper to build one combined tick batch (Top-50 cache only)
    const buildBatch = (): PortfolioTickBatch => {
      const snap = boardSnapshot(); // array<Row> from in-memory board cache
      const ticks = snap.filter((row) => want.has(symOf(row)));
      return { ts: new Date().toISOString(), ticks };
    };

    // 2) initial one-shot batch (no per-symbol emits)
    sock.emit("portfolio:batch", buildBatch());

    // 3) clear any old poller and start a new interval that sends ONE batch each tick
    if (sock.data?.portfolioPoll)
      clearInterval(sock.data.portfolioPoll as NodeJS.Timeout);

    sock.data = sock.data || {};
    sock.data.portfolioPoll = setInterval(() => {
      try {
        sock.emit("portfolio:batch", buildBatch());
        console.log("Initial portfolio batch sent:", buildBatch());
      } catch {
        console.log("Portfolio batch emit failed");
      }
    }, PORTFOLIO_POLL_MS); // set to 1000 for 1s if you want
  });

  sock.on("portfolio:stop", () => {
    if (sock.data?.portfolioPoll)
      clearInterval(sock.data.portfolioPoll as NodeJS.Timeout);
    sock.data.portfolioPoll = undefined;
  });
  sock.on("disconnect", () => {
    // stop portfolio poller if running
    if (sock.data?.portfolioPoll) {
      clearInterval(sock.data.portfolioPoll as NodeJS.Timeout);
      sock.data.portfolioPoll = undefined;
    }

    // (optional) if you ever add a landing poller, clear it too
    if (sock.data?.landingPoll) {
      clearInterval(sock.data.landingPoll as NodeJS.Timeout);
      sock.data.landingPoll = undefined;
    }

    // your existing bookkeeping
    if (uid) userSockets.delete(uid);
    else guestSockets.delete(sock.id);
  });
});

function ping(){
  axios.get(process.env.API_URL  + "/ping").then((res) => {
    console.log(res.data);
  });
}

setInterval(ping, 12000);


server.listen(PORT, () => {
  console.log(`Relay ready on http://localhost:${PORT}  •  ₹ rate=${USD_INR}`);
});
