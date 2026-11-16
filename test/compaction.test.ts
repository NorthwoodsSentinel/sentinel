// Compaction: baseline decay math, retention cutoffs, and the SQL run against a real in-memory SQLite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decayBaseline, getAnomalyPurgeCutoff, getDomainStaleCutoff, runCompaction } from "../src/compaction";
import { makeCtx } from "./helpers/fakes";

const NOW = Date.UTC(2026, 5, 15, 12);
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("decayBaseline", () => {
  it("keeps the mean, shrinks the count and widens the stddev", () => {
    expect(decayBaseline(5, 2, 1000)).toEqual({ mean: 5, stddev: 2 * 1.01, count: 995 });
  });

  it("never decays the count below 10, and honours a custom factor", () => {
    expect(decayBaseline(5, 2, 10).count).toBe(10);
    expect(decayBaseline(5, 1, 100, 0.5)).toEqual({ mean: 5, stddev: 2, count: 50 });
  });
});

describe("cutoffs", () => {
  it("are 7 / 30 days for anomalies and 90 days for domains", () => {
    expect(getAnomalyPurgeCutoff()).toEqual({ acknowledged: NOW - 7 * DAY, unacknowledged: NOW - 30 * DAY });
    expect(getDomainStaleCutoff()).toBe(NOW - 90 * DAY);
  });
});

describe("runCompaction", () => {
  it("purges old anomalies, decays both baseline tables and drops stale rare domains", () => {
    const { db, ctx } = makeCtx();
    db.exec(`
      CREATE TABLE baselines (source TEXT, metric TEXT, mean REAL, stddev REAL, count INTEGER);
      CREATE TABLE hourly_baselines (source TEXT, metric TEXT, hour INTEGER, mean REAL, stddev REAL, count INTEGER);
      CREATE TABLE anomalies (id TEXT, acknowledged INTEGER, detected_at INTEGER);
      CREATE TABLE known_domains (domain TEXT, last_seen INTEGER, total_queries INTEGER);
    `);
    const ins = (sql: string, ...v: (string | number)[]) => db.prepare(sql).run(...v);
    ins("INSERT INTO baselines VALUES (?,?,?,?,?)", "s", "m", 10, 1, 1000);
    ins("INSERT INTO hourly_baselines VALUES (?,?,?,?,?,?)", "s", "m", 3, 10, 1, 200);
    ins("INSERT INTO anomalies VALUES (?,?,?)", "ack-old", 1, NOW - 8 * DAY);
    ins("INSERT INTO anomalies VALUES (?,?,?)", "ack-new", 1, NOW - 6 * DAY);
    ins("INSERT INTO anomalies VALUES (?,?,?)", "unack-old", 0, NOW - 31 * DAY);
    ins("INSERT INTO anomalies VALUES (?,?,?)", "unack-mid", 0, NOW - 8 * DAY);
    ins("INSERT INTO known_domains VALUES (?,?,?)", "stale-rare", NOW - 91 * DAY, 2);
    ins("INSERT INTO known_domains VALUES (?,?,?)", "stale-busy", NOW - 91 * DAY, 3);
    ins("INSERT INTO known_domains VALUES (?,?,?)", "fresh", NOW, 1);

    const stats = runCompaction(ctx.storage.sql);

    expect(stats).toEqual({ anomalies_purged: 0, baselines_decayed: 1, domains_cleaned: 0, ran_at: NOW });
    const ids = (sql: string) =>
      db
        .prepare(sql)
        .all()
        .map((r) => Object.values(r)[0]);
    expect(ids("SELECT id FROM anomalies ORDER BY id")).toEqual(["ack-new", "unack-mid"]);
    expect(ids("SELECT domain FROM known_domains ORDER BY domain")).toEqual(["fresh", "stale-busy"]);
    expect(db.prepare("SELECT stddev, count FROM baselines").get()).toEqual({ stddev: 1.01, count: 995 });
    expect(db.prepare("SELECT stddev, count FROM hourly_baselines").get()).toEqual({ stddev: 1.01, count: 199 });
  });
});
