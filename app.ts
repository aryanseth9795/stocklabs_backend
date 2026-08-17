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
import { createAdapter } from "@socket.io/redis-adapter";
import WebSocket from "ws";
import errorMiddleware from "./src/middlewares/errorMiddleware.js";
import { TOP50 } from "./src/constants/StockList.js";
import userRoute from "./src/routes/userRoute.js";
import shortRoute from "./src/routes/shortRoute.js";
import commodityRoute from "./src/routes/commodityRoute.js";
import { Row } from "./src/types/types.js";
import { startAutoCutJob, stopAutoCutJob } from "./src/utils/autoCutJob.js";
import {
  closeAllSubscribers,
  hydrateCommoditiesFromRedis,
  startCommodityConsumer,
  startCommodityUpstream,
  stopCommodityUpstream,
  subscriberCount,
  upstreamConnected,
} from "./src/utils/commodityFeed.js";
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
import { env, isApi, isWorker } from "./src/config/env.js";
import {
  closeRedis,
  connectRedis,
  makeAdapterClients,
  rCmd,
  rSub,
} from "./src/db/redis.js";
import { verifyAccessToken } from "./src/utils/token.js";

const PORT = env.PORT;
const CLIENT_URL = env.CLIENT_URL;
// USD_INR is now fetched dynamically – see src/utils/exchangeRate.ts
const ENVMODE = env.NODE_ENV;

console.log(`Starting relay in ${ENVMODE} mode as ROLE=${env.ROLE}...`);

/**
 * Every interval this process owns.
 *
 * They used to be anonymous, which was fine while the process only ever died by
 * being killed. Now that shutdown is graceful, an uncleared timer keeps Node
 * alive past the point where everything else has been torn down, so each one has
 * to be reachable.
 */
const timers: NodeJS.Timeout[] = [];
const track = (t: NodeJS.Timeout): NodeJS.Timeout => {
  timers.push(t);
  return t;
};

/** Set the moment SIGTERM arrives, so /readyz can drain before the socket closes. */
let shuttingDown = false;
/** True once the boot-time warm start has finished (or given up). */
let hydrated = false;
/** Epoch ms of the last upstream tick. Worker-only signal; 0 means "never". */
let lastTickAt = 0;

/**
 * Is Postgres reachable? Memoised for 5s so that /readyz — which nginx, Docker
 * and any future monitor all poll — cannot be turned into database load.
 */
let dbProbe = { at: 0, ok: false };
async function dbReachable(): Promise<boolean> {
  if (Date.now() - dbProbe.at < 5_000) return dbProbe.ok;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbProbe = { at: Date.now(), ok: true };
  } catch {
    dbProbe = { at: Date.now(), ok: false };
  }
  return dbProbe.ok;
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
// The production origin used to be hardcoded here, which meant a new deployment
// domain required a rebuild. CORS_ORIGINS is a comma-separated list; the legacy
// value stays as the default so nothing breaks if it is unset.
const corsOptions = {
  origin: [
    ...(env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
      : ["https://stocklabs.aryantechie.in"]),
    CLIENT_URL,
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
};

const app = express();

// Behind nginx every request otherwise appears to come from the proxy's IP, so
// req.ip is useless for logging and any future rate limiter would throttle the
// entire fleet as a single client.
app.set("trust proxy", 1);

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.get("/ping", (req, res) => {
  res.json({ message: "Server is running" });
});

// Only the api role serves the product. Mounting these on the worker too would
// mean an nginx misconfiguration silently routes a trade to a process that is
// not in the load balancer; leaving them off turns that into a loud 404.
if (isApi) {
  app.use("/api/v1/", userRoute);
  app.use("/api/v1/short", shortRoute);
  app.use("/api/v1/commodity", commodityRoute);
}

/**
 * Liveness. Deliberately checks NOTHING.
 *
 * Liveness answers "is this process wedged?" If it probed Redis or Postgres, a
 * ten-second blip would mark every container unhealthy at the same instant and
 * the restart policy would cycle the whole fleet — turning a transient
 * dependency hiccup into a real outage plus a thundering-herd reconnect. A
 * liveness check that depends on shared infrastructure is an outage amplifier.
 */
app.get("/healthz", (_req, res) => {
  res.json({
    status: shuttingDown ? "shutting-down" : "ok",
    role: env.ROLE,
    pid: process.pid,
    uptime: process.uptime(),
    instance: process.env.HOSTNAME ?? null,
  });
});

/**
 * Readiness, governed by one rule: it may only FAIL on conditions that make
 * *this* replica worse than its peers.
 *
 * A condition shared by every replica — a dead Binance feed, say — gets reported
 * but never gates, because gating on it pulls the entire fleet out of rotation
 * at once, which is strictly worse than serving degraded. The failing crypto
 * orders already 503 on their own; the rest of the product keeps working.
 */
app.get("/readyz", async (_req, res) => {
  const boardSymbols = Object.keys(boardCache).length;
  const boardAgeMs = boardSymbols
    ? Date.now() -
      Math.max(...Object.values(boardCache).map((r) => r.tsMs ?? 0))
    : null;

  const checks: Record<string, unknown> = {
    role: env.ROLE,
    instance: process.env.HOSTNAME ?? null,
    shuttingDown,
    hydrated,
    redisSub: rSub.status,
    redisCmd: rCmd.status,
    db: await dbReachable(),
    boardSymbols,
    boardAgeMs,
    commodityUpstream: upstreamConnected(),
    sseSubscribers: subscriberCount(),
    sockets: userSockets.size + guestSockets.size,
  };

  const gates = isWorker
    ? [
        !shuttingDown,
        checks.db === true,
        rCmd.status === "ready",
        // "Connected" is not "receiving data" — the geo-blocked futures endpoint
        // held an open socket and sent nothing. There is exactly one worker, so
        // here unhealthy IS the alert we want.
        upstream?.readyState === WebSocket.OPEN,
        Date.now() - lastTickAt < 30_000,
      ]
    : [
        !shuttingDown,
        hydrated,
        checks.db === true,
        // A replica whose subscription died has a permanently frozen board while
        // its peers are fine — the canonical per-replica failure.
        rSub.status === "ready",
      ];

  res.status(gates.every(Boolean) ? 200 : 503).json(checks);
});

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

/**
 * Cross-replica Socket.IO.
 *
 * Its own client pair, NOT rSub. ioredis delivers every pattern message to every
 * listener on a connection, so sharing rSub would push the adapter's
 * msgpack-encoded payloads into the tick handler below, where JSON.parse throws
 * and logs a parse error on every socket.io broadcast in the fleet.
 */
const adapterClients = makeAdapterClients();
io.adapter(createAdapter(adapterClients.pub, adapterClients.sub));

// Runs on the worker only: it force-closes shorts at midnight IST, and N
// replicas would each scan every open position. The per-row conditional claim in
// autoCutJob means they would not double-pay, but there is no reason to find out.
if (isWorker) startAutoCutJob();

// The server is the price authority for commodities, so it keeps its own
// upstream subscription rather than depending on a client being connected
// (review A-01). One level up, the same argument makes this worker-only: N
// replicas would mean N connections to the third-party feed.
if (isWorker) startCommodityUpstream(rCmd);

// Both roles consume. The worker needs commodity prices too — the midnight
// auto-cut closes commodity shorts — and consuming its own publishes keeps
// exactly one cache-writing path in the codebase.
startCommodityConsumer(rSub);

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
  // exec() resolves to null if the pipeline was discarded; treat that as "no TTL
  // information", which the loop below already handles by skipping the key.
  const ttlRes = (await ttlPipe.exec()) ?? [];

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

/**
 * Warm both caches from Redis before accepting traffic, so a redeploy does not
 * serve an empty board — or 503 every commodity order — until the next tick.
 *
 * The race ceiling is deliberate. Hydration failing must never make the whole
 * fleet unlistenable: after the timeout we listen anyway and report the degraded
 * state on /readyz, which is a far better outcome than a Redis hiccup taking
 * every replica offline at once.
 */
const HYDRATION_CEILING_MS = 10_000;

async function warmStart(): Promise<void> {
  const work = Promise.allSettled([
    hydrateBoardFromRedis(),
    hydrateCommoditiesFromRedis(rCmd),
  ]);
  const ceiling = new Promise((resolve) =>
    setTimeout(resolve, HYDRATION_CEILING_MS).unref(),
  );
  await Promise.race([work, ceiling]);
  hydrated = true;

  // Worker only. upstreamMsgCount is incremented on the ingest path, which an
  // api replica never runs — so there the delta is permanently 0 and the "price
  // feed is DOWN" alarm below would fire every 60 seconds forever while the feed
  // is perfectly healthy. That false alarm would teach you to ignore the one log
  // line that actually matters. Api replicas report board health via /readyz.
  if (isWorker) {
    logTop50FromRedis().catch(console.error);
    track(setInterval(() => logTop50FromRedis().catch(console.error), 60 * 1000));
  }
}

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
    `${env.BINANCE_WS_BASE}/stream?streams=${BOARD_STREAM}`,
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
      lastTickAt = Date.now();
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

/**
 * Tear down the upstream for shutdown.
 *
 * Listeners come off first, exactly as in connectBinanceUpstream: the `close`
 * handler would otherwise schedule a reconnect on the way out and keep the
 * process alive past the point where everything else has been closed.
 */
function stopBinanceUpstream(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (upstream) {
    upstream.removeAllListeners();
    upstream.terminate();
    upstream = null;
  }
}

// Worker only. N replicas would mean N WebSocket connections to Binance from one
// VM IP — which Binance rate-limits — plus N identical writes to the same Redis
// keys and N copies of every tick fanned back out to all N subscribers.
if (isWorker) connectBinanceUpstream();

//// Redis → Socket.IO
const BOARD_ROOM = "top50";
const BOARD_BROADCAST_MS = 1000;
let boardDirty = false;

// BOTH roles subscribe, including the worker. The worker publishes ticks but
// never writes boardCache — only this handler does — and the midnight auto-cut
// reads boardCache through getLivePriceINR. A worker that skipped this would
// have an empty board and silently skip every crypto short at 00:00 IST.
rSub.psubscribe("tick.*");
rSub.on("pmessage", (_pattern: string, channel: string, raw: string) => {
  // The Socket.IO adapter has its own client pair, but this guard costs nothing
  // and makes the failure mode impossible rather than merely unlikely.
  if (!channel.startsWith("tick.")) return;
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
//
// `io.local` is load-bearing, not decoration. With the Redis adapter attached,
// a plain `io.to(room)` is forwarded to every replica, and every replica
// delivers it to its own room members — while every replica also runs this same
// 1s interval. At three replicas each client would receive three board events
// per second. The early-return above does not save you: it inspects the LOCAL
// room map, which the adapter deliberately keeps local, so each replica passes
// its own check and then broadcasts globally.
//
// Local is also simply correct here: every replica holds a complete boardCache
// fed from the same Redis stream, so it can serve its own subscribers.
if (isApi) {
  track(
    setInterval(() => {
      if (!boardDirty) return;
      const room = io.sockets.adapter.rooms.get(BOARD_ROOM);
      if (!room || room.size === 0) return;

      boardDirty = false;
      io.local.to(BOARD_ROOM).emit("board", boardSnapshot());
    }, BOARD_BROADCAST_MS),
  );
}

//// track online users
// Local bookkeeping only — these counts are now per-replica. Cross-replica
// session enforcement goes through the adapter (see the connection handler).
const userSockets = new Map<string, string>();
const guestSockets = new Set<string>();
if (isApi) {
  track(
    setInterval(
      () =>
        console.table({
          // IST too — these logs are read alongside the snapshot table, and
          // mixing UTC and IST across the same console is how a stale feed gets
          // misread.
          time: istTime(),
          // Per-replica now, so tag the row with the container that produced it
          // — otherwise three replicas print three unrelated counts as though
          // they were the same number moving.
          instance: process.env.HOSTNAME ?? "local",
          users: userSockets.size,
          guests: guestSockets.size,
          total: userSockets.size + guestSockets.size,
          id: guestSockets.size ? Array.from(guestSockets)[0] : null,
        }),
      60 * 1_000,
    ),
  );
}

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
    // One session per user, across the whole fleet.
    //
    // This used to be `io.sockets.sockets.get(...)`, which only sees sockets on
    // THIS process. Behind a load balancer a user who reconnected onto a second
    // replica kept both sessions alive, each running its own 2s portfolio
    // poller — duplicated streams and doubled DB reads (review D-5).
    //
    // A per-user room plus the Redis adapter makes the disconnect cluster-wide;
    // `except` spares the socket that just arrived.
    sock.join(`user:${uid}`);
    io.in(`user:${uid}`).except(sock.id).disconnectSockets(true);
    userSockets.set(uid, sock.id);
  } else {
    guestSockets.add(sock.id);
  }

  sock.on("landing", () => {
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
  track(setInterval(ping, 720000));
} else {
  console.log("[Ping] API_URL not set — self-ping disabled.");
}

/**
 * Graceful shutdown.
 *
 * There was none, which was survivable when the process only ever died by being
 * killed. Under a load balancer with rolling restarts it is not: every scale-down
 * would drop in-flight requests and yank live sockets.
 */
const DRAIN_DELAY_MS = 8_000;
const SHUTDOWN_WATCHDOG_MS = 15_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} received — draining...`);

  // Always exit under our own power, comfortably inside compose's 45s
  // stop_grace_period, so a hung teardown still produces a clean container exit.
  setTimeout(() => {
    console.error("[Shutdown] Watchdog fired — forcing exit.");
    process.exit(1);
  }, SHUTDOWN_WATCHDOG_MS).unref();

  // /readyz now returns 503, but KEEP SERVING. This delay is what makes the
  // restart actually zero-downtime: close the listener while the container's DNS
  // record still exists and nginx sends requests into a closed port. That is
  // retried for GETs but deliberately NOT for POSTs, so a user's order fails.
  await new Promise((r) => setTimeout(r, DRAIN_DELAY_MS));

  server.close();
  server.closeIdleConnections?.();

  // `.local` is mandatory. With the Redis adapter, a bare io.disconnectSockets()
  // is fleet-wide — restarting one replica would disconnect every user on every
  // replica, once per replica, turning a rolling deploy into a reconnect storm.
  io.local.disconnectSockets(true);

  // SSE responses never end on their own, and server.close() waits for every
  // connection to finish — so a single attached stream would hang the container
  // until SIGKILL, and its client would see a TCP reset instead of a clean end.
  closeAllSubscribers();

  if (isWorker) {
    stopCommodityUpstream();
    stopBinanceUpstream();
    await stopAutoCutJob();
  }

  timers.forEach(clearInterval);

  // Let in-flight handlers finish before pulling the data stores out from under
  // them, then force whatever is left.
  await new Promise((r) => setTimeout(r, 3_000));
  server.closeAllConnections?.();

  await prisma.$disconnect().catch(() => {});
  await closeRedis([rCmd, rSub, adapterClients.pub, adapterClients.sub]);

  console.log("[Shutdown] Clean exit.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Last line of defence. Without these, one stray rejection anywhere in the
// socket or job code takes the process down with no usable diagnostic (S-09).
process.on("unhandledRejection", (reason) => {
  console.error("[Fatal] Unhandled promise rejection:", reason);
});

// Unlike the above, an uncaught exception leaves the process in an unknown
// state. Logging and carrying on kept a possibly-corrupt server serving traffic
// — and because it never exited, the container restart policy could not help.
process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  void shutdown("uncaughtException").finally(() => process.exit(1));
});

// Connect Redis, warm the caches, and only then accept traffic. Listening before
// hydration means a fresh replica answers 503 on every trade until its board
// fills; not listening at all means nginx gets ECONNREFUSED, which it retries
// onto a warm peer — a far better signal than a 503 body.
await connectRedis([rCmd, rSub, adapterClients.pub, adapterClients.sub]);
await warmStart();

server.listen(PORT, () => {
  console.log(
    `Relay ready on http://localhost:${PORT}  •  USD/INR fixed at ${getUsdInrRate()}`,
  );
});
