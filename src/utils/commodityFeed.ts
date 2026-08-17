/**
 * Commodity price feed — a single, persistent upstream subscription.
 *
 * WHY THIS EXISTS (review A-01)
 *
 * The commodity price cache used to be filled as a side effect of relaying to a
 * connected client: `streamCommodityPrices` opened its own upstream connection
 * per request and wrote prices as they passed through. That had two failures:
 *
 *   1. With no client subscribed, the server knew no commodity prices at all.
 *      Once the server became the price authority, every commodity order was
 *      refused with 503 — and the mobile app streams straight from the
 *      third-party feed, so it never caused the server to subscribe. Commodity
 *      trading was broken for everyone.
 *   2. N clients meant N upstream connections to a third-party service.
 *
 * The server is the price authority, so it maintains its own connection from
 * boot regardless of who is watching, and fans that one stream out to any SSE
 * clients. Prices stay fresh whether or not anyone is connected.
 *
 * SPLIT FOR HORIZONTAL SCALING
 *
 * The same argument that reduced N clients to one upstream connection applies
 * again one level up: N server replicas would mean N upstream connections. So
 * the module now has two halves.
 *
 *   startCommodityUpstream()  — ROLE=worker only. Owns the single upstream GET
 *                               and republishes what it receives through Redis.
 *                               Writes no cache of its own.
 *   startCommodityConsumer()  — BOTH roles. Fills the price cache from Redis and
 *                               fans out to this replica's own SSE clients.
 *
 * The worker runs the consumer too, against its own publishes. That is
 * deliberate: it keeps exactly one writer of `commodityPriceCache` in the
 * codebase, on one code path, in both roles — and the worker genuinely needs
 * commodity prices, because the midnight auto-cut closes commodity shorts.
 *
 * What travels over Redis is the *complete SSE event, verbatim* — not a
 * reconstruction from the parsed prices. handleEvent only extracts `symbol` and
 * `lastPrice`, so republishing a reconstruction would silently drop every other
 * field from the mobile client's stream, and nothing server-side would notice.
 */

import https from "https";
import http from "http";
import type { Response } from "express";
import type { Redis } from "ioredis";
import { commodityKey, setCommodityPriceAt } from "./priceCache.js";
import { COMMODITY_SYMBOLS } from "../constants/Commodities.js";

const COMMODITY_SSE_URL =
  "https://ssj-server-om8r.onrender.com/api/prices/stream";

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Connected SSE clients receiving the fan-out. */
const subscribers = new Set<Response>();

let upstreamReq: http.ClientRequest | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let started = false;

/**
 * SSE frame parser.
 *
 * Kept as instance state rather than locals inside the `data` handler: events
 * routinely straddle TCP chunk boundaries, and the previous implementation
 * reset `eventType`/`dataStr` on every chunk. An `event:` line arriving in one
 * chunk and its `data:` line in the next lost the event type entirely, so the
 * `prices:update` check silently failed and no price was recorded.
 */
class SseParser {
  private buffer = "";
  private eventType = "";
  private dataStr = "";

  push(text: string, onEvent: (type: string, data: string) => void): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        this.eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        this.dataStr += line.slice(5).trim();
      } else if (line === "") {
        if (this.dataStr) onEvent(this.eventType, this.dataStr);
        this.eventType = "";
        this.dataStr = "";
      }
      // lines starting with ":" are comments (keepalives) — ignored
    }
  }
}

/**
 * Extract `{symbol, price}` pairs from a `prices:update` payload.
 *
 * Split out of the old handleEvent so that the worker (which writes to Redis) and
 * the consumer (which writes to the cache) parse the payload identically. Two
 * parsers would be two chances to drift.
 */
function parsePrices(data: string): Array<{ symbol: string; price: number }> {
  const out: Array<{ symbol: string; price: number }> = [];
  try {
    const payload = JSON.parse(data);
    const list = payload?.live?.list;
    if (!Array.isArray(list)) return out;

    for (const item of list) {
      const price = parseFloat(item?.lastPrice);
      if (Number.isFinite(price)) {
        out.push({ symbol: String(item.symbol).toUpperCase(), price });
      }
    }
  } catch {
    /* malformed frame — skip it rather than tear down the feed */
  }
  return out;
}

function broadcast(text: string): void {
  for (const res of subscribers) {
    try {
      res.write(text);
    } catch {
      subscribers.delete(res);
    }
  }
}

function scheduleReconnect(): void {
  if (retryTimer) return;

  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempts,
    RECONNECT_MAX_MS,
  );
  reconnectAttempts += 1;
  console.warn(`[Commodity] Reconnecting upstream in ${delay / 1000}s`);

  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (upstreamReq) {
    upstreamReq.removeAllListeners();
    upstreamReq.destroy();
    upstreamReq = null;
  }

  const url = new URL(COMMODITY_SSE_URL);
  const lib = url.protocol === "https:" ? https : http;
  const parser = new SseParser();

  console.log("[Commodity] Connecting upstream price feed...");

  const req = lib.get(
    {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { Accept: "text/event-stream" },
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        console.error(`[Commodity] Upstream HTTP ${upstreamRes.statusCode}`);
        upstreamRes.resume(); // drain
        scheduleReconnect();
        return;
      }

      console.log("[Commodity] Upstream connected");
      reconnectAttempts = 0;

      // The parser reassembles events across TCP chunk boundaries, so what
      // leaves this process is always a whole event. Republishing raw chunks
      // instead would couple every replica's parser state to the worker's
      // chunk boundaries — a reconnect mid-event would leave a half-parsed
      // buffer on N replicas with no way to resync.
      upstreamRes.on("data", (chunk: Buffer) => {
        parser.push(chunk.toString(), publishEvent);
      });

      upstreamRes.on("end", () => {
        if (upstreamReq !== req) return;
        console.warn("[Commodity] Upstream ended");
        scheduleReconnect();
      });

      upstreamRes.on("error", (err) => {
        if (upstreamReq !== req) return;
        console.error("[Commodity] Upstream stream error:", err.message);
        scheduleReconnect();
      });
    },
  );

  upstreamReq = req;

  req.on("timeout", () => {
    console.warn("[Commodity] Upstream request timed out");
    req.destroy();
  });

  req.on("error", (err) => {
    if (upstreamReq !== req) return;
    console.error("[Commodity] Upstream request error:", err.message);
    scheduleReconnect();
  });
}

/**
 * Redis channel carrying complete upstream SSE events.
 *
 * One channel rather than one per symbol: the events are already batched by the
 * upstream (a `prices:update` carries the whole list), and the SSE fan-out needs
 * the frame intact anyway.
 */
export const COMMODITY_CHANNEL = "commodity.sse";

/**
 * How long a commodity price key survives in Redis.
 *
 * Deliberately LONGER than MAX_PRICE_AGE_MS (60s) in priceCache.ts, because the
 * two answer different questions. The TTL is coarse provenance — "was this
 * written by a feed that was alive recently?" — which is the role
 * TICK_TTL_SECONDS plays for crypto. MAX_PRICE_AGE_MS is the fill decision. If
 * the TTL were the shorter of the two, a key could vanish while its value was
 * still legally fillable, and a replica restarting in that window would 503
 * every commodity order while its peers served fine.
 */
const COMMODITY_TTL_SECONDS = 90;

/** Set by startCommodityUpstream; the consumer half never publishes. */
let publisher: Redis | null = null;

/**
 * Republish one complete upstream event to Redis, and snapshot its prices.
 *
 * The snapshot keys are what a cold replica hydrates from; the publish is what
 * live replicas consume. Both carry `tsMs` so that no downstream reader can
 * mistake "I received this just now" for "this price is from just now".
 */
function publishEvent(type: string, data: string): void {
  if (!publisher) return;
  const tsMs = Date.now();

  if (type === "prices:update") {
    const prices = parsePrices(data);
    if (prices.length) {
      const pipe = publisher.pipeline();
      for (const { symbol, price } of prices) {
        pipe.set(
          commodityKey(symbol),
          JSON.stringify({ price, tsMs }),
          "EX",
          COMMODITY_TTL_SECONDS,
        );
      }
      pipe.exec().catch((err) => console.error("[Commodity] Redis write failed:", err));
    }
  }

  publisher
    .publish(COMMODITY_CHANNEL, JSON.stringify({ event: type, data, tsMs }))
    .catch((err) => console.error("[Commodity] Redis publish failed:", err));
}

/**
 * WORKER ONLY. Owns the single upstream SSE connection and republishes it.
 *
 * Deliberately writes no cache of its own — it consumes its own publishes via
 * startCommodityConsumer, so there is one cache-writing path in both roles.
 */
export function startCommodityUpstream(rCmd: Redis): void {
  if (started) return;
  started = true;
  publisher = rCmd;
  connect();
  console.log("[Commodity] Upstream feed started (worker role).");
}

/**
 * BOTH ROLES. Fills the price cache from Redis and fans out to local SSE clients.
 *
 * `rSub` must be a client dedicated to subscribing; ioredis forbids other
 * commands on a connection in subscriber mode.
 */
export function startCommodityConsumer(rSub: Redis): void {
  rSub.subscribe(COMMODITY_CHANNEL).catch((err) => {
    console.error("[Commodity] Failed to subscribe:", err);
  });

  rSub.on("message", (channel: string, raw: string) => {
    if (channel !== COMMODITY_CHANNEL) return;
    try {
      const { event, data, tsMs } = JSON.parse(raw);

      if (event === "prices:update") {
        for (const { symbol, price } of parsePrices(data)) {
          // The publisher's timestamp, never Date.now(). A Redis backlog, a
          // paused container or a slow replica must not be able to manufacture
          // freshness for a price that is actually old.
          setCommodityPriceAt(symbol, price, tsMs);
        }
      }

      // Re-emit as a well-formed SSE frame for this replica's own clients.
      broadcast(`event: ${event}\ndata: ${data}\n\n`);
    } catch (err) {
      console.error("[Commodity] Bad message on", COMMODITY_CHANNEL, err);
    }
  });

  console.log("[Commodity] Consuming prices from Redis.");
}

/**
 * Warm the commodity cache from Redis at boot.
 *
 * Without it a fresh replica returns 503 on every commodity order until the
 * upstream's next update — and the upstream is itself on a free tier that can
 * take 30-60s to wake, so with rolling restarts that is a user-visible commodity
 * outage on every deploy.
 *
 * Mirrors hydrateBoardFromRedis, including the TTL check: a key with no TTL left
 * is not proof of a live feed, so it is skipped rather than trusted.
 */
export async function hydrateCommoditiesFromRedis(rCmd: Redis): Promise<number> {
  const keys = COMMODITY_SYMBOLS;
  if (!keys.length) return 0;

  const values = await rCmd.mget(...keys.map(commodityKey));
  const ttlPipe = rCmd.pipeline();
  for (const sym of keys) ttlPipe.ttl(commodityKey(sym));
  const ttls = await ttlPipe.exec();

  let restored = 0;
  keys.forEach((sym, i) => {
    const raw = values[i];
    const ttl = Number(ttls?.[i]?.[1] ?? -2);
    if (!raw || ttl <= 0) return;
    try {
      const { price, tsMs } = JSON.parse(raw);
      setCommodityPriceAt(sym, price, tsMs);
      restored += 1;
    } catch {
      /* a single unparseable key must not abort the whole warm start */
    }
  });

  console.log(`[Commodity] Hydrated ${restored}/${keys.length} prices from Redis.`);
  return restored;
}

/**
 * Detach every SSE client, so that server.close() can actually complete.
 *
 * An SSE response never ends on its own. server.close() waits for all
 * connections to finish, so with even one stream attached its callback never
 * fires and the container hangs until Docker SIGKILLs it — and the client gets a
 * TCP reset instead of a clean end.
 */
export function closeAllSubscribers(): void {
  for (const res of subscribers) {
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }
  subscribers.clear();
}

/** Tear down the upstream connection and its reconnect timer. Worker only. */
export function stopCommodityUpstream(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (upstreamReq) {
    upstreamReq.removeAllListeners();
    upstreamReq.destroy();
    upstreamReq = null;
  }
  started = false;
  publisher = null;
}

/** True once the upstream has delivered a 200 and not since dropped. */
export function upstreamConnected(): boolean {
  return started && upstreamReq !== null;
}

/** Registers an SSE client for fan-out. Returns an unsubscribe function. */
export function addSubscriber(res: Response): () => void {
  subscribers.add(res);
  return () => {
    subscribers.delete(res);
  };
}

/** Number of connected SSE clients — used by diagnostics only. */
export function subscriberCount(): number {
  return subscribers.size;
}
