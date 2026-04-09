// Sentinel — Core Types

export interface Env {
  SENTINEL_AGENT: DurableObjectNamespace;
  TELEMETRY_R2: R2Bucket;
  BASELINE_D1: D1Database;
  ANTHROPIC_API_KEY: string;
  ENVIRONMENT: string;
}

// --- Telemetry ---

export interface TelemetryEvent {
  source: string;          // e.g., "unifi", "paloalto", "cloudflare"
  timestamp: number;       // Unix ms
  metric: string;          // e.g., "dns_query", "outbound_connection", "new_destination"
  value: number;           // Numeric value for the metric
  metadata: Record<string, string>;  // Flexible key-value pairs
}

export interface TelemetryBatch {
  events: TelemetryEvent[];
  ingested_at: number;
}

// --- Baseline ---

export interface BaselineEntry {
  source: string;
  metric: string;
  mean: number;
  stddev: number;
  count: number;
  min: number;
  max: number;
  window_hours: number;
  updated_at: number;
}

// --- Anomaly ---

export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface Anomaly {
  id: string;
  source: string;
  metric: string;
  expected: number;
  actual: number;
  z_score: number;
  severity: AnomalySeverity;
  narrative?: string;       // Filled by Tier 3 (LLM)
  detected_at: number;
  acknowledged: boolean;
}

// --- Three-Tier Reasoning ---

export type TierResult =
  | { tier: 1; action: "known_good" }
  | { tier: 1; action: "known_bad"; reason: string }
  | { tier: 2; action: "anomaly"; z_score: number; context: string }
  | { tier: 2; action: "normal" }
  | { tier: 3; action: "narrative"; narrative: string };

// --- Ingestion API ---

export interface IngestResponse {
  stored: number;
  anomalies: number;
  processing_ms: number;
}

// --- Agent State ---

export interface SentinelState {
  client_id: string;
  baseline_ready: boolean;
  total_events_ingested: number;
  total_anomalies_detected: number;
  last_ingestion: number;
  cold_start_complete: boolean;
}
