import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createMockPrisma, buildTestApp } from "./helpers/mockPrisma.js";
import { boardCache } from "../src/utils/priceCache.js";
import type { Row } from "../src/types/types.js";

const prisma = createMockPrisma();
vi.mock("../src/db/db.js", () => ({ default: prisma }));

const { executeShortSell, closeShortPosition } = await import(
  "../src/controllers/shortController.js"
);

const USER = "user-1";
const ENTRY_PRICE = 5_000_000;
const LIVE_PRICE = 4_000_000; // price fell → the short is in profit
const QUANTITY = 2;

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

async function app() {
  return buildTestApp((a) => {
    const auth = (req: any, _res: any, next: any) => {
      req.user = { id: USER };
      next();
    };
    a.post("/short/sell", auth, executeShortSell);
    a.post("/short/cover", auth, closeShortPosition);
  });
}

const OPEN_POSITION = {
  id: "short-1",
  userId: USER,
  assetType: "crypto",
  stockSymbol: "BTCUSDT",
  stockName: "BTCUSDT",
  entryPrice: ENTRY_PRICE,
  quantity: QUANTITY,
  totalValue: ENTRY_PRICE * QUANTITY,
  status: "open",
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(boardCache)) delete boardCache[k];
  boardCache.BTCUSDT = makeRow("BTCUSDT", LIVE_PRICE);

  prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
  prisma.user.findUnique.mockResolvedValue({ id: USER, balance: 100_000_000 });
  prisma.shortPosition.findUnique.mockResolvedValue(OPEN_POSITION);
  prisma.shortPosition.create.mockResolvedValue(OPEN_POSITION);
  prisma.transaction.create.mockResolvedValue({ id: "tx-1" });
  prisma.order.create.mockResolvedValue({ id: "order-1" });
});

/**
 * S-06 — the "is it still open?" check was a plain read inside a READ COMMITTED
 * transaction. Two concurrent covers both saw "open" and both credited the
 * balance: the position closed once but paid out twice.
 */
describe("S-06: closing a short is claimed atomically", () => {
  it("claims the position with a conditional update, not a bare update", async () => {
    prisma.shortPosition.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(await app())
      .post("/short/cover")
      .send({ shortPositionId: "short-1" });

    expect(res.status).toBe(200);

    // The write must be conditional on status still being "open" — that
    // condition is what the database uses to arbitrate the race.
    expect(prisma.shortPosition.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "short-1", status: "open" },
      }),
    );
  });

  it("does not credit the balance when another request already claimed it", async () => {
    // Simulates losing the race: the conditional update matched zero rows.
    prisma.shortPosition.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(await app())
      .post("/short/cover")
      .send({ shortPositionId: "short-1" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already closed/i);

    // The critical assertion: no second payout.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it("credits exactly once on the winning request", async () => {
    prisma.shortPosition.updateMany.mockResolvedValue({ count: 1 });

    await request(await app())
      .post("/short/cover")
      .send({ shortPositionId: "short-1" });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);

    // P&L = (entry - exit) * qty = (5,000,000 - 4,000,000) * 2 = 2,000,000
    // Return = margin (10,000,000) + P&L = 12,000,000
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: 100_000_000 + 12_000_000 },
      }),
    );
  });

  it("rejects a position belonging to someone else", async () => {
    prisma.shortPosition.findUnique.mockResolvedValue({
      ...OPEN_POSITION,
      userId: "a-different-user",
    });

    const res = await request(await app())
      .post("/short/cover")
      .send({ shortPositionId: "short-1" });

    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("404s for a position that does not exist", async () => {
    prisma.shortPosition.findUnique.mockResolvedValue(null);

    const res = await request(await app())
      .post("/short/cover")
      .send({ shortPositionId: "nope" });

    expect(res.status).toBe(404);
  });
});

/**
 * S-02 for shorts — the exit price drives P&L directly, so a client-supplied
 * one was a dial for creating money.
 */
describe("S-02: short exit price comes from the server", () => {
  it("ignores a client-supplied cover rate", async () => {
    prisma.shortPosition.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(await app())
      .post("/short/cover")
      .send({ shortPositionId: "short-1", rate: 1 }); // "cover at ₹1"

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(LIVE_PRICE);

    // Had the client's rate been used, P&L would be
    // (5,000,000 - 1) * 2 ≈ 10,000,000 instead of 2,000,000.
    expect(res.body.profitLoss).toBe(2_000_000);
  });

  it("ignores a client-supplied entry rate when opening", async () => {
    const res = await request(await app())
      .post("/short/sell")
      .send({
        stockName: "BTCUSDT",
        stockSymbol: "BTCUSDT",
        quantity: 1,
        rate: 99_999_999, // wants a sky-high entry price
      });

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(LIVE_PRICE);
    expect(prisma.shortPosition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entryPrice: LIVE_PRICE }),
      }),
    );
  });

  it("refuses to open a short with no live price", async () => {
    delete boardCache.BTCUSDT;

    const res = await request(await app())
      .post("/short/sell")
      .send({
        stockName: "BTCUSDT",
        stockSymbol: "BTCUSDT",
        quantity: 1,
        rate: 100,
      });

    expect(res.status).toBe(503);
    expect(prisma.shortPosition.create).not.toHaveBeenCalled();
  });
});

/**
 * S-08 — business errors used to surface as HTTP 500 because controllers threw
 * plain Error objects, which carry no statusCode.
 */
describe("S-08: business errors return 4xx, not 500", () => {
  it("returns 400 for insufficient margin", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER, balance: 10 });

    const res = await request(await app())
      .post("/short/sell")
      .send({ stockName: "BTCUSDT", stockSymbol: "BTCUSDT", quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient balance/i);
    expect(prisma.shortPosition.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid quantity", async () => {
    const res = await request(await app())
      .post("/short/sell")
      .send({ stockName: "BTCUSDT", stockSymbol: "BTCUSDT", quantity: -5 });

    expect(res.status).toBe(400);
  });
});
