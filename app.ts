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

config(); // load .env

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const USD_INR = Number(process.env.USD_INR) || 86;

const Redis: any = (RedisPkg as any).default || RedisPkg;
const rCmd = new Redis(REDIS_URL);
const rSub = new Redis(REDIS_URL);

const BOARD = TOP50;
const BOARD_STREAM = BOARD.map((s) => `${s.toLowerCase()}@ticker`).join("/");

const app = express();
app.use(cors({ origin: [CLIENT_URL], credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use("/api/v1/", userRoute);
app.use(errorMiddleware);

const server = createServer(app);
const io = new Server(server, {
  cors: { origin: [CLIENT_URL], credentials: true },
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

function subscribeUpstream(symbols: string[]) {
  const params = symbols
    .filter((sym) => !liveUpstream.has(sym))
    .map((sym) => `${sym.toLowerCase()}@ticker`);
  if (!params.length) return;
  upstream.send(
    JSON.stringify({ method: "SUBSCRIBE", params, id: Date.now() })
  );
  params.forEach((p) => liveUpstream.add(p.split("@")[0].toUpperCase()));
}

const upstream = new WebSocket(
  `wss://fstream.binance.com/stream?streams=${BOARD_STREAM}`
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
  60 * 1_000
);

io.use((socket: Socket, next) => {
  try {
    const raw = socket.handshake.headers.cookie ?? "";
    const { token } = cookie.parse(raw);
    if (!token) return next();
    const { userId } = jwt.verify(token, JWT_SECRET) as { userId: string };
    socket.data.userId = String(userId);
    next();
  } catch {
    next();
  }
});

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

  // sock.join("top50");
  // sock.emit("board", boardSnapshot());

  // sock.on("landing", async () => {
  //   console.log("landing");
  //   sock.emit("landing", boardSnapshot());
  //   setInterval(() => {
  //     sock.emit("landing", boardSnapshot());
  //   }, 2000);
  // });
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

//   sock.on("portfolio", async () => {
//     console.log("portfolio");
//     if (uid) {
//       const [data, symbols] = await getPortfolioSymbols(uid);
//       const rooms = symbols.map((s) => `${s.toLowerCase()}-ticker`);
//       rooms.forEach((r: string) => sock.join(r));
//       subscribeUpstream(symbols);
//       const raws = await rCmd.mget(rooms.map((r) => `tick:${r}`));
//       raws.forEach(
//         (r: string | null) => r && sock.emit("Port_received", JSON.parse(r))
//       );
//     } else {
//       sock.emit("error", new ErrorHandler("Unauthorized: Please log in.", 401));
//     }
//   // });

//   sock.on("disconnect", () => {
//     // stop portfolio poller if running
//     if (sock.data?.portfolioPoll) {
//       clearInterval(sock.data.portfolioPoll as NodeJS.Timeout);
//       sock.data.portfolioPoll = undefined;
//     }

//     // (optional) if you ever add a landing poller, clear it too
//     if (sock.data?.landingPoll) {
//       clearInterval(sock.data.landingPoll as NodeJS.Timeout);
//       sock.data.landingPoll = undefined;
//     }

//     // your existing bookkeeping
//     if (uid) userSockets.delete(uid);
//     else guestSockets.delete(sock.id);
//   });
// });

// const boardSnapshot = () => Object.values(boardCache);
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


const PORTFOLIO_POLL_MS = 1000;

sock.on("portfolio", async () => {
  console.log("portfolio");
  if (!uid) {
    sock.emit("error", new ErrorHandler("Unauthorized: Please log in.", 401));
    return;
  }

  const [data, symbols] = await getPortfolioSymbols(uid);
  const want = new Set(symbols.map((s) => s.toUpperCase()));

  // helper to normalize symbol from Row
  const symOf = (row: Row) =>
    (row.stocksymbol || row.stockName?.split("-")[0] || "").toUpperCase();

  // initial push from current board snapshot (no upstream, no redis)
  const snapNow = boardSnapshot();
  snapNow.forEach((row) => {
    if (want.has(symOf(row))) sock.emit("Port_received", row);
  });

  // one-time portfolio info (you already prepared it as `data`)
  sock.emit("Portfolio_info", data);

  // avoid duplicate intervals if client re-triggers "portfolio"
  if (sock.data?.portfolioPoll) clearInterval(sock.data.portfolioPoll as NodeJS.Timeout);

  // start 1s polling from in-memory board cache only
  sock.data = sock.data || {};
  sock.data.portfolioPoll = setInterval(() => {
    try {
      const snap = boardSnapshot(); // array<Row> built from boardCache (Top50 only)
      for (const row of snap) {
        if (want.has(symOf(row))) {
          sock.emit("Port_received", row);
        }
      }
    } catch {
      /* optional: log */
    }
  }, PORTFOLIO_POLL_MS);
});

// optional manual stop
sock.on("portfolio:stop", () => {
  if (sock.data?.portfolioPoll) clearInterval(sock.data.portfolioPoll as NodeJS.Timeout);
  sock.data.portfolioPoll = undefined;
});

async function getPortfolioSymbols(
  userId: string
): Promise<[Portfolio[], string[]]> {
  const portfolios = await prisma.portfolio.findMany({
    where: { userId },
  });
  return [portfolios, portfolios.map((p) => p.stockSymbol)];
}

console.log("Server started");
server.listen(PORT, () =>
  console.log(`Relay ready on http://localhost:${PORT}  •  ₹ rate=${USD_INR}`)
);
