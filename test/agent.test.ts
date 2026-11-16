// SentinelAgent (Durable Object): ingestion through the three tiers, domain and device tracking, alerting,
// the daily compaction alarm, and every HTTP route. SQL runs on a real in-memory SQLite; fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentinelAgent } from "../src/agent";
import type { Anomaly, Env, SentinelState, TelemetryBatch, TelemetryEvent } from "../src/types";
import { makeCtx, type FakeCtx } from "./helpers/fakes";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

interface Rig {
  f: FakeCtx;
  agent: SentinelAgent;
  r2: { put: ReturnType<typeof vi.fn> };
}

async function rig(opts: { apiKey?: string; state?: Partial<SentinelState> } = {}): Promise<Rig> {
  const f = makeCtx();
  if (opts.state) f.kv.set("agent_state", { ...defaultState(), ...opts.state });
  const r2 = { put: vi.fn(async () => undefined) };
  const env = { TELEMETRY_R2: r2, ENVIRONMENT: "test", ANTHROPIC_API_KEY: opts.apiKey } as unknown as Env;
  const agent = new SentinelAgent(f.ctx, env);
  await Promise.resolve(); // let the constructor's state load finish
  await Promise.resolve();
  return { f, agent, r2 };
}

function defaultState(): SentinelState {
  return {
    client_id: "default",
    baseline_ready: false,
    total_events_ingested: 0,
    total_anomalies_detected: 0,
    last_ingestion: 0,
    cold_start_complete: false,
  };
}

const ev = (over: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  source: "unifi",
  timestamp: NOW,
  metric: "bytes_out",
  value: 1,
  metadata: {},
  ...over,
});
const batch = (...events: TelemetryEvent[]): TelemetryBatch => ({ events, ingested_at: NOW });

function seedBaseline(f: FakeCtx, metric: string, mean = 10, stddev = 1, count = 20) {
  f.db
    .prepare(
      "INSERT INTO baselines (source, metric, mean, stddev, count, min_val, max_val, window_hours, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run("unifi", metric, mean, stddev, count, 0, 100, 24, 0);
}
function seedHourly(f: FakeCtx, metric: string, hour: number, mean: number, stddev: number, count: number) {
  f.db
    .prepare(
      "INSERT INTO hourly_baselines (source, metric, hour, mean, stddev, count, min_val, max_val, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run("unifi", metric, hour, mean, stddev, count, 0, 100, 0);
}
const anomalies = (f: FakeCtx) =>
  f.db.prepare("SELECT * FROM anomalies ORDER BY id").all() as unknown as (Omit<Anomaly, "acknowledged"> & {
    acknowledged: number;
  })[];

async function call(agent: SentinelAgent, path: string, init?: RequestInit) {
  return agent.fetch(new Request(`https://do.example${path}`, init));
}
const post = (agent: SentinelAgent, path: string, body: unknown) =>
  call(agent, path, { method: "POST", body: JSON.stringify(body) });

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("construction", () => {
  it("creates the schema and schedules compaction for the next 03:00 UTC (tomorrow when past it)", async () => {
    const { f } = await rig();
    const tables = f.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["alerts", "anomalies", "baselines", "devices", "hourly_baselines", "known_domains"]);
    expect(f.alarms).toEqual([Date.UTC(2026, 5, 16, 3)]);
  });

  it("schedules for today when 03:00 UTC is still ahead", async () => {
    vi.setSystemTime(Date.UTC(2026, 5, 15, 1));
    const { f } = await rig();
    expect(f.alarms).toEqual([Date.UTC(2026, 5, 15, 3)]);
  });

  it("restores saved state", async () => {
    const { agent } = await rig({ state: { client_id: "acme", total_events_ingested: 5 } });
    expect(await agent.getStatus()).toMatchObject({ client_id: "acme", total_events_ingested: 5 });
  });
});

describe("ingest", () => {
  it("records a Tier 1 known-bad event as a high anomaly and stores the raw batch in R2", async () => {
    const { f, agent, r2 } = await rig();
    const res = await agent.ingest(batch(ev({ metric: "outbound_connection", metadata: { destination: "x.onion" } })));
    expect(res).toMatchObject({ stored: 1, anomalies: 1 });
    const [a] = anomalies(f);
    expect(a).toMatchObject({
      severity: "high",
      z_score: 999,
      narrative: "Tier 1 match: known-bad pattern in outbound_connection",
    });
    expect(r2.put).toHaveBeenCalledWith(`telemetry/unifi/${NOW}.json`, expect.any(String));
    expect(await agent.getStatus()).toMatchObject({
      total_events_ingested: 1,
      total_anomalies_detected: 1,
      last_ingestion: NOW,
    });
  });

  it("skips known-good events entirely", async () => {
    const { f, agent } = await rig();
    await agent.ingest(batch(ev({ metric: "dns_query", metadata: { destination: "1.1.1.1" } })));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM baselines").get()).toEqual({ n: 0 });
  });

  it("builds global and hourly baselines from Tier 2 events", async () => {
    const { f, agent } = await rig();
    await agent.ingest(batch(ev({ value: 4 }), ev({ value: 6 })));
    await agent.ingest(batch(ev({ value: 8 })));
    expect(f.db.prepare("SELECT mean, count, min_val, max_val FROM baselines").get()).toEqual({
      mean: 6,
      count: 3,
      min_val: 4,
      max_val: 8,
    });
    const h = f.db.prepare("SELECT hour, mean, stddev, count FROM hourly_baselines").get() as Record<string, number>;
    expect(h).toMatchObject({ hour: 12, mean: 6, count: 3 });
    expect(h.stddev).toBeCloseTo(2, 10);
  });

  it.each([
    ["low", 12.2],
    ["medium", 12.7],
    ["high", 13.5],
    ["critical", 15],
  ])("classifies a %s anomaly against the global baseline", async (severity, value) => {
    const { f, agent } = await rig();
    seedBaseline(f, "m");
    const res = await agent.ingest(batch(ev({ metric: "m", value })));
    expect(res.anomalies).toBe(1);
    expect(anomalies(f)[0]).toMatchObject({ severity, expected: 10, actual: value });
  });

  it("labels a large drop as low (the severity ladder reads the signed z-score)", async () => {
    const { f, agent } = await rig();
    seedBaseline(f, "m");
    await agent.ingest(batch(ev({ metric: "m", value: 0 })));
    expect(anomalies(f)[0]).toMatchObject({ severity: "low" });
  });

  it("prefers the hourly baseline once it has 5 samples", async () => {
    const { f, agent } = await rig();
    seedBaseline(f, "m", 100, 1, 20); // the global baseline would call 10 a huge anomaly
    seedHourly(f, "m", 12, 10, 1, 4); // becomes 5 samples with this event
    const res = await agent.ingest(batch(ev({ metric: "m", value: 10 })));
    expect(res.anomalies).toBe(0);
  });

  it("does nothing statistical while the chosen baseline has fewer than 10 samples", async () => {
    const { f, agent } = await rig();
    seedBaseline(f, "m", 10, 1, 9);
    expect((await agent.ingest(batch(ev({ metric: "m", value: 1000 })))).anomalies).toBe(0);
  });

  it("asks Tier 3 for a narrative on medium+ anomalies and stores it", async () => {
    const fetchFn = stubFetch(async () => Response.json({ content: [{ type: "text", text: "narrated" }] }));
    const { f, agent } = await rig({ apiKey: "k" });
    seedBaseline(f, "m");
    seedBaseline(f, "lowm");
    await agent.ingest(batch(ev({ metric: "m", value: 15 }), ev({ metric: "lowm", value: 12.2 })));
    await f.settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const rows = anomalies(f);
    expect(rows.find((r) => r.metric === "m")!.narrative).toBe("narrated");
    expect(rows.find((r) => r.metric === "lowm")!.narrative).toBeNull();
  });

  it("logs and carries on when Tier 3 fails", async () => {
    stubFetch(async () => new Response("down", { status: 500 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, agent } = await rig({ apiKey: "k" });
    seedBaseline(f, "m");
    await agent.ingest(batch(ev({ metric: "m", value: 15 })));
    await f.settle();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Tier 3 narrative failed"), expect.any(Error));
    expect(anomalies(f)[0]!.narrative).toBeNull();
  });

  it("tracks domains, flagging first-seen ones only once the baseline is ready", async () => {
    const dns = (domain: string, extra: Record<string, string> = {}) =>
      ev({ metric: "dns_domain_queries", metadata: { domain, destination: "x.google.com", ...extra } });
    const cold = await rig();
    await cold.agent.ingest(batch(dns("a.example")));
    expect(anomalies(cold.f)).toHaveLength(0);

    const { f, agent } = await rig({ state: { baseline_ready: true } });
    const res = await agent.ingest(
      batch(dns("b.example", { categories: "Ads", application: "Tracker" }), dns("c.example"), dns("b.example")),
    );
    expect(res.anomalies).toBe(2);
    const narratives = anomalies(f).map((a) => a.narrative);
    expect(narratives).toContain(
      "First-seen domain: b.example. This domain has never been queried by any device on this network before. Categories: Ads. Application: Tracker.",
    );
    expect(narratives).toContain(
      "First-seen domain: c.example. This domain has never been queried by any device on this network before.",
    );
    expect(f.db.prepare("SELECT total_queries FROM known_domains WHERE domain = 'b.example'").get()).toEqual({
      total_queries: 2,
    });
  });

  it("ignores a domain on a non-DNS metric", async () => {
    const { f, agent } = await rig({ state: { baseline_ready: true } });
    await agent.ingest(batch(ev({ metadata: { domain: "a.example" } })));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM known_domains").get()).toEqual({ n: 0 });
  });

  it("registers devices, with defaults for missing fields", async () => {
    const { f, agent } = await rig();
    await agent.ingest(
      batch(
        ev({
          metadata: {
            mac_address: "aa",
            device_name: "Printer",
            ip_address: "10.0.0.2",
            device_type: "printer",
            vlan: "5",
          },
        }),
        ev({ metadata: { mac_address: "bb", device_name: "Thing" } }),
        ev({ metadata: { mac_address: "cc" } }),
      ),
    );
    expect(
      f.db.prepare("SELECT mac_address, ip_address, device_type, vlan FROM devices ORDER BY mac_address").all(),
    ).toEqual([
      { mac_address: "aa", ip_address: "10.0.0.2", device_type: "printer", vlan: "5" },
      { mac_address: "bb", ip_address: "", device_type: "unknown", vlan: "" },
    ]);
  });

  it("marks the baseline ready at 100 events and names an empty batch 'unknown' in R2", async () => {
    const { agent, r2 } = await rig({ state: { total_events_ingested: 99 } });
    await agent.ingest(batch());
    expect((await agent.getStatus()).baseline_ready).toBe(false);
    expect(r2.put).toHaveBeenCalledWith(`telemetry/unknown/${NOW}.json`, expect.any(String));
    await agent.ingest(batch(ev()));
    expect((await agent.getStatus()).baseline_ready).toBe(true);
  });
});

describe("alerting", () => {
  const bad = () => ev({ metric: "outbound_connection", metadata: { destination: "x.onion" } });

  it("sends nothing without a webhook", async () => {
    const fetchFn = stubFetch(async () => new Response("ok"));
    const { f, agent } = await rig();
    await agent.ingest(batch(bad()));
    await f.settle();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts high/critical unacknowledged anomalies to the webhook and logs each send", async () => {
    const fetchFn = stubFetch(async () => new Response("ok"));
    const { f, agent } = await rig();
    await post(agent, "/alerts/webhook", { url: "https://hooks.example/x" });
    f.db
      .prepare("INSERT INTO anomalies (id, source, metric, severity, detected_at, acknowledged) VALUES (?,?,?,?,?,1)")
      .run("acked", "s", "m", "critical", NOW + 1);
    f.db
      .prepare("INSERT INTO anomalies (id, source, metric, severity, detected_at) VALUES (?,?,?,NULL,?)")
      .run("blank", "s", "m", NOW - 1);
    await agent.ingest(batch(bad()));
    await f.settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://hooks.example/x");
    const content = (JSON.parse(init.body as string) as { content: string }).content;
    expect(content).toContain("**[HIGH] Sentinel Alert**");
    expect(content).toContain("Expected: 0.0 — Actual: 1 — Z-score: 999.0σ");
    expect(content).toContain("Tier 1 match");
    const alerts = (await (await call(agent, "/alerts")).json()) as { channel: string }[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.channel).toBe("webhook");
  });

  it("formats missing fields and no narrative safely", async () => {
    const fetchFn = stubFetch(async () => new Response("ok"));
    const { f, agent } = await rig();
    await f.ctx.storage.put("alert_webhook", "https://hooks.example/x");
    const send = (agent as unknown as { sendAlert: (a: Partial<Anomaly>) => Promise<void> }).sendAlert.bind(agent);
    await send({ id: "z", source: "s", metric: "m", actual: 3 });
    const content = (JSON.parse(fetchFn.mock.calls[0]![1].body as string) as { content: string }).content;
    expect(content).toBe("**[UNKNOWN] Sentinel Alert**\n**s** : m\nExpected: 0.0 — Actual: 3 — Z-score: 0.0σ\n");
  });

  it("logs a failed send and records no alert", async () => {
    stubFetch(async () => {
      throw new Error("unreachable");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, agent } = await rig();
    await f.ctx.storage.put("alert_webhook", "https://hooks.example/x");
    await agent.ingest(batch(bad()));
    await f.settle();
    expect(err).toHaveBeenCalledWith("Alert send failed:", expect.any(Error));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({ n: 0 });
  });
});

describe("alarm (daily compaction)", () => {
  it("records stats, clears a previous error and reschedules", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { f, agent } = await rig();
    f.kv.set("last_compaction_error", { old: true });
    f.alarms.length = 0;
    await agent.alarm();
    expect(f.kv.get("last_compaction")).toMatchObject({ ran_at: NOW });
    expect(f.kv.has("last_compaction_error")).toBe(false);
    expect(f.alarms).toEqual([Date.UTC(2026, 5, 16, 3)]);
  });

  it("on failure records the error, retries once in 10 minutes, then gives up until tomorrow", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, agent } = await rig();
    f.alarms.length = 0;
    f.failSqlOn = "DELETE FROM anomalies";

    await agent.alarm();
    expect(f.kv.get("last_compaction_error")).toMatchObject({
      name: "Error",
      message: "forced failure on DELETE FROM anomalies",
    });
    expect(f.kv.get("compaction_retry_count")).toBe(1);
    expect(f.alarms).toEqual([NOW + 10 * 60 * 1000]);

    await agent.alarm();
    expect(f.kv.has("compaction_retry_count")).toBe(false);
    expect(f.alarms[1]).toBe(Date.UTC(2026, 5, 16, 3));
    expect(err).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a string", "boom", { message: "boom", stack: "" }],
    ["null", null, { message: "null", stack: "" }],
  ])("records a thrown %s without crashing", async (_label, thrown, expected) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, agent } = await rig();
    f.failSqlOn = "DELETE FROM anomalies";
    f.failWith = thrown;
    await agent.alarm();
    expect(f.kv.get("last_compaction_error")).toMatchObject(expected);
  });
});

describe("HTTP routes", () => {
  it("answers CORS preflight", async () => {
    const { agent } = await rig();
    const res = await call(agent, "/anything", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("ingests over POST /ingest and reports /status and /status/full", async () => {
    const { agent } = await rig();
    const res = await post(agent, "/ingest", batch(ev({ metadata: { mac_address: "aa", device_name: "x" } })));
    expect(await res.json()).toMatchObject({ stored: 1, anomalies: 0 });
    expect(await (await call(agent, "/status")).json()).toMatchObject({ total_events_ingested: 1 });
    expect(await (await call(agent, "/status/full")).json()).toMatchObject({
      total_events_ingested: 1,
      known_domains: 0,
      tracked_devices: 1,
      new_domains_24h: 0,
    });
  });

  it("lists anomalies with a limit, and baselines", async () => {
    const { f, agent } = await rig();
    seedBaseline(f, "m");
    await agent.ingest(batch(ev({ metric: "m", value: 15 }), ev({ metric: "m", value: 16 })));
    const all = (await (await call(agent, "/anomalies")).json()) as Anomaly[];
    expect(all).toHaveLength(2);
    expect(all[0]!.acknowledged).toBe(false);
    expect(await (await call(agent, "/anomalies?limit=1")).json()).toHaveLength(1);
    const baselines = (await (await call(agent, "/baselines")).json()) as { metric: string; window_hours: number }[];
    expect(baselines.map((b) => b.metric)).toEqual(["m"]);
    expect(baselines[0]!.window_hours).toBe(24);
    expect(await agent.getRecentAnomalies()).toHaveLength(2);
  });

  it("generates a narrative on demand, with 503 / 404 when it cannot", async () => {
    const noKey = await rig();
    expect((await post(noKey.agent, "/narrative", { anomaly_id: "x" })).status).toBe(503);

    stubFetch(async () => Response.json({ content: [{ type: "text", text: "on demand" }] }));
    const { f, agent } = await rig({ apiKey: "k" });
    expect((await post(agent, "/narrative", { anomaly_id: "missing" })).status).toBe(404);
    await agent.ingest(batch(ev({ metric: "outbound_connection", metadata: { destination: "x.onion" } })));
    const id = anomalies(f)[0]!.id;
    const res = await post(agent, "/narrative", { anomaly_id: id });
    expect(await res.json()).toEqual({ anomaly_id: id, narrative: "on demand" });
    expect(anomalies(f)[0]!.narrative).toBe("on demand");
  });

  it("lists devices, domains (recent, frequent, new) and hourly baselines", async () => {
    const { f, agent } = await rig();
    const dns = (domain: string) => ev({ metric: "dns_domain_queries", metadata: { domain } });
    await agent.ingest(batch(dns("one.example"), dns("two.example"), dns("two.example")));
    f.db.prepare("UPDATE known_domains SET first_seen = ? WHERE domain = 'one.example'").run(NOW - 48 * 3600 * 1000);

    expect(await (await call(agent, "/devices")).json()).toEqual([]);
    const recent = (await (await call(agent, "/domains")).json()) as {
      total_known_domains: number;
      domains: { domain: string }[];
    };
    expect(recent.total_known_domains).toBe(2);
    expect(recent.domains.map((d) => d.domain)).toEqual(["two.example", "one.example"]);
    const frequent = (await (await call(agent, "/domains?sort=frequent&limit=1")).json()) as {
      domains: { domain: string }[];
    };
    expect(frequent.domains.map((d) => d.domain)).toEqual(["two.example"]);
    expect(await (await call(agent, "/domains/new")).json()).toMatchObject({ hours: 24, new_domains: 1 });
    expect(await (await call(agent, "/domains/new?hours=72")).json()).toMatchObject({ hours: 72, new_domains: 2 });

    seedHourly(f, "a", 1, 1, 0, 1);
    seedHourly(f, "b", 2, 1, 0, 1);
    // Three rows: the two seeded plus the one the DNS events built.
    expect(await (await call(agent, "/baselines/hourly")).json()).toHaveLength(3);
    expect(await (await call(agent, "/baselines/hourly?source=unifi&metric=b")).json()).toHaveLength(1);
    // The filter applies only when both source and metric are given.
    expect(await (await call(agent, "/baselines/hourly?metric=b")).json()).toHaveLength(3);
  });

  it("configures and reads the alert webhook", async () => {
    const { agent } = await rig();
    expect(await (await call(agent, "/alerts/webhook")).json()).toEqual({ configured: false, url: null });
    expect(await (await post(agent, "/alerts/webhook", { url: "https://hooks.example/y" })).json()).toEqual({
      configured: true,
      url: "https://hooks.example/y",
    });
    expect(await (await call(agent, "/alerts/webhook")).json()).toEqual({
      configured: true,
      url: "https://hooks.example/y",
    });
    expect(await (await call(agent, "/alerts?limit=5")).json()).toEqual([]);
  });

  it("reports compaction status before and after a run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { agent } = await rig();
    expect(await (await call(agent, "/compaction")).json()).toEqual({
      message: "No compaction has run yet. Scheduled daily at 3 AM UTC.",
    });
    await agent.alarm();
    expect(await (await call(agent, "/compaction")).json()).toMatchObject({ ran_at: NOW });
    // POST /compaction is answered by the status branch above (it matches every method first).
    expect(await (await call(agent, "/compaction", { method: "POST" })).json()).toMatchObject({ ran_at: NOW });
  });

  it("returns 404 for unknown paths and 500 with the message on errors", async () => {
    const { agent, r2 } = await rig();
    expect((await call(agent, "/nope")).status).toBe(404);
    const bad = await call(agent, "/ingest", { method: "POST", body: "not json" });
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { error: string }).error).toBeTruthy();
    r2.put.mockRejectedValueOnce("not an Error");
    const odd = await post(agent, "/ingest", batch());
    expect(await odd.json()).toEqual({ error: "Unknown error" });
  });
});
