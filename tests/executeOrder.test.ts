import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createMockPrisma, buildTestApp } from "./helpers/mockPrisma.js";
import { boardCache } from "../src/utils/priceCache.js";
import type { Row } from "../src/types/types.js";

const prisma = createMockPrisma();
vi.mock("../src/db/db.js", () => ({ default: prisma }));

const { ExecuteOrder } = await import("../src/controllers/userController.js");

const AUTHED_USER = "authenticated-user";
const VICTIM_USER = "someone-elses-account";

const LIVE_PRICE_INR = 5_000_000;

function makeRow(symbol: string, priceInr: number): Row {
  return {
    stockName: symbol.toLowerCase(),
    stocksymbol: symbol,
    stockPrice: priceInr / 84,
    stockPriceINR: priceInr,
    stockChange: 0,
    stockChangeINR: 0,
    stockChangePercentage: 0,
    ts: new Date().toISOString(),
  };
}

/** Mounts /execute with a stub auth middleware that always authenticates
 *  AUTHED_USER — mirroring isAuthenticated having already run. */
async function app() {
  return buildTestApp((a) => {
    a.post(
      "/execute",
      (req, _res, next) => {
        req.user = { id: AUTHED_USER };
        next();
      },
      ExecuteOrder,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(boardCache)) delete boardCache[k];
  boardCache.BTCUSDT = makeRow("BTCUSDT", LIVE_PRICE_INR);

  prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
  prisma.user.findUnique.mockResolvedValue({
    id: AUTHED_USER,
    balance: 100_000_000,
  });
  prisma.portfolio.findUnique.mockResolvedValue(null);
  prisma.portfolio.upsert.mockResolvedValue({});
  prisma.transaction.create.mockResolvedValue({ id: "tx-1" });
  prisma.order.create.mockResolvedValue({ id: "order-1" });
});

/**
 * S-03 — the endpoint used to read the target account from req.body.userId,
 * so any logged-in user could trade on anyone else's account.
 */
describe("S-03: ExecuteOrder ignores a body-supplied userId", () => {
  it("trades the authenticated account, not the one in the body", async () => {
    const res = await request(await app())
      .post("/execute")
      .send({
        userId: VICTIM_USER, // attacker-supplied
        stockName: "BTCUSDT",
        quantity: 1,
        type: "buy",
      });

    expect(res.status).toBe(200);

    // Every write must be scoped to the authenticated user.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: AUTHED_USER },
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: AUTHED_USER }),
      }),
    );

    const touchedVictim = JSON.stringify([
      prisma.user.findUnique.mock.calls,
      prisma.portfolio.upsert.mock.calls,
      prisma.order.create.mock.calls,
    ]).includes(VICTIM_USER);
    expect(touchedVictim).toBe(false);
  });

  it("401s when there is no authenticated user", async () => {
    const bare = await buildTestApp((a) => a.post("/execute", ExecuteOrder));
    const res = await request(bare)
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 1, type: "buy" });

    expect(res.status).toBe(401);
  });
});

/**
 * S-02 — `rate` used to come from the request body, so a user could buy at ₹1
 * and sell at ₹10,00,000.
 */
describe("S-02: ExecuteOrder fills at the server's price", () => {
  it("ignores a client-supplied rate and uses the live price", async () => {
    const res = await request(await app())
      .post("/execute")
      .send({
        stockName: "BTCUSDT",
        quantity: 2,
        rate: 1, // attacker wants to buy 2 BTC for ₹2
        type: "buy",
      });

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(LIVE_PRICE_INR);

    // Cost must reflect the real price, not the ₹1 the client asked for.
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stockPrice: LIVE_PRICE_INR,
          stockTotal: 2 * LIVE_PRICE_INR,
        }),
      }),
    );
  });

  it("refuses the order with 503 when no live price is available", async () => {
    delete boardCache.BTCUSDT;

    const res = await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 1, rate: 1, type: "buy" });

    expect(res.status).toBe(503);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});

/**
 * S-05 — negative quantity made cost negative, passed the balance check, and
 * credited the user.
 */
describe("S-05: ExecuteOrder validates quantity", () => {
  it("rejects a negative quantity without writing anything", async () => {
    const res = await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: -10, type: "buy" });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("rejects zero, NaN and non-numeric quantities", async () => {
    for (const quantity of [0, "abc", null]) {
      const res = await request(await app())
        .post("/execute")
        .send({ stockName: "BTCUSDT", quantity, type: "buy" });
      expect(res.status).toBe(400);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown order type", async () => {
    const res = await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 1, type: "sideways" });

    expect(res.status).toBe(400);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});

/**
 * S-04 — the insufficient-balance guard returned an ErrorHandler instead of
 * throwing it, so the response was 200 "Transaction successful".
 */
describe("S-04: rejected trades do not report success", () => {
  it("returns 400 and no success flag when the balance is too low", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: AUTHED_USER, balance: 100 });

    const res = await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 1, type: "buy" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient balance/i);
    expect(res.body.success).toBe(false);

    // And crucially: nothing was written.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it("returns 400 when selling more than is held", async () => {
    prisma.portfolio.findUnique.mockResolvedValue({
      id: "p1",
      stockQuantity: 1,
      stockTotal: LIVE_PRICE_INR,
    });

    const res = await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 5, type: "sell" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not enough/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

/**
 * S-21 — findFirst-then-create let two concurrent buys both insert and violate
 * the unique constraint.
 */
describe("S-21: concurrent buys use an atomic upsert", () => {
  it("upserts on the unique constraint instead of read-then-create", async () => {
    await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 1, type: "buy" });

    expect(prisma.portfolio.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_stockSymbol: {
            userId: AUTHED_USER,
            stockSymbol: "BTCUSDT",
          },
        },
      }),
    );
    expect(prisma.portfolio.create).not.toHaveBeenCalled();
  });
});

/** Selling part of a holding must reduce cost basis at the average price paid. */
describe("cost basis is reduced at the average price on a partial sell", () => {
  it("does not subtract sale proceeds from the basis", async () => {
    // Held 10 units for a total cost of 10 * 1,000,000 = 10,000,000.
    prisma.portfolio.findUnique.mockResolvedValue({
      id: "p1",
      stockQuantity: 10,
      stockTotal: 10_000_000,
    });

    // Sell 5 at the (much higher) live price of 5,000,000.
    await request(await app())
      .post("/execute")
      .send({ stockName: "BTCUSDT", quantity: 5, type: "sell" });

    // Basis must drop by 5 * avg(1,000,000) = 5,000,000 → 5,000,000 remaining.
    // Subtracting proceeds (5 * 5,000,000 = 25,000,000) would make it negative.
    expect(prisma.portfolio.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stockQuantity: 5,
          stockTotal: 5_000_000,
        }),
      }),
    );
  });
});
