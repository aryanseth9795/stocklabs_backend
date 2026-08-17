/**
 * Shared Redis connections.
 *
 * These used to be created inline in app.ts, which was fine while app.ts was the
 * only thing that touched Redis. It no longer is: the commodity feed, the OTP
 * store and the Socket.IO adapter all need a handle, and none of them can import
 * app.ts without creating the cycle (app.ts → routes → controllers → app.ts) that
 * priceCache.ts was written to avoid.
 *
 * IMPORTANT — `lazyConnect: true` is load-bearing, not a micro-optimisation.
 * Controllers are imported directly by the test suite. If these clients connected
 * eagerly at module evaluation, merely importing a controller in a test would open
 * sockets to 127.0.0.1:6379, spray ECONNREFUSED, and leave handles open that stop
 * vitest exiting. Connection is deferred to an explicit connectRedis() that only
 * app.ts calls, which keeps the suite hermetic.
 */

import RedisPkg from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import { env } from "../config/env.js";

// ioredis ships CJS; under node16 ESM the constructor arrives on `.default`
// depending on how it is resolved, so normalise it once here.
const Redis: any = (RedisPkg as any).default || RedisPkg;

const options = {
  lazyConnect: true,
  // Commands issued before connect() resolves queue rather than throw, which is
  // what makes a lazy client behave like an eager one once connected.
  enableOfflineQueue: true,
  maxRetriesPerRequest: null as null,
};

/**
 * Attach logging. Neither client had ANY listener originally: ioredis emits
 * "error" rather than throwing, so a subscriber that never reconnected stayed
 * silent forever — and since boardCache is fed *only* by the subscriber, that
 * failure mode looks exactly like an outage with no error anywhere in the log.
 * The clients are named so it is obvious which side broke.
 */
function instrument(name: string, client: RedisClient): RedisClient {
  client.on("error", (err: Error) => console.error(`[Redis:${name}] ${err.message}`));
  client.on("end", () => console.warn(`[Redis:${name}] connection closed`));
  client.on("reconnecting", () => console.warn(`[Redis:${name}] reconnecting`));
  return client;
}

/** Command client: GET/SET/MGET/PUBLISH and everything else non-subscribing. */
export const rCmd: RedisClient = instrument("rCmd", new Redis(env.REDIS_URL, options));

/**
 * Subscriber client. Separate because a connection in subscriber mode may only
 * issue subscribe/unsubscribe commands.
 */
export const rSub: RedisClient = instrument("rSub", new Redis(env.REDIS_URL, options));

/**
 * A fresh client pair for the Socket.IO Redis adapter.
 *
 * Deliberately NOT rSub. The adapter psubscribes on its own channels, and ioredis
 * delivers every pattern message to every listener on the connection — so the
 * adapter's msgpack-encoded payloads would reach app.ts's tick handler, where
 * JSON.parse throws and logs a parse error on every socket.io broadcast in the
 * fleet.
 */
export function makeAdapterClients(): { pub: RedisClient; sub: RedisClient } {
  return {
    pub: instrument("adapterPub", new Redis(env.REDIS_URL, options)),
    sub: instrument("adapterSub", new Redis(env.REDIS_URL, options)),
  };
}

/** Opens every connection. Called once, from app.ts, never from a controller. */
export async function connectRedis(clients: RedisClient[]): Promise<void> {
  await Promise.all(
    clients.map((c) => (c.status === "wait" ? c.connect() : Promise.resolve())),
  );
}

/** Best-effort graceful close. `quit()` rejects if the socket is already gone. */
export async function closeRedis(clients: RedisClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.quit()));
}
