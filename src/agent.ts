// SentinelAgent — The forensic reasoning brain
// Durable Object with SQLite state, WebSocket support, alarm scheduling.
// Forensic methodology encoded as edge compute.

import { DurableObject } from "cloudflare:workers";
import type { Env, TelemetryEvent, TelemetryBatch, Anomaly, SentinelState, IngestResponse } from "./types";
import { tier1BatchFilter } from "./tier1";
import { detectAnomaly, getBaseline, upsertBaseline, updateBaselineStats, recordAnomaly } from "./tier2";
import { generateNarrative } from "./tier3";
import { runCompaction } from "./compaction";

export class SentinelAgent extends DurableObject<Env> {
  private state: SentinelState = {
    client_id: "default",
    baseline_ready: false,
    total_events_ingested: 0,
    total_anomalies_detected: 0,
    last_ingestion: 0,
    cold_start_complete: false,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initStorage();
    this.loadState();
    this.scheduleCompaction();
  }

  private scheduleCompaction(): void {
    // Schedule daily compaction at 3 AM UTC
    const now = new Date();
    const next3AM = new Date(now);
    next3AM.setUTCHours(3, 0, 0, 0);
    if (next3AM.getTime() <= now.getTime()) {
      next3AM.setUTCDate(next3AM.getUTCDate() + 1);
    }
    this.ctx.storage.setAlarm(next3AM.getTime());
  }

  async alarm(): Promise<void> {
    // Daily compaction: decay baselines, purge old anomalies, clean stale domains
    const stats = runCompaction(this.ctx.storage.sql);
    console.log(`Compaction complete: ${JSON.stringify(stats)}`);

    // Store last compaction stats
    await this.ctx.storage.put("last_compaction", stats);

    // Reschedule for tomorrow
    this.scheduleCompaction();
  }

  private initStorage(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS baselines (
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        mean REAL NOT NULL,
        stddev REAL NOT NULL,
        count INTEGER NOT NULL,
        min_val REAL NOT NULL,
        max_val REAL NOT NULL,
        window_hours INTEGER DEFAULT 24,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, metric)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS anomalies (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        expected REAL,
        actual REAL,
        z_score REAL,
        severity TEXT,
        narrative TEXT,
        detected_at INTEGER NOT NULL,
        acknowledged INTEGER DEFAULT 0
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_anomalies_detected
      ON anomalies(detected_at DESC)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_anomalies_severity
      ON anomalies(severity, acknowledged)
    `);

    // Device registry — maps MAC/IP to friendly names
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        mac_address TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ip_address TEXT,
        device_type TEXT,
        vlan TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      )
    `);

    // First-seen domain tracking — the "memory" of DNS history
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS known_domains (
        domain TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        total_queries INTEGER DEFAULT 1,
        categories TEXT,
        application TEXT
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_known_domains_first_seen
      ON known_domains(first_seen DESC)
    `);

    // Alert log — track what notifications were sent
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        anomaly_id TEXT,
        channel TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        payload TEXT
      )
    `);

    // Time-of-day baselines — separate stats per hour (0-23)
    // "31 clients at 3 PM is normal. 31 clients at 3 AM is not."
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hourly_baselines (
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        hour INTEGER NOT NULL,
        mean REAL NOT NULL,
        stddev REAL NOT NULL,
        count INTEGER NOT NULL,
        min_val REAL NOT NULL,
        max_val REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, metric, hour)
      )
    `);
  }

  private async loadState(): Promise<void> {
    const saved = await this.ctx.storage.get<SentinelState>("agent_state");
    if (saved) {
      this.state = saved;
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put("agent_state", this.state);
  }

  // --- Telemetry Ingestion ---

  async ingest(batch: TelemetryBatch): Promise<IngestResponse> {
    const start = Date.now();
    let anomalyCount = 0;

    // Tier 1: Fast filter
    const { known_good, known_bad, needs_analysis } = tier1BatchFilter(batch.events);

    // Record known-bad as immediate anomalies
    for (const event of known_bad) {
      const anomaly: Anomaly = {
        id: `${event.source}-${event.timestamp}-${crypto.randomUUID().slice(0, 8)}`,
        source: event.source,
        metric: event.metric,
        expected: 0,
        actual: event.value,
        z_score: 999,
        severity: "high",
        narrative: `Tier 1 match: known-bad pattern in ${event.metric}`,
        detected_at: Date.now(),
        acknowledged: false,
      };
      this.recordAnomalyLocal(anomaly);
      anomalyCount++;
    }

    // Tier 2: Statistical analysis for events that passed Tier 1
    for (const event of needs_analysis) {
      const currentHour = new Date(event.timestamp).getUTCHours();

      // Update global baseline
      const currentBaseline = this.getBaselineLocal(event.source, event.metric);
      const updated = updateBaselineStats(currentBaseline, {
        source: event.source,
        metric: event.metric,
        value: event.value,
        timestamp: event.timestamp,
      });
      this.upsertBaselineLocal(updated);

      // Update hourly baseline (time-of-day awareness)
      this.upsertHourlyBaseline(event.source, event.metric, currentHour, event.value, event.timestamp);

      // Choose the best baseline for anomaly detection:
      // - Use hourly baseline if it has enough data (more precise)
      // - Fall back to global baseline otherwise
      const hourlyBaseline = this.getHourlyBaseline(event.source, event.metric, currentHour);
      const bestBaseline = (hourlyBaseline && hourlyBaseline.count >= 5) ? hourlyBaseline : currentBaseline;

      // Check for anomaly against the PREVIOUS baseline (before this event)
      if (bestBaseline && bestBaseline.count >= 10) {
        const result = detectAnomaly(event, bestBaseline);
        if (result.tier === 2 && result.action === "anomaly") {
          const isHourly = (hourlyBaseline && hourlyBaseline.count >= 5);
          const anomaly: Anomaly = {
            id: `${event.source}-${event.timestamp}-${crypto.randomUUID().slice(0, 8)}`,
            source: event.source,
            metric: event.metric,
            expected: bestBaseline.mean,
            actual: event.value,
            z_score: result.z_score,
            severity: result.z_score >= 4 ? "critical" : result.z_score >= 3 ? "high" : result.z_score >= 2.5 ? "medium" : "low",
            detected_at: Date.now(),
            acknowledged: false,
          };
          this.recordAnomalyLocal(anomaly);
          anomalyCount++;
        }
      }
    }

    // Tier 3: Generate LLM narratives for medium+ anomalies (async, non-blocking)
    if (this.env.ANTHROPIC_API_KEY) {
      const recentAnomalies = this.getRecentAnomaliesLocal(20);
      for (const event of needs_analysis) {
        const currentBaseline = this.getBaselineLocal(event.source, event.metric);
        const matchingAnomaly = recentAnomalies.find(
          a => a.source === event.source && a.metric === event.metric && !a.narrative &&
               (a.severity === "medium" || a.severity === "high" || a.severity === "critical")
        );
        if (matchingAnomaly) {
          this.ctx.waitUntil(
            generateNarrative(
              {
                anomaly: matchingAnomaly,
                baseline: currentBaseline,
                recentAnomalies,
                totalEventsIngested: this.state.total_events_ingested,
              },
              this.env.ANTHROPIC_API_KEY
            ).then(narrative => {
              this.ctx.storage.sql.exec(
                "UPDATE anomalies SET narrative = ? WHERE id = ?",
                narrative, matchingAnomaly.id
              );
            }).catch(err => {
              console.error(`Tier 3 narrative failed for ${matchingAnomaly.id}:`, err);
            })
          );
        }
      }
    }

    // Track DNS domains (first-seen detection)
    for (const event of batch.events) {
      const domain = event.metadata?.domain;
      if (domain && event.metric === "dns_domain_queries") {
        const categories = event.metadata?.categories || "";
        const application = event.metadata?.application || "";
        const isNew = this.trackDomain(domain, categories, application);
        if (isNew && this.state.baseline_ready) {
          // New domain after baseline is established — noteworthy
          const newDomainAnomaly: Anomaly = {
            id: `first-seen-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            source: "cloudflare-gateway",
            metric: "first_seen_domain",
            expected: 0,
            actual: 1,
            z_score: 0,
            severity: "low",
            narrative: `First-seen domain: ${domain}. This domain has never been queried by any device on this network before.${categories ? ` Categories: ${categories}.` : ""}${application ? ` Application: ${application}.` : ""}`,
            detected_at: Date.now(),
            acknowledged: false,
          };
          this.recordAnomalyLocal(newDomainAnomaly);
          anomalyCount++;
        }
      }

      // Track device info if present
      if (event.metadata?.mac_address && event.metadata?.device_name) {
        this.upsertDevice(
          event.metadata.mac_address,
          event.metadata.device_name,
          event.metadata?.ip_address || "",
          event.metadata?.device_type || "unknown",
          event.metadata?.vlan || ""
        );
      }
    }

    // Send alerts for high/critical anomalies
    if (anomalyCount > 0) {
      const recent = this.getRecentAnomaliesLocal(5);
      for (const a of recent) {
        if ((a.severity === "high" || a.severity === "critical") && !a.acknowledged) {
          this.ctx.waitUntil(this.sendAlert(a));
        }
      }
    }

    // Store raw telemetry in R2 ("Dawn of Time")
    const r2Key = `telemetry/${batch.events[0]?.source || "unknown"}/${Date.now()}.json`;
    await this.env.TELEMETRY_R2.put(r2Key, JSON.stringify(batch));

    // Update state
    this.state.total_events_ingested += batch.events.length;
    this.state.total_anomalies_detected += anomalyCount;
    this.state.last_ingestion = Date.now();

    if (!this.state.baseline_ready && this.state.total_events_ingested >= 100) {
      this.state.baseline_ready = true;
    }

    await this.saveState();

    return {
      stored: batch.events.length,
      anomalies: anomalyCount,
      processing_ms: Date.now() - start,
    };
  }

  // --- Local SQLite operations (DO-internal, no D1 needed) ---

  private getBaselineLocal(source: string, metric: string): import("./types").BaselineEntry | null {
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM baselines WHERE source = ? AND metric = ?", source, metric)
      .toArray()[0];

    if (!row) return null;

    return {
      source: row.source as string,
      metric: row.metric as string,
      mean: row.mean as number,
      stddev: row.stddev as number,
      count: row.count as number,
      min: row.min_val as number,
      max: row.max_val as number,
      window_hours: (row.window_hours as number) || 24,
      updated_at: row.updated_at as number,
    };
  }

  private upsertBaselineLocal(entry: import("./types").BaselineEntry): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO baselines (source, metric, mean, stddev, count, min_val, max_val, window_hours, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, metric) DO UPDATE SET
         mean = excluded.mean,
         stddev = excluded.stddev,
         count = excluded.count,
         min_val = excluded.min_val,
         max_val = excluded.max_val,
         updated_at = excluded.updated_at`,
      entry.source, entry.metric, entry.mean, entry.stddev, entry.count,
      entry.min, entry.max, entry.window_hours, entry.updated_at
    );
  }

  private recordAnomalyLocal(anomaly: Anomaly): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO anomalies (id, source, metric, expected, actual, z_score, severity, narrative, detected_at, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      anomaly.id, anomaly.source, anomaly.metric, anomaly.expected, anomaly.actual,
      anomaly.z_score, anomaly.severity, anomaly.narrative || null, anomaly.detected_at,
      anomaly.acknowledged ? 1 : 0
    );
  }

  // --- Hourly Baseline (Time-of-Day Awareness) ---

  private getHourlyBaseline(source: string, metric: string, hour: number): import("./types").BaselineEntry | null {
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM hourly_baselines WHERE source = ? AND metric = ? AND hour = ?", source, metric, hour)
      .toArray()[0];

    if (!row) return null;

    return {
      source: row.source as string,
      metric: row.metric as string,
      mean: row.mean as number,
      stddev: row.stddev as number,
      count: row.count as number,
      min: row.min_val as number,
      max: row.max_val as number,
      window_hours: 1,
      updated_at: row.updated_at as number,
    };
  }

  private upsertHourlyBaseline(source: string, metric: string, hour: number, value: number, timestamp: number): void {
    const existing = this.getHourlyBaseline(source, metric, hour);

    if (!existing) {
      this.ctx.storage.sql.exec(
        `INSERT INTO hourly_baselines (source, metric, hour, mean, stddev, count, min_val, max_val, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
        source, metric, hour, value, value, value, timestamp
      );
      return;
    }

    // Welford's online update
    const n = existing.count + 1;
    const delta = value - existing.mean;
    const newMean = existing.mean + delta / n;
    const delta2 = value - newMean;
    const oldVariance = existing.stddev * existing.stddev * (existing.count - 1 || 1);
    const newVariance = oldVariance + delta * delta2;
    const newStddev = n > 1 ? Math.sqrt(newVariance / (n - 1)) : 0;

    this.ctx.storage.sql.exec(
      `UPDATE hourly_baselines SET mean = ?, stddev = ?, count = ?, min_val = ?, max_val = ?, updated_at = ?
       WHERE source = ? AND metric = ? AND hour = ?`,
      newMean, newStddev, n, Math.min(existing.min, value), Math.max(existing.max, value), timestamp,
      source, metric, hour
    );
  }

  // --- Device Registry ---

  private upsertDevice(mac: string, name: string, ip: string, deviceType: string, vlan: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (mac_address, name, ip_address, device_type, vlan, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mac_address) DO UPDATE SET
         name = excluded.name,
         ip_address = excluded.ip_address,
         last_seen = excluded.last_seen`,
      mac, name, ip, deviceType, vlan, now, now
    );
  }

  // --- First-Seen Domain Tracking ---

  private trackDomain(domain: string, categories: string, application: string): boolean {
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec("SELECT domain FROM known_domains WHERE domain = ?", domain)
      .toArray()[0];

    if (existing) {
      // Known domain — update last_seen and count
      this.ctx.storage.sql.exec(
        "UPDATE known_domains SET last_seen = ?, total_queries = total_queries + 1 WHERE domain = ?",
        now, domain
      );
      return false; // not new
    } else {
      // NEW DOMAIN — never seen before
      this.ctx.storage.sql.exec(
        `INSERT INTO known_domains (domain, first_seen, last_seen, total_queries, categories, application)
         VALUES (?, ?, ?, 1, ?, ?)`,
        domain, now, now, categories, application
      );
      return true; // first time
    }
  }

  private getRecentNewDomains(limit: number): Array<{ domain: string; first_seen: number; categories: string; application: string }> {
    return this.ctx.storage.sql
      .exec("SELECT domain, first_seen, categories, application FROM known_domains ORDER BY first_seen DESC LIMIT ?", limit)
      .toArray()
      .map(row => ({
        domain: row.domain as string,
        first_seen: row.first_seen as number,
        categories: (row.categories as string) || "",
        application: (row.application as string) || "",
      }));
  }

  private getKnownDomainCount(): number {
    const row = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM known_domains").toArray()[0];
    return (row?.cnt as number) || 0;
  }

  // --- Alerting ---

  private async sendAlert(anomaly: Anomaly): Promise<void> {
    const webhookUrl = await this.ctx.storage.get<string>("alert_webhook");
    if (!webhookUrl) return;

    const payload = {
      content: `**[${(anomaly.severity || "unknown").toUpperCase()}] Sentinel Alert**\n` +
        `**${anomaly.source}** : ${anomaly.metric}\n` +
        `Expected: ${(anomaly.expected || 0).toFixed(1)} — Actual: ${anomaly.actual} — Z-score: ${(anomaly.z_score || 0).toFixed(1)}σ\n` +
        (anomaly.narrative ? `\n${anomaly.narrative.slice(0, 500)}` : ""),
    };

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      this.ctx.storage.sql.exec(
        "INSERT INTO alerts (id, anomaly_id, channel, sent_at, payload) VALUES (?, ?, ?, ?, ?)",
        crypto.randomUUID(), anomaly.id, "webhook", Date.now(), JSON.stringify(payload)
      );
    } catch (err) {
      console.error("Alert send failed:", err);
    }
  }

  private getRecentAnomaliesLocal(limit: number): Anomaly[] {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM anomalies ORDER BY detected_at DESC LIMIT ?", limit)
      .toArray();

    return rows.map((row) => ({
      id: row.id as string,
      source: row.source as string,
      metric: row.metric as string,
      expected: row.expected as number,
      actual: row.actual as number,
      z_score: row.z_score as number,
      severity: row.severity as import("./types").AnomalySeverity,
      narrative: row.narrative as string | undefined,
      detected_at: row.detected_at as number,
      acknowledged: (row.acknowledged as number) === 1,
    }));
  }

  // --- Query APIs ---

  async getStatus(): Promise<SentinelState> {
    return this.state;
  }

  async getRecentAnomalies(limit: number = 20): Promise<Anomaly[]> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM anomalies ORDER BY detected_at DESC LIMIT ?", limit)
      .toArray();

    return rows.map((row) => ({
      id: row.id as string,
      source: row.source as string,
      metric: row.metric as string,
      expected: row.expected as number,
      actual: row.actual as number,
      z_score: row.z_score as number,
      severity: row.severity as import("./types").AnomalySeverity,
      narrative: row.narrative as string | undefined,
      detected_at: row.detected_at as number,
      acknowledged: (row.acknowledged as number) === 1,
    }));
  }

  async getBaselines(): Promise<import("./types").BaselineEntry[]> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM baselines ORDER BY source, metric")
      .toArray();

    return rows.map((row) => ({
      source: row.source as string,
      metric: row.metric as string,
      mean: row.mean as number,
      stddev: row.stddev as number,
      count: row.count as number,
      min: row.min_val as number,
      max: row.max_val as number,
      window_hours: (row.window_hours as number) || 24,
      updated_at: row.updated_at as number,
    }));
  }

  // --- HTTP Handler ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for dashboard
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === "/ingest" && request.method === "POST") {
        const batch = await request.json() as TelemetryBatch;
        const result = await this.ingest(batch);
        return Response.json(result, { headers: corsHeaders });
      }

      if (path === "/status") {
        const status = await this.getStatus();
        return Response.json(status, { headers: corsHeaders });
      }

      if (path === "/anomalies") {
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const anomalies = await this.getRecentAnomalies(limit);
        return Response.json(anomalies, { headers: corsHeaders });
      }

      if (path === "/baselines") {
        const baselines = await this.getBaselines();
        return Response.json(baselines, { headers: corsHeaders });
      }

      if (path === "/narrative" && request.method === "POST") {
        if (!this.env.ANTHROPIC_API_KEY) {
          return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503, headers: corsHeaders });
        }
        const { anomaly_id } = await request.json() as { anomaly_id: string };
        const anomalies = this.getRecentAnomaliesLocal(100);
        const anomaly = anomalies.find(a => a.id === anomaly_id);
        if (!anomaly) {
          return Response.json({ error: "Anomaly not found" }, { status: 404, headers: corsHeaders });
        }
        const baseline = this.getBaselineLocal(anomaly.source, anomaly.metric);
        const narrative = await generateNarrative(
          { anomaly, baseline, recentAnomalies: anomalies, totalEventsIngested: this.state.total_events_ingested },
          this.env.ANTHROPIC_API_KEY
        );
        // Update the stored anomaly with the narrative
        this.ctx.storage.sql.exec("UPDATE anomalies SET narrative = ? WHERE id = ?", narrative, anomaly_id);
        return Response.json({ anomaly_id, narrative }, { headers: corsHeaders });
      }

      // Devices registry
      if (path === "/devices") {
        const rows = this.ctx.storage.sql
          .exec("SELECT * FROM devices ORDER BY last_seen DESC")
          .toArray();
        return Response.json(rows, { headers: corsHeaders });
      }

      // Known domains — the network's DNS memory
      if (path === "/domains") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const sort = url.searchParams.get("sort") || "recent"; // recent or frequent
        const query = sort === "frequent"
          ? "SELECT * FROM known_domains ORDER BY total_queries DESC LIMIT ?"
          : "SELECT * FROM known_domains ORDER BY first_seen DESC LIMIT ?";
        const rows = this.ctx.storage.sql.exec(query, limit).toArray();
        const total = this.getKnownDomainCount();
        return Response.json({ total_known_domains: total, domains: rows }, { headers: corsHeaders });
      }

      // New domains — only domains first seen in the last N hours
      if (path === "/domains/new") {
        const hours = parseInt(url.searchParams.get("hours") || "24");
        const since = Date.now() - (hours * 60 * 60 * 1000);
        const rows = this.ctx.storage.sql
          .exec("SELECT * FROM known_domains WHERE first_seen > ? ORDER BY first_seen DESC", since)
          .toArray();
        return Response.json({ hours, new_domains: rows.length, domains: rows }, { headers: corsHeaders });
      }

      // Configure alert webhook
      if (path === "/alerts/webhook" && request.method === "POST") {
        const { url: webhookUrl } = await request.json() as { url: string };
        await this.ctx.storage.put("alert_webhook", webhookUrl);
        return Response.json({ configured: true, url: webhookUrl }, { headers: corsHeaders });
      }

      // Get alert webhook config
      if (path === "/alerts/webhook") {
        const webhookUrl = await this.ctx.storage.get<string>("alert_webhook");
        return Response.json({ configured: !!webhookUrl, url: webhookUrl || null }, { headers: corsHeaders });
      }

      // Alert history
      if (path === "/alerts") {
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const rows = this.ctx.storage.sql
          .exec("SELECT * FROM alerts ORDER BY sent_at DESC LIMIT ?", limit)
          .toArray();
        return Response.json(rows, { headers: corsHeaders });
      }

      // Compaction status
      if (path === "/compaction") {
        const lastCompaction = await this.ctx.storage.get("last_compaction");
        return Response.json(lastCompaction || { message: "No compaction has run yet. Scheduled daily at 3 AM UTC." }, { headers: corsHeaders });
      }

      // Force compaction (manual trigger)
      if (path === "/compaction" && request.method === "POST") {
        const stats = runCompaction(this.ctx.storage.sql);
        await this.ctx.storage.put("last_compaction", stats);
        return Response.json(stats, { headers: corsHeaders });
      }

      // Hourly baselines — the daily rhythm
      if (path === "/baselines/hourly") {
        const metric = url.searchParams.get("metric") || "";
        const source = url.searchParams.get("source") || "";
        let query = "SELECT * FROM hourly_baselines";
        const params: any[] = [];
        if (source && metric) {
          query += " WHERE source = ? AND metric = ?";
          params.push(source, metric);
        }
        query += " ORDER BY source, metric, hour";
        const rows = this.ctx.storage.sql.exec(query, ...params).toArray();
        return Response.json(rows, { headers: corsHeaders });
      }

      // Enhanced status with domain stats
      if (path === "/status/full") {
        const status = await this.getStatus();
        const domainCount = this.getKnownDomainCount();
        const deviceCount = this.ctx.storage.sql
          .exec("SELECT COUNT(*) as cnt FROM devices").toArray()[0];
        const recentNewDomains = this.ctx.storage.sql
          .exec("SELECT COUNT(*) as cnt FROM known_domains WHERE first_seen > ?", Date.now() - 86400000)
          .toArray()[0];

        return Response.json({
          ...status,
          known_domains: domainCount,
          tracked_devices: (deviceCount?.cnt as number) || 0,
          new_domains_24h: (recentNewDomains?.cnt as number) || 0,
        }, { headers: corsHeaders });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ error: message }, { status: 500, headers: corsHeaders });
    }
  }
}
