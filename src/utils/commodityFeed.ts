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
 */

import https from "https";
import http from "http";
import type { Response } from "express";
import { setCommodityPrice } from "./priceCache.js";

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

function handleEvent(type: string, data: string): void {
  if (type !== "prices:update") return;
  try {
    const payload = JSON.parse(data);
    const list = payload?.live?.list;
    if (!Array.isArray(list)) return;

    for (const item of list) {
      const price = parseFloat(item?.lastPrice);
      if (Number.isFinite(price)) {
        setCommodityPrice(String(item.symbol).toUpperCase(), price);
      }
    }
  } catch {
    /* malformed frame — skip it rather than tear down the feed */
  }
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

      upstreamRes.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        parser.push(text, handleEvent);
        broadcast(text);
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

/** Starts the persistent feed. Safe to call once, at boot. */
export function startCommodityFeed(): void {
  if (started) return;
  started = true;
  connect();
  console.log("[Commodity] Price feed started (independent of clients).");
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
