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
} as const;

/** True when running locally; controls cookie flags and error verbosity. */
export const isDevelopment = env.NODE_ENV.toUpperCase() === "DEVELOPMENT";

if (!env.RESEND_API_KEY) {
  console.warn(
    "[env] RESEND_API_KEY is not set — welcome and OTP emails will not be sent.",
  );
}
