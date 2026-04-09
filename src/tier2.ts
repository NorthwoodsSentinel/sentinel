// Tier 2 — Statistical anomaly detection against baseline
// Uses D1 for baseline storage. No LLM calls.
// Identifies "Not-Normal" by comparing current values to historical distribution.

import type { TelemetryEvent, BaselineEntry, Anomaly, AnomalySeverity, TierResult } from "./types";

// Z-score thresholds for severity classification
const THRESHOLDS = {
  low: 2.0,       // 2σ — worth noting
  medium: 2.5,    // 2.5σ — investigate
  high: 3.0,      // 3σ — likely anomaly
  critical: 4.0,  // 4σ — almost certainly anomalous
} as const;

function classifySeverity(zScore: number): AnomalySeverity | null {
  const abs = Math.abs(zScore);
  if (abs >= THRESHOLDS.critical) return "critical";
  if (abs >= THRESHOLDS.high) return "high";
  if (abs >= THRESHOLDS.medium) return "medium";
  if (abs >= THRESHOLDS.low) return "low";
  return null; // Within normal range
}

export function detectAnomaly(
  event: TelemetryEvent,
  baseline: BaselineEntry | null
): TierResult {
  // No baseline yet — can't detect anomalies
  if (!baseline || baseline.count < 10) {
    return { tier: 2, action: "normal" };
  }

  // Prevent division by zero
  if (baseline.stddev === 0) {
    // All historical values were identical — any deviation is anomalous
    if (event.value !== baseline.mean) {
      return {
        tier: 2,
        action: "anomaly",
        z_score: 999,
        context: `${event.metric} changed from constant ${baseline.mean} to ${event.value}`,
      };
    }
    return { tier: 2, action: "normal" };
  }

  const zScore = (event.value - baseline.mean) / baseline.stddev;
  const severity = classifySeverity(zScore);

  if (severity) {
    return {
      tier: 2,
      action: "anomaly",
      z_score: zScore,
      context: `${event.metric} is ${Math.abs(zScore).toFixed(1)}σ from baseline (expected: ${baseline.mean.toFixed(1)} ± ${baseline.stddev.toFixed(1)}, got: ${event.value})`,
    };
  }

  return { tier: 2, action: "normal" };
}

// --- Baseline Management ---

export interface BaselineUpdate {
  source: string;
  metric: string;
  value: number;
  timestamp: number;
}

// Welford's online algorithm for running mean/variance
// Allows updating baseline incrementally without storing all values
export function updateBaselineStats(
  current: BaselineEntry | null,
  update: BaselineUpdate
): BaselineEntry {
  if (!current) {
    return {
      source: update.source,
      metric: update.metric,
      mean: update.value,
      stddev: 0,
      count: 1,
      min: update.value,
      max: update.value,
      window_hours: 24,
      updated_at: update.timestamp,
    };
  }

  const n = current.count + 1;
  const delta = update.value - current.mean;
  const newMean = current.mean + delta / n;
  const delta2 = update.value - newMean;

  // Running variance using Welford's method
  // We store stddev but compute variance internally
  const oldVariance = current.stddev * current.stddev * (current.count - 1 || 1);
  const newVariance = oldVariance + delta * delta2;
  const newStddev = n > 1 ? Math.sqrt(newVariance / (n - 1)) : 0;

  return {
    source: current.source,
    metric: current.metric,
    mean: newMean,
    stddev: newStddev,
    count: n,
    min: Math.min(current.min, update.value),
    max: Math.max(current.max, update.value),
    window_hours: current.window_hours,
    updated_at: update.timestamp,
  };
}

// --- D1 Operations ---

export async function getBaseline(
  db: D1Database,
  source: string,
  metric: string
): Promise<BaselineEntry | null> {
  const row = await db
    .prepare("SELECT * FROM baselines WHERE source = ? AND metric = ?")
    .bind(source, metric)
    .first();

  if (!row) return null;

  return {
    source: row.source as string,
    metric: row.metric as string,
    mean: row.mean as number,
    stddev: row.stddev as number,
    count: row.count as number,
    min: row.min_val as number,
    max: row.max_val as number,
    window_hours: row.window_hours as number,
    updated_at: row.updated_at as number,
  };
}

export async function upsertBaseline(
  db: D1Database,
  entry: BaselineEntry
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO baselines (source, metric, mean, stddev, count, min_val, max_val, window_hours, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, metric) DO UPDATE SET
         mean = excluded.mean,
         stddev = excluded.stddev,
         count = excluded.count,
         min_val = excluded.min_val,
         max_val = excluded.max_val,
         updated_at = excluded.updated_at`
    )
    .bind(
      entry.source,
      entry.metric,
      entry.mean,
      entry.stddev,
      entry.count,
      entry.min,
      entry.max,
      entry.window_hours,
      entry.updated_at
    )
    .run();
}

export async function recordAnomaly(
  db: D1Database,
  anomaly: Anomaly
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO anomalies (id, source, metric, expected, actual, z_score, severity, narrative, detected_at, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      anomaly.id,
      anomaly.source,
      anomaly.metric,
      anomaly.expected,
      anomaly.actual,
      anomaly.z_score,
      anomaly.severity,
      anomaly.narrative || null,
      anomaly.detected_at,
      anomaly.acknowledged ? 1 : 0
    )
    .run();
}
