import { vi } from "vitest";

/**
 * Minimal Prisma double.
 *
 * `$transaction(cb)` invokes the callback with the same mock object, so a
 * controller's transactional writes are recorded and assertable without a
 * database. A thrown error propagates exactly as it would from a real
 * transaction, which is what the "nothing was written" assertions rely on.
 */
export function createMockPrisma() {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  });

  const prisma: any = {
    user: model(),
    portfolio: model(),
    transaction: model(),
    order: model(),
    shortPosition: model(),
    commodityPortfolio: model(),
  };

  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  return prisma;
}

/** Express app wiring shared by the controller tests. */
export async function buildTestApp(
  mount: (app: import("express").Express) => void,
) {
  const express = (await import("express")).default;
  const errorMiddleware = (await import("../../src/middlewares/errorMiddleware.js"))
    .default;

  const app = express();
  app.use(express.json());
  mount(app);
  app.use(errorMiddleware);
  return app;
}
