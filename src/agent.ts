// SentinelAgent — The forensic reasoning brain
// Durable Object with SQLite state, WebSocket support, alarm scheduling.
// Forensic methodology encoded as edge compute.

import { DurableObject } from "cloudflare:workers";
import type { Env, TelemetryEvent, TelemetryBatch, Anomaly, SentinelState, IngestResponse } from "./types";
import { tier1BatchFilter } from "./tier1";
import { detectAnomaly, getBaseline, upsertBaseline, updateBaselineStats, recordAnomaly } from "./tier2";
import { generateNarrative } from "./tier3";

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
      // Update baseline with this event
      const currentBaseline = this.getBaselineLocal(event.source, event.metric);
      const updated = updateBaselineStats(currentBaseline, {
        source: event.source,
        metric: event.metric,
        value: event.value,
        timestamp: event.timestamp,
      });
      this.upsertBaselineLocal(updated);

      // Check for anomaly against the PREVIOUS baseline (before this event)
      if (currentBaseline && currentBaseline.count >= 10) {
        const result = detectAnomaly(event, currentBaseline);
        if (result.tier === 2 && result.action === "anomaly") {
          const anomaly: Anomaly = {
            id: `${event.source}-${event.timestamp}-${crypto.randomUUID().slice(0, 8)}`,
            source: event.source,
            metric: event.metric,
            expected: currentBaseline.mean,
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

      return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ error: message }, { status: 500, headers: corsHeaders });
    }
  }
}
