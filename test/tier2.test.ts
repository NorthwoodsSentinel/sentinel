// Tier 2 statistics (z-score severity, Welford update) and the D1 helpers' SQL and bindings.
import { describe, expect, it, vi } from "vitest";
import { detectAnomaly, getBaseline, recordAnomaly, updateBaselineStats, upsertBaseline } from "../src/tier2";
import type { Anomaly, BaselineEntry, TelemetryEvent } from "../src/types";

const ev = (value: number): TelemetryEvent => ({ source: "s", timestamp: 1, metric: "m", value, metadata: {} });
const base = (over: Partial<BaselineEntry> = {}): BaselineEntry => ({
  source: "s",
  metric: "m",
  mean: 10,
  stddev: 2,
  count: 20,
  min: 5,
  max: 15,
  window_hours: 24,
  updated_at: 0,
  ...over,
});

describe("detectAnomaly", () => {
  it("is normal without a baseline or with fewer than 10 samples", () => {
    expect(detectAnomaly(ev(100), null)).toEqual({ tier: 2, action: "normal" });
    expect(detectAnomaly(ev(100), base({ count: 9 }))).toEqual({ tier: 2, action: "normal" });
  });

  it("handles a constant baseline (stddev 0)", () => {
    expect(detectAnomaly(ev(10), base({ stddev: 0 }))).toEqual({ tier: 2, action: "normal" });
    expect(detectAnomaly(ev(11), base({ stddev: 0 }))).toEqual({
      tier: 2,
      action: "anomaly",
      z_score: 999,
      context: "m changed from constant 10 to 11",
    });
  });

  it.each([
    [14, 2], // 2.0 sigma: low
    [15, 2.5], // medium
    [16, 3], // high
    [18, 4], // critical
    [2, -4], // below the mean counts too
  ])("value %d is an anomaly at z=%d", (value, z) => {
    const r = detectAnomaly(ev(value), base());
    expect(r).toMatchObject({ tier: 2, action: "anomaly", z_score: z });
    if (r.action === "anomaly") expect(r.context).toContain(`${Math.abs(z).toFixed(1)}σ from baseline`);
  });

  it("is normal inside 2 sigma", () => {
    expect(detectAnomaly(ev(13.9), base())).toEqual({ tier: 2, action: "normal" });
  });
});

describe("updateBaselineStats", () => {
  it("starts a baseline from the first value", () => {
    expect(updateBaselineStats(null, { source: "s", metric: "m", value: 7, timestamp: 42 })).toEqual({
      source: "s",
      metric: "m",
      mean: 7,
      stddev: 0,
      count: 1,
      min: 7,
      max: 7,
      window_hours: 24,
      updated_at: 42,
    });
  });

  it("updates mean, stddev, min and max incrementally", () => {
    let b = updateBaselineStats(null, { source: "s", metric: "m", value: 2, timestamp: 1 });
    for (const v of [4, 4, 4, 5, 5, 7, 9])
      b = updateBaselineStats(b, { source: "s", metric: "m", value: v, timestamp: 2 });
    expect(b.count).toBe(8);
    expect(b.mean).toBe(5);
    expect(b.stddev).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(b.min).toBe(2);
    expect(b.max).toBe(9);
    expect(b.window_hours).toBe(24);
    expect(b.updated_at).toBe(2);
  });
});

function fakeD1(row: Record<string, unknown> | null) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return { first: vi.fn(async () => row), run: vi.fn(async () => ({})) };
      },
    }),
  } as unknown as D1Database;
  return { db, calls };
}

describe("D1 helpers", () => {
  it("getBaseline returns null when absent and maps column names when present", async () => {
    expect(await getBaseline(fakeD1(null).db, "s", "m")).toBeNull();
    const { db, calls } = fakeD1({
      source: "s",
      metric: "m",
      mean: 1,
      stddev: 2,
      count: 3,
      min_val: 0,
      max_val: 9,
      window_hours: 24,
      updated_at: 5,
    });
    expect(await getBaseline(db, "s", "m")).toEqual(
      base({ mean: 1, stddev: 2, count: 3, min: 0, max: 9, updated_at: 5 }),
    );
    expect(calls[0]!.args).toEqual(["s", "m"]);
  });

  it("upsertBaseline binds every field in column order", async () => {
    const { db, calls } = fakeD1(null);
    await upsertBaseline(db, base());
    expect(calls[0]!.sql).toContain("ON CONFLICT (source, metric)");
    expect(calls[0]!.args).toEqual(["s", "m", 10, 2, 20, 5, 15, 24, 0]);
  });

  it("recordAnomaly stores narrative or null, and acknowledged as 1/0", async () => {
    const a: Anomaly = {
      id: "a1",
      source: "s",
      metric: "m",
      expected: 1,
      actual: 2,
      z_score: 3,
      severity: "high",
      detected_at: 4,
      acknowledged: false,
    };
    const { db, calls } = fakeD1(null);
    await recordAnomaly(db, a);
    await recordAnomaly(db, { ...a, narrative: "n", acknowledged: true });
    expect(calls[0]!.args).toEqual(["a1", "s", "m", 1, 2, 3, "high", null, 4, 0]);
    expect(calls[1]!.args).toEqual(["a1", "s", "m", 1, 2, 3, "high", "n", 4, 1]);
  });
});
