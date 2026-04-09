// Tier 1 — Instant filtering via regex/pattern matching
// No LLM, no database. Pure CPU. Sub-millisecond.
// Filters known-good and known-bad before anything hits Tier 2.

import type { TelemetryEvent, TierResult } from "./types";

// Known-good patterns — traffic we EXPECT and can skip
const KNOWN_GOOD: Array<{ metric: string; pattern: RegExp; reason: string }> = [
  // DNS to expected resolvers
  { metric: "dns_query", pattern: /^(8\.8\.8\.8|8\.8\.4\.4|1\.1\.1\.1|1\.0\.0\.1)$/, reason: "public_dns_resolver" },
  // NTP
  { metric: "outbound_connection", pattern: /^(time\.|ntp\.|pool\.ntp\.org)/, reason: "ntp_sync" },
  // OS update servers
  { metric: "outbound_connection", pattern: /\.(windowsupdate\.com|apple\.com\/updates|ubuntu\.com)$/, reason: "os_updates" },
  // CDN traffic
  { metric: "outbound_connection", pattern: /\.(cloudflare\.com|akamaized\.net|cloudfront\.net|fastly\.net)$/, reason: "cdn_traffic" },
];

// Known-bad patterns — immediate flags
const KNOWN_BAD: Array<{ metric: string; pattern: RegExp; reason: string }> = [
  // Tor exit nodes (destination patterns)
  { metric: "outbound_connection", pattern: /\.onion$/, reason: "tor_hidden_service" },
  // Known C2 ports on unusual protocols
  { metric: "outbound_connection", pattern: /:(4444|5555|6666|31337)$/, reason: "suspicious_port" },
  // DNS over HTTPS to non-standard resolvers (potential exfil)
  { metric: "dns_query", pattern: /doh\.((?!cloudflare|google|quad9).)*\./, reason: "non_standard_doh" },
];

export function tier1Filter(event: TelemetryEvent): TierResult {
  const destination = event.metadata.destination || "";

  // Check known-good first (fast path)
  for (const rule of KNOWN_GOOD) {
    if (event.metric === rule.metric && rule.pattern.test(destination)) {
      return { tier: 1, action: "known_good" };
    }
  }

  // Check known-bad
  for (const rule of KNOWN_BAD) {
    if (event.metric === rule.metric && rule.pattern.test(destination)) {
      return { tier: 1, action: "known_bad", reason: rule.reason };
    }
  }

  // Neither — pass to Tier 2
  // Return as normal so Tier 2 can do statistical analysis
  return { tier: 2, action: "normal" };
}

// Batch filter — returns events that need Tier 2 analysis
export function tier1BatchFilter(events: TelemetryEvent[]): {
  known_good: number;
  known_bad: TelemetryEvent[];
  needs_analysis: TelemetryEvent[];
} {
  const result = {
    known_good: 0,
    known_bad: [] as TelemetryEvent[],
    needs_analysis: [] as TelemetryEvent[],
  };

  for (const event of events) {
    const tier1 = tier1Filter(event);
    if (tier1.action === "known_good") {
      result.known_good++;
    } else if (tier1.tier === 1 && tier1.action === "known_bad") {
      result.known_bad.push(event);
    } else {
      result.needs_analysis.push(event);
    }
  }

  return result;
}
