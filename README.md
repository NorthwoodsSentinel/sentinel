# Sentinel

**Edge-native network intelligence.**
An open framework for understanding how your network actually behaves.

## What Sentinel Does

Sentinel observes your network over time and builds a behavioral baseline.

Instead of asking: *"Is this known to be malicious?"*

It asks: **"Is this normal for this network?"**

When something deviates, it flags it. That's it.

No signatures. No threat feeds. No assumptions about what "bad" looks like.

## The Problem: The Small Pot

There's an old family story. A daughter watches her mother cut the ends off the ham before putting it in the roasting pan. Every holiday, same ritual. She grows up and does the same thing. One day she finally asks her mother why.

"Because that's how my mother did it."

So they ask the grandmother. She laughs.

*"I cut the ends off because the only pot I had was too small to fit the whole ham."*

Three generations of wasted ham because nobody questioned a constraint that no longer existed.

**That's the cybersecurity industry.**

For 30 years, we've been cutting the ends off the data. Ship your logs to someone else's cloud. Pay per GB for ingestion. Wait for a dashboard to tell you about the threat they've already cataloged. Normal traffic — the 99% that defines what your network actually looks like — gets discarded. The pot was too small.

The pot isn't small anymore. Cloudflare R2 has zero egress costs. Durable Objects give you persistent state at the edge. But the industry keeps cutting the ends off the ham — because that's how it's always been done.

Meanwhile, AI-generated attacks are novel by default. Signature-based detection is collapsing. The only durable defense is *knowing your own network so well that anomalies are obvious*.

## How It Works

Telemetry flows through a three-tier reasoning pipeline:

```
Telemetry Sources          Edge Processing              Output
─────────────────          ───────────────              ──────
Firewall Logs       ─┐
                     ├──→  Tier 1: Regex Filter ──── known-good (discard)
Network Controller  ─┤         │                 └── known-bad (alert)
                     │
DNS / Flow Data     ─┘    Tier 2: Statistical ──── normal (update baseline)
                          Anomaly Detection    └── anomaly (z-score)
                               │
                          Tier 3: Narrative
                          (LLM, anomalies only)
                               │
                     ┌─────────┴──────────┐
                Durable Object          R2 Bucket
                (baseline state,        (telemetry archive,
                 anomaly history,        "Dawn of Time"
                 SQLite)                 storage)
```

### Tier 1 — Deterministic Filtering

Known-good patterns are discarded immediately. Known-bad patterns trigger instant alerts. Sub-millisecond execution.

### Tier 2 — Behavioral Baseline

Online statistical model using Welford's algorithm — running mean and variance with O(1) memory per metric. Hourly baselines provide time-aware behavior detection ("31 clients at 3 PM is normal; 31 clients at 3 AM is not"). Falls back to global baseline until hourly profiles have sufficient observations. Flags deviations using z-score thresholds.

### Tier 3 — Narrative Context (Optional)

Only triggered for anomalies. Converts signal into human-readable forensic narrative. Helps answer: *"Why does this matter?"*

| Tier | Method | Cost | Latency | Purpose |
|------|--------|------|---------|---------|
| 1 | Regex/pattern matching | $0 | <1ms | Filter known-good and known-bad instantly |
| 2 | Statistical anomaly detection | $0 | ~1ms | Online baseline with constant memory |
| 3 | LLM forensic narrative | ~$0.003/anomaly | ~3s | Human-readable incident context |

Only Tier 2 anomalies reach the LLM. Tier 1 filters the noise. Tier 2 finds the signal. Tier 3 tells the story.

Tier 3 is optional. Tier 1 + Tier 2 are a complete system on their own.

### Sample Tier 3 Narrative

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

## Quick Start

```bash
# Clone
git clone https://github.com/NorthwoodsSentinel/sentinel.git
cd sentinel

# Install dependencies
npm install

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

### Configure Pollers

```bash
cd poller
cp .env.example .env
# Edit .env with your Cloudflare account ID, UniFi host, Sentinel URL, etc.

# Start a poller
./gateway-dns-poller.sh          # run once
./gateway-dns-poller.sh --loop   # poll every 60s
```

## Architecture

Sentinel runs entirely at the edge. Each deployment is isolated. Your data stays in your environment.

| Primitive | Role |
|-----------|------|
| **Workers** | HTTP ingestion endpoint, request routing |
| **Durable Objects** | Per-client stateful agent with embedded SQLite — baselines, anomaly history, agent state |
| **R2** | Zero-egress telemetry archive — keep everything, forever |
| **D1** | Indexed metadata and cross-client queries |
| **Secrets** | API keys for Tier 3 narrative generation |

### Key Design Principles

**Local-first.** All processing happens inside your own infrastructure. No centralized data collection. No external pipelines.

**Behavioral, not signature-based.** Sentinel doesn't rely on known attack patterns. It learns what your network looks like and flags deviations.

**Continuous memory.** The system builds history over time. The longer it runs, the more context it has. First-seen domain detection means every DNS domain ever queried is tracked — any never-before-seen domain triggers a low-severity anomaly. The network's memory.

**Cost-aware.** Tier 1 and Tier 2: effectively zero cost. Tier 3: invoked only on anomalies. Typical deployments run for pennies per day.

**Time-aware.** Separate statistical profiles per hour of day. "Normal at 3 PM" is different from "normal at 3 AM."

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

## What's Open. What's Not.

Sentinel is open source by design.

You can deploy it, inspect it, modify it, and run it entirely on your own infrastructure. There are no hidden components.

But there is a difference between running the system and understanding what it sees.

Sentinel shows you what is not normal. It does not assume what that means for your environment.

Interpreting that signal — deciding what matters, what can be ignored, and what requires action — is not something code can fully automate.

You can use Sentinel independently. But the depth of insight depends on how well you can read the patterns it surfaces.

That is the boundary:

- The framework is open
- The data is yours
- The meaning requires context

## What Sentinel Is Not

- Not a SIEM
- Not a replacement for IDS/IPS
- Not a threat intelligence platform

It is a baseline engine.

## Known Limitations

- Assumes quasi-normal distributions (z-score based detection)
- Early baselines may be incomplete (low sample size)
- Behavioral models can be influenced by sustained changes in traffic
- Interpretation of anomalies is left to the operator
- Adversarial actors may attempt to slowly train the baseline — acknowledge this as an inherent property of statistical models

## Security Notes

- All credentials must be provided via environment variables or secret files
- No secrets are stored in the repository
- Raw telemetry may contain sensitive data — manage retention accordingly
- Dashboard is reference-grade and should not be exposed to the internet without additional access controls (Cloudflare Access recommended)

## Data Retention

Sentinel can store raw telemetry indefinitely via R2. You are responsible for:

- Retention policies appropriate to your environment
- Compliance requirements (GDPR, HIPAA, etc.)
- Lifecycle management and deletion

Apply lifecycle rules to your R2 bucket where appropriate.

## The Thesis

> "They will try to find unknown exploits through a technique that the defender will have a signature for — because it thought of it too."

If AI makes exploitation cheap, it makes proactive defense cheap too. The attacker uses AI to find vulnerabilities. The defender uses the *same AI* to baseline normal behavior so aggressively that the AI-generated exploit looks "not-normal" — even without a signature.

Known-bad detection is a small pot. Sentinel is the whole kitchen.

## Roadmap

- [ ] Zero Trust auth wrapper (Cloudflare Access)
- [ ] Additional pollers (Palo Alto syslog, Cloudflare Logpush)
- [ ] Vectorize integration for RAG over historical telemetry
- [ ] Cold start industry baselines (healthcare, education, financial)
- [ ] Dashboard UI improvements
- [ ] Workers for Platforms — multi-tenant deployment template
- [ ] Agentic defense — AI generates defensive signatures proactively

## Contributing

Contributions are welcome. Focus areas:

- Additional telemetry sources and pollers
- Improved statistical models
- Dashboard enhancements
- Performance optimization

## Background

This project encodes 20 years of network forensic methodology into edge compute. The approach comes from a career spent reading firewall logs, building timelines, and reconstructing what happened on compromised networks. The core insight: an experienced analyst doesn't look for known threats — they notice when something feels wrong. Sentinel digitizes that intuition.

Built by [Northwoods Sentinel Labs](https://northwoodssentinel.com).

## License

MIT

---

Sentinel is easy to run. It is not easy to ignore.
