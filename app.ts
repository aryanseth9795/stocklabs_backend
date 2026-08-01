// ---------------------------- app.ts ----------------------------
// Relay server: one Binance WS in, many Socket.IO clients out.
// ◆ Keeps a single upstream WebSocket to Binance for *all* tracked symbols.
// ◆ Caches the latest tick per stream in Redis (snapshot).
// ◆ Publishes each tick on Redis Pub/Sub (horizontal scaling).
// ◆ Maintains an in-memory **Top-50 board** (depth mid-price only).
// ◆ Every client automatically receives the board; portfolio symbols are optional.

// Loads .env before ANY other import is evaluated. Under ESM every import below
// runs to completion before this module's body, so calling dotenv's config() in
// the body left modules like src/utils/token.ts reading an empty process.env
// and falling back to hardcoded secrets — see review S-01.
import "dotenv/config";

import { createServer } from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import RedisPkg from "ioredis";
import WebSocket from "ws";
import errorMiddleware from "./src/middlewares/errorMiddleware.js";
import { TOP50 } from "./src/constants/StockList.js";
import userRoute from "./src/routes/userRoute.js";
import shortRoute from "./src/routes/shortRoute.js";
import commodityRoute from "./src/routes/commodityRoute.js";
import { Row } from "./src/types/types.js";
import { startAutoCutJob } from "./src/utils/autoCutJob.js";
import { startCommodityFeed } from "./src/utils/commodityFeed.js";
import {
  boardCache,
  boardSnapshot as buildBoardSnapshot,
  tickKey,
} from "./src/utils/priceCache.js";
import type { Socket } from "socket.io";
import cookie from "cookie";
import prisma from "./src/db/db.js";
import axios from "axios";
import { getUsdInrRate, usdToInr } from "./src/utils/exchangeRate.js";
import { env } from "./src/config/env.js";
import { verifyAccessToken } from "./src/utils/token.js";

const PORT = env.PORT;
const CLIENT_URL = env.CLIENT_URL;
const REDIS_URL = env.REDIS_URL;
// USD_INR is now fetched dynamically – see src/utils/exchangeRate.ts
const ENVMODE = env.NODE_ENV;

console.log(`Starting relay in ${ENVMODE} mode...`);
const Redis: any = (RedisPkg as any).default || RedisPkg;
const rCmd = new Redis(REDIS_URL);
const rSub = new Redis(REDIS_URL);

const BOARD = TOP50;
const BOARD_STREAM = BOARD.map((s) => `${s.toLowerCase()}@ticker`).join("/");

// Note: `sameSite` is a cookie attribute, not a CORS option — it used to be set
// here and was silently ignored by the cors package. It lives in cookieOptions
// in userController.ts, which is where it actually takes effect (S-22).
const corsOptions = {
  origin: ["https://stocklabs.aryantechie.in", CLIENT_URL],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.get("/ping", (req, res) => {
  res.json({ message: "Server is running" });
});

app.use("/api/v1/", userRoute);
app.use("/api/v1/short", shortRoute);
app.use("/api/v1/commodity", commodityRoute);

// JSON 404 for unmatched routes, so clients get the same content type they get
// everywhere else instead of Express's default HTML error page (S-23).
app.use((req, res) => {
  res
    .status(404)
    .json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
});

app.use(errorMiddleware);

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow all origins (including mobile apps without an origin)
      callback(null, true);
    },
    credentials: true,
  },
});

// The board cache lives in src/utils/priceCache.ts so controllers can read live
// prices without importing app.ts (which would be a cycle). Re-exported here for
// backwards compatibility with anything that imported it from this module.
export { boardCache };
const boardSnapshot = () => buildBoardSnapshot(BOARD);

startAutoCutJob();

// The server is the price authority for commodities, so it keeps its own
// upstream subscription rather than depending on a client being connected
// (review A-01).
startCommodityFeed();

//// helper: fetch all 50 from Redis and log
async function logTop50FromRedis() {
  // tickKey() is the single definition of this key shape. Reader and writer used
  // to build it independently and disagreed — the reader appended "-ticker", so
  // every mget returned nulls and this snapshot was always empty (S-14).
  const keys = BOARD.map((s) => tickKey(s));
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
// Binance quotes in USD; the platform trades in rupees. The INR fields are the
// authoritative ones — everything that touches money (fills, balances, P&L, in
// both clients) reads *INR. The raw USD values are carried along for reference
// only and must not be used in any calculation.
function normaliseTicker(t: any): Row {
  const priceUsd = +t.c;
  const changeUsd = +t.p;
  return {
    stockName: `${t.s.toLowerCase()}`,
    stocksymbol: t.s,
    stockPrice: priceUsd, // informational only
    stockPriceINR: usdToInr(priceUsd),
    stockChange: changeUsd, // informational only
    stockChangeINR: usdToInr(changeUsd),
    stockChangePercentage: +t.P,
    ts: new Date().toLocaleTimeString(),
  };
}

let upstream: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

function connectBinanceUpstream() {
  // Detach handlers BEFORE terminating. The old socket's `close` handler was
  // still attached when we terminated it, so it scheduled its own reconnect on
  // top of the one already in flight — each cycle could leave an extra live
  // upstream connection behind, all writing the same Redis keys (S-15).
  if (upstream) {
    upstream.removeAllListeners();
    upstream.terminate();
    upstream = null;
  }

  console.log("[Binance WS] Connecting upstream...");
  const ws = new WebSocket(
    `wss://fstream.binance.com/stream?streams=${BOARD_STREAM}`,
  );
  upstream = ws;

  ws.on("open", () => {
    console.log("[Binance WS] Connected upstream");
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  ws.on("message", async (buf) => {
    try {
      const parsed = JSON.parse(buf.toString());
      if (!parsed.data) return;
      const row = normaliseTicker(parsed.data);
      await rCmd
        .pipeline()
        .set(tickKey(row.stockName), JSON.stringify(row))
        .publish(`tick.${row.stockName}`, JSON.stringify(row))
        .exec();
    } catch (err) {
      console.error("[Binance WS] message processing error:", err);
    }
  });

  ws.on("close", () => {
    // Ignore a close from a socket we've already replaced.
    if (upstream !== ws) return;
    console.warn("[Binance WS] Connection closed. Reconnecting...");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error(`[Binance WS] Error: ${(err as Error).message}`);
    // Let the `close` handler drive the reconnect — terminating here as well
    // is what produced overlapping reconnect attempts.
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  // Exponential backoff, so a sustained upstream outage doesn't turn into a
  // fixed-rate hammer on Binance (which rate-limits connections per IP).
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempts,
    RECONNECT_MAX_MS,
  );
  reconnectAttempts += 1;
  console.warn(`[Binance WS] Reconnecting in ${delay / 1000}s`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBinanceUpstream();
  }, delay);
}

connectBinanceUpstream();

//// Redis → Socket.IO
const BOARD_ROOM = "top50";
const BOARD_BROADCAST_MS = 1000;
let boardDirty = false;

rSub.psubscribe("tick.*");
rSub.on("pmessage", (_pattern: string, _channel: string, raw: string) => {
  try {
    const row: Row = JSON.parse(raw);
    const sym = (row.stocksymbol || row.stockName).toUpperCase();
    if (BOARD.includes(sym)) {
      boardCache[sym] = row;
      boardDirty = true;
    }
  } catch (err) {
    console.error("[Redis] pmessage parse error:", err);
  }
});

// The board used to be re-serialised and emitted on EVERY upstream tick — 50
// symbols at several ticks per second — to a room nobody ever joined, because
// nothing in the codebase called socket.join() (S-13). Now clients opt in via
// "board:subscribe", and the broadcast is throttled and skipped when idle.
setInterval(() => {
  if (!boardDirty) return;
  const room = io.sockets.adapter.rooms.get(BOARD_ROOM);
  if (!room || room.size === 0) return;

  boardDirty = false;
  io.to(BOARD_ROOM).emit("board", boardSnapshot());
}, BOARD_BROADCAST_MS);

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

    // Same verification path as the HTTP middleware, so a token that works for
    // REST also works for sockets. These used different secrets before (S-01),
    // which silently demoted every authenticated web client to a guest.
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      console.log("Socket auth failed: invalid or expired token");
      return next(); // still allowed, as a guest
    }

    socket.data.userId = String(decoded.userId);
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

  // Opt in / out of the throttled Top-50 board broadcast. Without a join the
  // "board" event went to an empty room and no client ever received it (S-13).
  sock.on("board:subscribe", () => {
    sock.join(BOARD_ROOM);
    sock.emit("board", boardSnapshot()); // immediate first paint
  });

  sock.on("board:unsubscribe", () => {
    sock.leave(BOARD_ROOM);
  });

  // add (optional) wire type near your other types
  type PortfolioTickBatch = {
    ts: string; // ISO send time
    ticks: Row[]; // all wanted symbols in one shot
  };

  sock.on("portfolio", async () => {
    if (!uid) {
      // Error instances don't serialise over Socket.IO — the client received an
      // empty object. Send a plain payload it can actually read.
      sock.emit("error", {
        message: "Unauthorized: Please log in.",
        statusCode: 401,
      });
      return;
    }

    // getPortfolioSymbols throws when the user row is missing. Inside an async
    // Socket.IO listener nothing catches that, and an unhandled rejection can
    // take the whole process down (S-09).
    try {
      const [userdata, positions, symbols] = await getPortfolioSymbols(uid);
      const want = new Set(symbols.map((s) => s.toUpperCase()));
      const symOf = (row: Row) =>
        (row.stocksymbol || row.stockName || "").toUpperCase();

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
          // Built once. It used to be built twice — once to emit, once to log —
          // and the full payload was logged for every client every 2s (S-16).
          sock.emit("portfolio:batch", buildBatch());
        } catch {
          /* client went away between ticks; disconnect handler will clean up */
        }
      }, PORTFOLIO_POLL_MS);
    } catch (err) {
      console.error("[Socket] portfolio handler failed:", err);
      sock.emit("error", {
        message: "Could not load portfolio. Please try again.",
        statusCode: 500,
      });
    }
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

    // Bookkeeping. Only clear the map entry if it still points at THIS socket —
    // a reconnect may already have replaced it (see review D-5).
    if (uid) {
      if (userSockets.get(uid) === sock.id) userSockets.delete(uid);
    } else {
      guestSockets.delete(sock.id);
    }
  });
});

/**
 * Keeps a free-tier host from idling out. Skipped entirely when API_URL is
 * unset — it used to request "undefined/ping" every 12 minutes with no .catch,
 * so every call was an unhandled rejection (S-09).
 */
function ping() {
  if (!env.API_URL) return;
  axios
    .get(`${env.API_URL}/ping`)
    .then((res) => console.log("[Ping]", res.data))
    .catch((err) => console.warn("[Ping] failed:", err.message));
}

if (env.API_URL) {
  setInterval(ping, 720000);
} else {
  console.log("[Ping] API_URL not set — self-ping disabled.");
}

// Last line of defence. Without these, one stray rejection anywhere in the
// socket or job code takes the process down with no usable diagnostic (S-09).
process.on("unhandledRejection", (reason) => {
  console.error("[Fatal] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
});

// The exchange rate is a constant now, so there is nothing to seed and no
// network call to await before accepting traffic.
server.listen(PORT, () => {
  console.log(
    `Relay ready on http://localhost:${PORT}  •  USD/INR fixed at ${getUsdInrRate()}`,
  );
});
