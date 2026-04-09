# Sentinel

**Edge-native network intelligence — AI that knows how a network lives.**

Sentinel is a forensic reasoning engine deployed on Cloudflare's edge. Instead of alerting on known threats, it baselines every flow, DNS query, and device behavior to detect "Not-Normal" — anomalies that signature-based tools miss.

## Architecture

```
Telemetry Sources          Cloudflare Edge              Output
─────────────────          ───────────────              ──────
Palo Alto Firewall  ─┐
                     ├──→  Worker (Ingestion)
UniFi Network       ─┤         │
                     │    Tier 1: Regex Filter
Cloudflare Logs     ─┘    (known-good/known-bad)
                               │
                          Tier 2: Statistical
                          (z-score vs baseline)
                               │
                          Tier 3: LLM Narrative
                          (Claude, anomalies only)
                               │
                          ┌────┴────┐
                     Durable Object    R2
                     (baseline state)  (telemetry archive)
                          │
                     Dashboard / API / Voice
```

### Three-Tier Reasoning

| Tier | Method | Cost | Latency |
|------|--------|------|---------|
| 1 | Regex/pattern matching | Zero | Sub-ms |
| 2 | Statistical anomaly detection (Welford's algorithm) | Zero | ~1ms |
| 3 | LLM forensic narrative (Claude) | ~$0.003/anomaly | ~2s |

Only Tier 2 anomalies reach the LLM. The vast majority of traffic is filtered by Tier 1 (known-good) or scored as normal by Tier 2. This makes the architecture cost-efficient at scale.

### Key Primitives

- **Durable Objects** — Per-client stateful agent with SQLite. Baselines, anomaly history, and agent state persist across requests.
- **R2** — "Dawn of Time" telemetry storage. Zero egress fees. Keep everything.
- **Workers** — Ingestion endpoint. Routes telemetry to the correct client's DO.
- **AI Gateway** — Forensic audit trail. Every LLM call is logged.

## API

```
POST /ingest?client=home     Ingest a telemetry batch
GET  /status?client=home     Agent state (events ingested, anomalies detected)
GET  /anomalies?client=home  Recent anomalies with severity
GET  /baselines?client=home  Current baseline statistics
GET  /health                 Service health check
```

## Philosophy

> "The industry has been cutting the ends off the ham for thirty years — forcing security into expensive boxes because that's how hardware-limited networking worked. The pot doesn't exist anymore. The kitchen is the entire global network."

Sentinel doesn't install agents. It doesn't require log shipping. It lives where the traffic lives — at the edge — and remembers everything.

## Status

**v0.1.0** — Scaffold. Compiles, typed, ready for CF resource creation and deployment.

## License

Proprietary — Northwoods Sentinel Labs
