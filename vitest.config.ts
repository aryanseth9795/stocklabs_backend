import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

/**
 * The source uses ESM-correct `.js` specifiers that point at `.ts` files
 * (required by "module": "node16"). Vite doesn't do that mapping on its own,
 * so this plugin resolves `./foo.js` → `./foo.ts` when the .ts file exists.
 */
const resolveTsFromJs = {
  name: "resolve-ts-from-js",
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.startsWith(".") || !source.endsWith(".js")) {
      return null;
    }
    const candidate = path.resolve(
      path.dirname(importer),
      source.replace(/\.js$/, ".ts"),
    );
    return fs.existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [resolveTsFromJs],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Real-looking secrets so env.ts passes validation without touching .env.
    // Deliberately NOT the old hardcoded fallbacks — token.test.ts asserts that
    // tokens signed with those are rejected.
    env: {
      JWT_SECRET: "test-jwt-secret-not-the-hardcoded-one",
      JWT_REFRESH_SECRET: "test-refresh-secret-not-the-hardcoded-one",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      NODE_ENV: "DEVELOPMENT",
      RESEND_API_KEY: "",
    },
  },
});
