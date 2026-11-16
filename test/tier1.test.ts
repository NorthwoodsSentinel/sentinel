// Tier 1 pattern filter: known-good skips, known-bad flags, everything else goes on to Tier 2.
import { describe, expect, it } from "vitest";
import { tier1BatchFilter, tier1Filter } from "../src/tier1";
import type { TelemetryEvent } from "../src/types";

const ev = (metric: string, destination?: string): TelemetryEvent => ({
  source: "unifi",
  timestamp: 1_700_000_000_000,
  metric,
  value: 1,
  metadata: destination === undefined ? {} : { destination },
});

describe("tier1Filter", () => {
  it.each([
    ["dns_query", "1.1.1.1"],
    ["outbound_connection", "pool.ntp.org"],
    ["outbound_connection", "download.windowsupdate.com"],
    ["outbound_connection", "edge.fastly.net"],
    ["dns_domain_queries", "api.amazon.com"],
    ["dns_domain_queries", "unifi.local"],
    ["dns_domain_queries", "example.workers.dev"],
  ])("treats %s %s as known good", (metric, dest) => {
    expect(tier1Filter(ev(metric, dest))).toEqual({ tier: 1, action: "known_good" });
  });

  it.each([
    ["outbound_connection", "abc.onion", "tor_hidden_service"],
    ["outbound_connection", "10.0.0.5:4444", "suspicious_port"],
    ["dns_query", "doh.evil.example", "non_standard_doh"],
  ])("flags %s %s as known bad (%s)", (metric, dest, reason) => {
    expect(tier1Filter(ev(metric, dest))).toEqual({ tier: 1, action: "known_bad", reason });
  });

  it("does not flag DoH to a standard resolver", () => {
    expect(tier1Filter(ev("dns_query", "doh.cloudflare.example"))).toEqual({ tier: 2, action: "normal" });
  });

  it("passes unmatched events and events without a destination to Tier 2", () => {
    expect(tier1Filter(ev("outbound_connection", "unknown.example"))).toEqual({ tier: 2, action: "normal" });
    expect(tier1Filter(ev("dns_query"))).toEqual({ tier: 2, action: "normal" });
    // A known-good destination only counts for its own metric.
    expect(tier1Filter(ev("bytes_out", "1.1.1.1"))).toEqual({ tier: 2, action: "normal" });
  });
});

describe("tier1BatchFilter", () => {
  it("splits a batch into counts and lists", () => {
    const good = ev("dns_query", "8.8.8.8");
    const bad = ev("outbound_connection", "x.onion");
    const other = ev("bytes_out", "203.0.113.9");
    const r = tier1BatchFilter([good, bad, other, good]);
    expect(r.known_good).toBe(2);
    expect(r.known_bad).toEqual([bad]);
    expect(r.needs_analysis).toEqual([other]);
  });

  it("handles an empty batch", () => {
    expect(tier1BatchFilter([])).toEqual({ known_good: 0, known_bad: [], needs_analysis: [] });
  });
});
