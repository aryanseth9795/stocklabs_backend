/**
 * Single source of truth for environment configuration.
 *
 * IMPORTANT: this module reads `process.env` at evaluation time, so `dotenv` must
 * already have run. `app.ts` guarantees that with `import "dotenv/config"` as its
 * very first import — under ESM, imports are fully evaluated before the importing
 * module's body, so calling `config()` in the body is too late (see review S-01).
 *
 * Required secrets have NO fallback. A missing secret is a boot failure, never a
 * silent downgrade to a hardcoded default.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        `Set it in Server/.env before starting the server.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Which half of the system this process runs.
 *
 * "worker" owns everything that must happen exactly once no matter how many
 * containers are running: the Binance upstream, the commodity upstream, and the
 * midnight auto-cut cron. "api" serves HTTP and sockets and can be scaled to N
 * replicas. "all" is both, which is what a single local process has always been.
 *
 * Optional, defaulting to "all", because every test file transitively imports
 * this module — a required ROLE would throw at import time and take the whole
 * suite down — and because `npm run dev` must keep working with no new env vars.
 *
 * But an unrecognised value THROWS rather than falling back. A typo'd ROLE
 * quietly becoming "all" would put a Binance ingester and a cron in every API
 * replica, which is the exact failure the split exists to prevent.
 */
const ROLES = ["api", "worker", "all"] as const;
export type Role = (typeof ROLES)[number];

function role(name: string, fallback: Role): Role {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(ROLES as readonly string[]).includes(raw)) {
    throw new Error(
      `[env] Invalid ${name}="${process.env[name]}". Expected one of: ${ROLES.join(", ")}.`,
    );
  }
  return raw as Role;
}

export const env = {
  // Secrets — no defaults, ever.
  JWT_SECRET: required("JWT_SECRET"),
  JWT_REFRESH_SECRET: required("JWT_REFRESH_SECRET"),
  DATABASE_URL: required("DATABASE_URL"),

  // Optional integrations — degrade gracefully but log loudly.
  RESEND_API_KEY: process.env.RESEND_API_KEY?.trim() || "",
  API_URL: process.env.API_URL?.trim() || "",

  PORT: optionalNumber("PORT", 4000),
  CLIENT_URL: optional("CLIENT_URL", "http://localhost:3000"),
  REDIS_URL: optional("REDIS_URL", "redis://127.0.0.1:6379"),
  NODE_ENV: optional("NODE_ENV", "DEVELOPMENT"),
  COOKIE_EXPIRY_DAYS: optionalNumber("COOKIE_EXPIRY", 3),
  ROLE: role("ROLE", "all"),

  /**
   * Binance stream host. Promoted from a hardcoded constant so that a
   * geo-restricted egress IP — the failure that silently killed the futures
   * endpoint, see the comment above BINANCE_WS_BASE in app.ts — can be worked
   * around with a config change instead of a rebuild.
   */
  BINANCE_WS_BASE: optional("BINANCE_WS_BASE", "wss://stream.binance.com:9443"),

  /** Extra allowed browser origins, comma-separated. */
  CORS_ORIGINS: optional("CORS_ORIGINS", ""),
} as const;

/** True when running locally; controls cookie flags and error verbosity. */
export const isDevelopment = env.NODE_ENV.toUpperCase() === "DEVELOPMENT";

/**
 * Role predicates. "all" satisfies both on purpose: it keeps every call site a
 * single `if (isWorker)` / `if (isApi)` wrapper, and makes the single-process
 * behaviour that dev and the current Render deployment rely on a provable no-op.
 */
export const isWorker = env.ROLE === "worker" || env.ROLE === "all";
export const isApi = env.ROLE === "api" || env.ROLE === "all";

if (!env.RESEND_API_KEY) {
  console.warn(
    "[env] RESEND_API_KEY is not set — welcome and OTP emails will not be sent.",
  );
}

/**
 * REDIS_URL keeps its localhost fallback for local development, but outside it a
 * missing value is fatal. In a container the fallback resolves to the container's
 * OWN namespace, so the process boots happily and then logs connection errors
 * forever instead of failing fast — and with the price cache, OTP store and
 * Socket.IO adapter all on Redis, that is a server that appears up and works for
 * nothing.
 */
if (!isDevelopment && !process.env.REDIS_URL?.trim()) {
  throw new Error(
    "[env] REDIS_URL is required when NODE_ENV is not DEVELOPMENT. " +
      "Refusing to fall back to 127.0.0.1 inside a container.",
  );
}
