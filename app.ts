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

// Neither client had ANY listener attached. ioredis emits "error" rather than
// throwing, so a subscriber that never reconnected stayed silent forever — and
// since boardCache is fed *only* by rSub's pmessage, that failure mode looks
// exactly like an outage with no error anywhere in the log. Name the clients so
// it is obvious which side broke.
for (const [name, client] of [
  ["rCmd", rCmd],
  ["rSub", rSub],
] as const) {
  client.on("error", (err: Error) =>
    console.error(`[Redis:${name}] ${err.message}`),
  );
  client.on("end", () => console.warn(`[Redis:${name}] connection closed`));
  client.on("reconnecting", () => console.warn(`[Redis:${name}] reconnecting`));
}

/**
 * Ticks expire. Previously they were written with a bare SET, so a key survived
 * indefinitely after the feed died — the 60-second snapshot log kept printing a
 * full, healthy-looking table built entirely from frozen data while clients (who
 * read the in-memory board, not Redis) were served an empty array.
 *
 * With a TTL, the presence of a key is itself proof of freshness, which is what
 * makes boot-time hydration below safe.
 */
const TICK_TTL_SECONDS = 120;

const BOARD = TOP50;
const BOARD_STREAM = BOARD.map((s) => `${s.toLowerCase()}@ticker`).join("/");

/**
 * Binance **spot** combined-stream endpoint.
 *
 * This used to point at `wss://fstream.binance.com` (USD-M futures). That host
 * still completes the TLS and WebSocket handshake from both the deployment host
 * and a developer machine, then delivers zero messages and eventually drops with
 * code 1006 — Binance restricts derivatives by jurisdiction, and it does so
 * silently rather than refusing the upgrade. The result was an upstream that
 * looked connected in every log line while never producing a single tick.
 *
 * Spot is not geo-restricted the same way and was verified to deliver data. The
 * `@ticker` payload carries the same `s`, `c`, `p`, `P` fields normaliseTicker()
 * reads, so this is a drop-in change: the Row shape and both clients are
 * unaffected. Note this is a price feed only — the platform is paper-trading and
 * never places real orders, so spot-vs-futures pricing has no execution meaning.
 */
const BINANCE_WS_BASE = "wss://stream.binance.com:9443";

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

/** Upstream ticks received since boot, and the value at the last report. */
let upstreamMsgCount = 0;
let lastReportedMsgCount = 0;

/**
 * Boot-time warm start for the in-memory board.
 *
 * boardCache is populated only by live pub/sub, so every restart and redeploy
 * left it empty until the next upstream tick — and if the upstream was down, it
 * stayed empty forever while Redis still held data. Clients got `[]` either way.
 *
 * Keys carry a TTL now, so anything still present is younger than
 * TICK_TTL_SECONDS and safe to serve. Legacy keys written before the TTL existed
 * report a TTL of -1 (persist forever) and are deliberately skipped — those are
 * precisely the stale rows that made the old snapshot log look healthy.
 */
async function hydrateBoardFromRedis(): Promise<void> {
  const keys = BOARD.map((s) => tickKey(s));
  const raws: (string | null)[] = await rCmd.mget(keys);

  const ttlPipe = rCmd.pipeline();
  keys.forEach((k) => ttlPipe.ttl(k));
  const ttlRes: [Error | null, number][] = await ttlPipe.exec();

  let restored = 0;
  let skippedStale = 0;

  for (let i = 0; i < BOARD.length; i++) {
    const raw = raws[i];
    if (!raw) continue;

    const ttl = ttlRes?.[i]?.[1];
    if (typeof ttl !== "number" || ttl <= 0) {
      skippedStale++; // no expiry set => pre-TTL leftover, provenance unknown
      continue;
    }

    try {
      boardCache[BOARD[i]] = JSON.parse(raw) as Row;
      restored++;
    } catch {
      /* a corrupt value is not worth failing boot over */
    }
  }

  console.log(
    `[Board] hydrated ${restored}/${BOARD.length} symbols from Redis` +
      (skippedStale ? ` (skipped ${skippedStale} stale key(s) with no TTL)` : ""),
  );
}

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

  const delta = upstreamMsgCount - lastReportedMsgCount;
  lastReportedMsgCount = upstreamMsgCount;

  console.log("=== TOP 50 SNAPSHOT ===");
  console.table(rows);

  // This table reads from Redis, but every client is served from boardCache.
  // Reporting only the Redis side is what let a dead feed look healthy for so
  // long, so print both counts plus upstream throughput — the number that
  // actually says whether prices are moving.
  console.log(
    `[Board] redis=${rows.length}/${BOARD.length} ` +
      `memory=${Object.keys(boardCache).length}/${BOARD.length} ` +
      `upstreamTicks(last interval)=${delta}`,
  );

  if (delta === 0) {
    console.error(
      "[Board] NO upstream ticks in the last interval — the price feed is DOWN. " +
        "Clients are being served an empty board and trades will be refused with 503.",
    );
  }
}

// Warm the board from Redis before the first snapshot log, so a redeploy does
// not serve an empty board to every connected client until the next tick.
hydrateBoardFromRedis()
  .catch((err) => console.error("[Board] hydration failed:", err))
  .finally(() => {
    // log once on startup, then every minute
    logTop50FromRedis().catch(console.error);
    setInterval(() => logTop50FromRedis().catch(console.error), 60 * 1000);
  });

/**
 * Clock time in IST, formatted for display.
 *
 * Render runs its containers in UTC, so `new Date().toLocaleTimeString()` with
 * no arguments follows the *server's* locale — every tick reached the dashboard
 * stamped 5h30m in the past. The platform's users are in India, so the timezone
 * is pinned here rather than left to whatever host the process lands on.
 *
 * `en-US` is chosen over `en-IN` only for its uppercase AM/PM, matching what the
 * UI already displayed. The timezone, not the locale, is what fixes the bug.
 */
function istTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata" });
}

//// normalize incoming ticker data
// Binance quotes in USD; the platform trades in rupees. The INR fields are the
// authoritative ones — everything that touches money (fills, balances, P&L, in
// both clients) reads *INR. The raw USD values are carried along for reference
// only and must not be used in any calculation.
function normaliseTicker(t: any): Row {
  const priceUsd = +t.c;
  const changeUsd = +t.p;
  const now = new Date();
  return {
    stockName: `${t.s.toLowerCase()}`,
    stocksymbol: t.s,
    stockPrice: priceUsd, // informational only
    stockPriceINR: usdToInr(priceUsd),
    stockChange: changeUsd, // informational only
    stockChangeINR: usdToInr(changeUsd),
    stockChangePercentage: +t.P,
    ts: istTime(now),
    tsMs: now.getTime(),
  };
}

let upstream: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

/** An open-but-silent upstream past this deadline is treated as failed. The
 *  @ticker streams push roughly once per second per symbol, so 20s is a very
 *  generous margin — nothing healthy will ever trip it. */
const UPSTREAM_SILENCE_MS = 20_000;

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
    `${BINANCE_WS_BASE}/stream?streams=${BOARD_STREAM}`,
  );
  upstream = ws;

  // "Connected" is not the same as "receiving data", and conflating the two is
  // what hid this outage: the futures endpoint completed the handshake, logged a
  // cheerful "Connected upstream", and then sent nothing at all. A socket that is
  // open but silent past this deadline is treated as failed and recycled.
  let sawFirstMessage = false;
  let silenceTimer: NodeJS.Timeout | null = null;

  const clearSilenceTimer = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

  ws.on("open", () => {
    console.log("[Binance WS] Connected upstream");
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      if (sawFirstMessage || upstream !== ws) return;
      console.error(
        `[Binance WS] Handshake succeeded but NO data in ${
          UPSTREAM_SILENCE_MS / 1000
        }s — endpoint is accepting connections without streaming ` +
          `(geo-restriction or bad stream names). Forcing reconnect.`,
      );
      ws.removeAllListeners();
      ws.terminate();
      if (upstream === ws) upstream = null;
      scheduleReconnect();
    }, UPSTREAM_SILENCE_MS);
  });

  ws.on("message", async (buf) => {
    try {
      if (!sawFirstMessage) {
        sawFirstMessage = true;
        clearSilenceTimer();
        console.log("[Binance WS] Receiving ticks — feed is live");
      }
      const parsed = JSON.parse(buf.toString());
      if (!parsed.data) return;
      const row = normaliseTicker(parsed.data);
      upstreamMsgCount++;
      const payload = JSON.stringify(row);
      await rCmd
        .pipeline()
        // TTL, so a key cannot outlive the feed that produced it. Without this a
        // dead upstream left a full set of keys behind indefinitely and the
        // snapshot log reported them as though prices were live.
        .set(tickKey(row.stockName), payload, "EX", TICK_TTL_SECONDS)
        .publish(`tick.${row.stockName}`, payload)
        .exec();
    } catch (err) {
      console.error("[Binance WS] message processing error:", err);
    }
  });

  ws.on("close", (code) => {
    clearSilenceTimer();
    // Ignore a close from a socket we've already replaced.
    if (upstream !== ws) return;
    console.warn(
      `[Binance WS] Connection closed (code=${code}, ticksThisSession=${
        sawFirstMessage ? "some" : "NONE"
      }). Reconnecting...`,
    );
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
      // IST too — these logs are read alongside the snapshot table, and mixing
      // UTC and IST across the same console is how a stale feed gets misread.
      time: istTime(),
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
