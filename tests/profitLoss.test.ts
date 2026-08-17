import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createMockPrisma, buildTestApp } from "./helpers/mockPrisma.js";
import { istDayKey } from "../src/utils/istDay.js";

const prisma = createMockPrisma();
vi.mock("../src/db/db.js", () => ({ default: prisma }));

const { getProfitLoss } = await import("../src/controllers/userController.js");

const USER = "user-1";

/** An order as getProfitLoss reads it. `createdAt` decides the day bucket. */
function order(
  type: "buy" | "sell",
  total: number,
  createdAt: string,
  symbol = "BTCUSDT",
) {
  return {
    userId: USER,
    stockSymbol: symbol,
    type,
    stockTotal: total,
    stockQuantity: 1,
    status: "completed",
    createdAt: new Date(createdAt),
  };
}

async function app() {
  return buildTestApp((a) => {
    a.get(
      "/stats/pl",
      (req: any, _res, next) => {
        req.user = { id: USER };
        next();
      },
      getProfitLoss as any,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("daily P/L series", () => {
  it("sums to exactly the realizedPL reported beside it", async () => {
    // The invariant the account page depends on: the chart and the stat card
    // are derived from the same trades, so they must never disagree.
    prisma.order.findMany.mockResolvedValue([
      order("buy", 1000, "2026-08-10T06:00:00Z"),
      order("sell", 1500, "2026-08-11T06:00:00Z"),
      order("buy", 300, "2026-08-12T06:00:00Z"),
      order("sell", 800, "2026-08-12T09:00:00Z"),
    ]);

    const res = await request(await app()).get("/stats/pl?days=30");
    expect(res.status).toBe(200);

    const { dailyPL, realizedPL } = res.body.data;
    const summed = dailyPL.reduce((a: number, d: any) => a + d.value, 0);

    expect(summed).toBeCloseTo(realizedPL, 6);
    expect(realizedPL).toBeCloseTo(1000, 6); // (1500 + 800) - (1000 + 300)
  });

  it("buckets by IST day, not UTC", async () => {
    // 20:00 UTC on the 10th is 01:30 IST on the 11th. Bucketing by UTC would
    // file this under the 10th and leave the user's evening split across two
    // days on the chart.
    prisma.order.findMany.mockResolvedValue([
      order("sell", 500, "2026-08-10T20:00:00Z"),
    ]);

    const res = await request(await app()).get("/stats/pl?days=30");
    const hit = res.body.data.dailyPL.find((d: any) => d.value !== 0);

    expect(hit.date).toBe("2026-08-11");
  });

  it("zero-fills days with no trades so the axis is continuous", async () => {
    prisma.order.findMany.mockResolvedValue([
      order("sell", 100, new Date().toISOString()),
    ]);

    const res = await request(await app()).get("/stats/pl?days=7");
    const { dailyPL } = res.body.data;

    // Every day in the window is present, in ascending order, with no holes.
    expect(dailyPL.length).toBeGreaterThan(1);
    expect(dailyPL.every((d: any) => typeof d.value === "number")).toBe(true);

    const dates = dailyPL.map((d: any) => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("ends on today so the chart's right edge is now", async () => {
    prisma.order.findMany.mockResolvedValue([]);

    const res = await request(await app()).get("/stats/pl?days=30");
    const { dailyPL } = res.body.data;

    expect(dailyPL.at(-1).date).toBe(istDayKey(new Date()));
  });

  it("returns an all-zero series for a user who has never traded", async () => {
    // Previously the client fabricated 30 zero points when the server sent
    // nothing. The server now says so itself, so the client never invents data.
    prisma.order.findMany.mockResolvedValue([]);

    const res = await request(await app()).get("/stats/pl?days=30");
    const { dailyPL, realizedPL } = res.body.data;

    expect(realizedPL).toBe(0);
    expect(dailyPL.length).toBeGreaterThan(0);
    expect(dailyPL.every((d: any) => d.value === 0)).toBe(true);
  });
});
