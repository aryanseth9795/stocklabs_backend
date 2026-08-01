import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createMockPrisma, buildTestApp } from "./helpers/mockPrisma.js";
import { setCommodityPrice, commodityPriceCache } from "../src/utils/priceCache.js";

const prisma = createMockPrisma();
vi.mock("../src/db/db.js", () => ({ default: prisma }));

const { executeCommodityOrder } = await import(
  "../src/controllers/commodityController.js"
);

const USER = "user-1";
const AVG_BUY_PRICE = 100_000; // what the user actually paid, per unit
const LIVE_PRICE = 300_000; // market has tripled since

async function app() {
  return buildTestApp((a) => {
    a.post(
      "/commodity/execute",
      (req: any, _res: any, next: any) => {
        req.user = { id: USER };
        next();
      },
      executeCommodityOrder,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(commodityPriceCache)) {
    delete commodityPriceCache[k];
  }
  setCommodityPrice("GOLD", LIVE_PRICE);

  prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
  prisma.user.findUnique.mockResolvedValue({ id: USER, balance: 100_000_000 });
  prisma.transaction.create.mockResolvedValue({ id: "tx-1" });
  prisma.order.create.mockResolvedValue({ id: "order-1" });
  prisma.commodityPortfolio.findUnique.mockResolvedValue(null);
});

/**
 * S-11 — the sell path did `total: holding.total - cost`, subtracting SALE
 * PROCEEDS from COST BASIS. Selling into a rising market drove the basis
 * negative and poisoned the average price on the next buy.
 */
describe("S-11: commodity sell preserves cost basis", () => {
  beforeEach(() => {
    // Holding: 10 units bought at ₹100,000 → basis ₹1,000,000.
    prisma.commodityPortfolio.findUnique.mockResolvedValue({
      userId: USER,
      symbol: "GOLD",
      price: AVG_BUY_PRICE,
      quantity: 10,
      total: 10 * AVG_BUY_PRICE,
    });
  });

  it("reduces basis at the average price paid, not the sale price", async () => {
    const res = await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 4, type: "sell" });

    expect(res.status).toBe(200);

    // Correct: 1,000,000 - (4 * 100,000) = 600,000.
    // The bug computed 1,000,000 - (4 * 300,000) = -200,000.
    expect(prisma.commodityPortfolio.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { quantity: 6, total: 600_000 },
      }),
    );
  });

  it("never drives the basis negative on a profitable sale", async () => {
    await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 9, type: "sell" });

    const updateArg = prisma.commodityPortfolio.update.mock.calls[0][0];
    expect(updateArg.data.total).toBeGreaterThanOrEqual(0);
  });

  it("credits the user at the live market price", async () => {
    await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 4, type: "sell" });

    // Proceeds are at market: 4 * 300,000 = 1,200,000.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: 100_000_000 + 1_200_000 },
      }),
    );
  });

  it("rejects a sell larger than the holding", async () => {
    const res = await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 999, type: "sell" });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

/**
 * S-12 — the branch structure ended in an `else` that executed a SELL, so any
 * unrecognised `type` silently sold the user's holding.
 */
describe("S-12: commodity order type is validated", () => {
  it("rejects an unrecognised type instead of treating it as a sell", async () => {
    prisma.commodityPortfolio.findUnique.mockResolvedValue({
      userId: USER,
      symbol: "GOLD",
      price: AVG_BUY_PRICE,
      quantity: 10,
      total: 10 * AVG_BUY_PRICE,
    });

    for (const type of ["SELL", "long", "liquidate", "", undefined]) {
      const res = await request(await app())
        .post("/commodity/execute")
        .send({ symbol: "GOLD", quantity: 1, type });

      expect(res.status).toBe(400);
    }

    // Nothing was sold.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown commodity symbol", async () => {
    const res = await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "DOGECOIN", quantity: 1, type: "buy" });

    expect(res.status).toBe(400);
  });

  it("accepts a valid buy", async () => {
    const res = await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 1, type: "buy" });

    expect(res.status).toBe(200);
    expect(prisma.commodityPortfolio.create).toHaveBeenCalled();
  });
});

describe("S-02: commodity orders fill at the server's price", () => {
  it("ignores a client-supplied rate", async () => {
    const res = await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 1, rate: 1, type: "buy" });

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(LIVE_PRICE);
    expect(prisma.commodityPortfolio.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ price: LIVE_PRICE, total: LIVE_PRICE }),
      }),
    );
  });

  it("refuses the order when the price is unavailable", async () => {
    delete commodityPriceCache.GOLD;

    const res = await request(await app())
      .post("/commodity/execute")
      .send({ symbol: "GOLD", quantity: 1, rate: 5000, type: "buy" });

    expect(res.status).toBe(503);
    expect(prisma.commodityPortfolio.create).not.toHaveBeenCalled();
  });
});
