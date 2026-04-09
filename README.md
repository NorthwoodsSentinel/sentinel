# Sentinel

**Edge-native network intelligence — AI that knows how a network lives.**

Built entirely on Cloudflare Workers, Durable Objects, R2, and D1. No boxes. No agents to install. No log shipping. The intelligence lives where the traffic lives — at the edge.

## The Problem: The Small Pot

There's an old family story. A daughter watches her mother cut the ends off the ham before putting it in the roasting pan. Every holiday, same ritual. She grows up and does the same thing. One day she finally asks her mother why.

"Because that's how my mother did it."

So they ask the grandmother. She laughs.

*"I cut the ends off because the only pot I had was too small to fit the whole ham."*

Three generations of wasted ham because nobody questioned a constraint that no longer existed.

**That's the cybersecurity industry.**

For 30 years, we've been cutting the ends off the data. Ship your logs to someone else's cloud. Pay per GB for ingestion. Wait for a dashboard to tell you about the threat they've already cataloged. Normal traffic — the 99% that defines what your network actually looks like — gets discarded. The pot was too small.

The pot isn't small anymore. Cloudflare R2 has zero egress costs. Durable Objects give you persistent state at the edge. The kitchen is the entire global network. But the industry keeps cutting the ends off the ham — because that's how it's always been done.

Meanwhile, AI-generated attacks are novel by default. Signature-based detection is collapsing. The only durable defense is *knowing your own network so well that anomalies are obvious*.

## The Architecture

Sentinel deploys a persistent AI analyst directly onto Cloudflare's edge. Each client gets an isolated Durable Object that builds a living baseline from every packet, flow, and DNS query. It doesn't alert on known-bad. It detects **not-normal**.

```
Telemetry Sources          Cloudflare Edge              Output
─────────────────          ───────────────              ──────
Firewall Logs       ─┐
                     ├──→  Worker (Ingestion)
Network Controller  ─┤         │
                     │    Tier 1: Regex Filter ──── known-good (discard)
DNS / Flow Data     ─┘    (sub-millisecond)     └── known-bad (immediate alert)
                               │
                          Tier 2: Statistical ──── normal (update baseline)
                          Anomaly Detection    └── anomaly (z-score > 2.5σ)
                          (Welford's algorithm)
                               │
                          Tier 3: LLM Narrative
                          (Claude, anomalies only)
                               │
                     ┌─────────┴──────────┐
                Durable Object          R2 Bucket
                (baseline state,        (telemetry archive,
                 anomaly history,        "Dawn of Time"
                 SQLite)                 storage)
                     │
                REST API / Dashboard / Voice
```

### Three-Tier Reasoning

The cost-efficiency solve. Not everything needs an LLM.

| Tier | Method | Cost | Latency | Purpose |
|------|--------|------|---------|---------|
| 1 | Regex/pattern matching | $0 | <1ms | Filter known-good and known-bad instantly |
| 2 | Statistical anomaly detection | $0 | ~1ms | Welford's online algorithm — running mean/variance with O(1) memory |
| 3 | LLM forensic narrative | ~$0.003/anomaly | ~3s | Claude generates human-readable incident narrative |

Only Tier 2 anomalies reach the LLM. Tier 1 filters the noise. Tier 2 finds the signal. Tier 3 tells the story.

### Sample Tier 3 Narrative

When Sentinel detects a statistical anomaly, it generates a forensic narrative like this:

> **What Happened:** Your network controller sent 50,000 bytes outbound — roughly 10x its normal traffic volume of 4,870 bytes. This is the largest value in the entire baseline.
>
> **Why It Matters:** The 186-standard-deviation z-score is significant, but the baseline is built on only 16 data points. The statistical model is immature. That said, 50,000 bytes from a network controller at end-of-business deserves scrutiny.
>
> **What To Do:**
> 1. Check the destination IP/domain — legitimate traffic goes to known cloud infrastructure
> 2. Correlate with firmware updates or admin sessions active at that time
> 3. Expand the baseline to at least 100 observations before treating z-scores as reliable
>
> **Verdict:** Investigate before escalating. Likely benign, not confirmed benign.

Not an alert. A story. With context, caveats, and actionable next steps.

## API

```
GET  /health                          Service health check
GET  /status?client={id}              Agent state, events ingested, anomalies
GET  /anomalies?client={id}&limit=20  Recent anomalies with narratives
GET  /baselines?client={id}           Current baseline statistics
POST /ingest?client={id}              Ingest telemetry batch
POST /narrative?client={id}           Generate narrative for a specific anomaly
```

### Ingest Format

```json
{
  "events": [
    {
      "source": "unifi",
      "timestamp": 1744214400000,
      "metric": "outbound_bytes",
      "value": 5200,
      "metadata": { "destination": "api.example.com" }
    }
  ],
  "ingested_at": 1744214400000
}
```

## Cloudflare Primitives Used

| Primitive | Role |
|-----------|------|
| **Workers** | HTTP ingestion endpoint, request routing |
| **Durable Objects** | Per-client stateful agent with embedded SQLite — baselines, anomaly history, agent state |
| **R2** | Zero-egress telemetry archive — keep everything, forever |
| **D1** | Indexed metadata and cross-client queries |
| **Secrets** | Anthropic API key for Tier 3 narrative generation |

### Why Cloudflare

- **Data sovereignty by architecture.** Each client's data lives in their own DO + R2. Nothing is commingled.
- **Zero egress cost on R2.** The "Dawn of Time" corpus — storing years of telemetry — is economically viable because you don't pay to read it.
- **Durable Object SQLite.** Welford's algorithm needs persistent state that survives restarts. DO SQLite gives sub-millisecond reads with 10GB storage per object.
- **WebSocket hibernation.** Agents stay connected to dashboards without billing for idle time. This makes always-on monitoring economically viable.
- **Global edge deployment.** The analyst runs in 300+ cities. Latency to the nearest ingestion point is negligible.

## Deploy Your Own

```bash
# Clone
git clone https://github.com/NorthwoodsSentinel/sentinel.git
cd sentinel

# Create Cloudflare resources
wrangler r2 bucket create sentinel-telemetry
wrangler d1 create sentinel-baselines
# Copy the database_id into wrangler.toml

# Set your Anthropic API key (for Tier 3 narratives)
wrangler secret put ANTHROPIC_API_KEY

# Deploy
wrangler deploy

# Test
curl https://your-worker.workers.dev/health
```

## The Thesis

> "They will try to find unknown exploits through a technique that the defender will have a signature for — because it thought of it too."

If AI makes exploitation cheap, it makes proactive defense cheap too. The attacker uses AI to find vulnerabilities. The defender uses the *same AI* to baseline normal behavior so aggressively that the AI-generated exploit looks "not-normal" — even without a signature.

**Known-bad detection is a small pot.** Sentinel is the whole kitchen.

## Roadmap

- [ ] Zero Trust auth wrapper (Cloudflare Access)
- [ ] Real telemetry pollers (UniFi API, Palo Alto syslog, Cloudflare Logpush)
- [ ] Vectorize integration for RAG over historical telemetry
- [ ] Cold start industry baselines (healthcare, education, financial)
- [ ] Dashboard UI (React + AI Gateway analytics)
- [ ] RealtimeKit voice interface — talk to your Sentinel from your phone
- [ ] Workers for Platforms — multi-tenant deployment template
- [ ] Agentic defense — AI generates defensive signatures proactively

## Background

This project encodes 20 years of network forensic methodology into edge compute. The approach comes from a career spent reading firewall logs, building timelines, and reconstructing what happened on compromised networks. The core insight: an experienced analyst doesn't look for known threats — they notice when something feels wrong. Sentinel digitizes that intuition.

Built by [Northwoods Sentinel Labs](https://northwoodssentinel.com).

## License

MIT
