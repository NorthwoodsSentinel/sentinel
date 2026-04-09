// Data Compaction & Sliding Window Baselines
//
// Solves:
// 1. R2 object growth (1,440 writes/day → roll up to hourly/daily aggregates)
// 2. Baseline drift (exponential decay so recent data matters more)
// 3. Stale anomaly cleanup (purge acknowledged anomalies older than 30 days)
//
// Run via scheduled alarm on the Durable Object (daily at 3 AM UTC)

interface CompactionStats {
  anomalies_purged: number;
  baselines_decayed: number;
  domains_cleaned: number;
  ran_at: number;
}

// --- Exponential Decay for Baselines ---
//
// Problem: Welford's algorithm treats every observation equally.
// A reading from 3 months ago has the same weight as one from today.
// Solution: Apply a decay factor that reduces the effective count
// of old observations, making the baseline adapt to gradual changes.

const DECAY_FACTOR = 0.995;  // Per-observation decay — ~50% weight after 138 observations
const MIN_COUNT_AFTER_DECAY = 10;  // Never decay below this

export function decayBaseline(
  mean: number,
  stddev: number,
  count: number,
  decayFactor: number = DECAY_FACTOR
): { mean: number; stddev: number; count: number } {
  // Reduce effective count — this widens the confidence interval
  // for old data, making the baseline more responsive to recent changes
  const decayedCount = Math.max(
    MIN_COUNT_AFTER_DECAY,
    Math.floor(count * decayFactor)
  );

  // Slightly inflate stddev to account for potential drift
  // This prevents false positives from seasonal changes
  const inflationFactor = 1 + (1 - decayFactor) * 2;  // ~1.01 per decay cycle
  const decayedStddev = stddev * inflationFactor;

  return {
    mean,  // Mean stays — we don't shift it, just widen the envelope
    stddev: decayedStddev,
    count: decayedCount,
  };
}

// --- Anomaly Cleanup ---

const ANOMALY_RETENTION_DAYS = 30;
const ACKNOWLEDGED_RETENTION_DAYS = 7;

export function getAnomalyPurgeCutoff(): { acknowledged: number; unacknowledged: number } {
  const now = Date.now();
  return {
    acknowledged: now - (ACKNOWLEDGED_RETENTION_DAYS * 86400000),
    unacknowledged: now - (ANOMALY_RETENTION_DAYS * 86400000),
  };
}

// --- Domain Cleanup ---
// Domains not seen in 90 days get archived (moved to a separate table or deleted)

const DOMAIN_STALE_DAYS = 90;

export function getDomainStaleCutoff(): number {
  return Date.now() - (DOMAIN_STALE_DAYS * 86400000);
}

// --- R2 Compaction Strategy ---
//
// Raw telemetry in R2 follows this lifecycle:
//   0-24h:  Raw events (individual JSON objects per poll)
//   1-7d:   Hourly aggregates (merge raw into hourly summaries)
//   7-90d:  Daily aggregates (merge hourly into daily summaries)
//   90d+:   Monthly aggregates (merge daily into monthly)
//
// This is documented but not implemented in R2 yet — requires
// a scheduled Worker to read, aggregate, and rewrite objects.
// For now, the DO SQLite handles the aggregation internally.

export interface HourlyAggregate {
  source: string;
  metric: string;
  hour_start: number;  // Unix ms of the hour start
  count: number;
  sum: number;
  mean: number;
  min: number;
  max: number;
  stddev: number;
}

export interface DailyAggregate {
  source: string;
  metric: string;
  day_start: number;  // Unix ms of the day start (midnight UTC)
  count: number;
  sum: number;
  mean: number;
  min: number;
  max: number;
  stddev: number;
  hourly_breakdown: number[];  // 24-element array, count per hour
}

// --- Compaction Runner ---
// Called by the DO alarm system

export function runCompaction(sql: {
  exec: (query: string, ...params: any[]) => { toArray: () => any[] };
}): CompactionStats {
  const stats: CompactionStats = {
    anomalies_purged: 0,
    baselines_decayed: 0,
    domains_cleaned: 0,
    ran_at: Date.now(),
  };

  // 1. Purge old acknowledged anomalies
  const ackCutoff = getAnomalyPurgeCutoff();
  const ackResult = sql.exec(
    "DELETE FROM anomalies WHERE acknowledged = 1 AND detected_at < ?",
    ackCutoff.acknowledged
  );
  const unackResult = sql.exec(
    "DELETE FROM anomalies WHERE detected_at < ?",
    ackCutoff.unacknowledged
  );

  // 2. Decay baselines
  const baselines = sql.exec("SELECT * FROM baselines").toArray();
  for (const b of baselines) {
    const decayed = decayBaseline(
      b.mean as number,
      b.stddev as number,
      b.count as number
    );
    sql.exec(
      "UPDATE baselines SET stddev = ?, count = ? WHERE source = ? AND metric = ?",
      decayed.stddev, decayed.count, b.source, b.metric
    );
    stats.baselines_decayed++;
  }

  // Decay hourly baselines too
  const hourlyBaselines = sql.exec("SELECT * FROM hourly_baselines").toArray();
  for (const b of hourlyBaselines) {
    const decayed = decayBaseline(
      b.mean as number,
      b.stddev as number,
      b.count as number
    );
    sql.exec(
      "UPDATE hourly_baselines SET stddev = ?, count = ? WHERE source = ? AND metric = ? AND hour = ?",
      decayed.stddev, decayed.count, b.source, b.metric, b.hour
    );
  }

  // 3. Clean stale domains
  const domainCutoff = getDomainStaleCutoff();
  sql.exec(
    "DELETE FROM known_domains WHERE last_seen < ? AND total_queries <= 2",
    domainCutoff
  );

  return stats;
}
