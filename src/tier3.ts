// Tier 3 — LLM Forensic Narrative Generation
// Only called for Tier 2 anomalies. This is where cost lives.
// Claude generates a human-readable forensic narrative explaining
// what's happening, why it matters, and what to do about it.

import type { Anomaly, BaselineEntry } from "./types";

interface NarrativeContext {
  anomaly: Anomaly;
  baseline: BaselineEntry | null;
  recentAnomalies: Anomaly[];
  totalEventsIngested: number;
}

const SYSTEM_PROMPT = `You are a forensic network analyst with 20 years of experience. Your job is to explain network anomalies in plain language that a non-technical executive can understand, while preserving the technical precision a security engineer needs.

Rules:
- Lead with what happened, then why it matters, then what to do
- Use specific numbers (times, bytes, counts) — never vague
- Compare against the baseline in concrete terms
- If this could be benign, say so — don't manufacture urgency
- If this is genuinely concerning, be direct about the risk
- Keep it under 200 words
- No jargon without explanation
- No "it's worth noting" or "it's important to note" — just say the thing`;

function buildPrompt(ctx: NarrativeContext): string {
  const { anomaly, baseline, recentAnomalies, totalEventsIngested } = ctx;

  let prompt = `Analyze this network anomaly and generate a forensic narrative.\n\n`;

  prompt += `## Anomaly\n`;
  prompt += `- Source: ${anomaly.source}\n`;
  prompt += `- Metric: ${anomaly.metric}\n`;
  prompt += `- Expected value: ${anomaly.expected.toFixed(2)}\n`;
  prompt += `- Actual value: ${anomaly.actual}\n`;
  prompt += `- Z-score: ${anomaly.z_score.toFixed(1)} standard deviations from baseline\n`;
  prompt += `- Severity: ${anomaly.severity}\n`;
  prompt += `- Detected at: ${new Date(anomaly.detected_at).toISOString()}\n\n`;

  if (baseline) {
    prompt += `## Baseline Context\n`;
    prompt += `- Historical mean: ${baseline.mean.toFixed(2)}\n`;
    prompt += `- Standard deviation: ${baseline.stddev.toFixed(2)}\n`;
    prompt += `- Sample count: ${baseline.count} observations\n`;
    prompt += `- Range: ${baseline.min} to ${baseline.max}\n`;
    prompt += `- Window: ${baseline.window_hours} hours\n\n`;
  }

  if (recentAnomalies.length > 0) {
    prompt += `## Recent Anomaly Context (last 24h)\n`;
    prompt += `- Total anomalies in window: ${recentAnomalies.length}\n`;
    const bySeverity = recentAnomalies.reduce((acc, a) => {
      acc[a.severity] = (acc[a.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    prompt += `- By severity: ${Object.entries(bySeverity).map(([k, v]) => `${k}=${v}`).join(", ")}\n`;
    const sameMetric = recentAnomalies.filter(a => a.metric === anomaly.metric).length;
    if (sameMetric > 1) {
      prompt += `- Same metric repeated ${sameMetric} times — possible pattern\n`;
    }
    prompt += `\n`;
  }

  prompt += `## System State\n`;
  prompt += `- Total events ingested: ${totalEventsIngested}\n\n`;

  prompt += `Generate the forensic narrative.`;

  return prompt;
}

export async function generateNarrative(
  ctx: NarrativeContext,
  apiKey: string
): Promise<string> {
  const prompt = buildPrompt(ctx);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: prompt }
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  return data.content[0]?.text || "Narrative generation failed — no content returned.";
}
