// Tier 3: the request sent to the model API and how its reply (or failure) is handled. fetch is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNarrative } from "../src/tier3";
import type { Anomaly, BaselineEntry } from "../src/types";

const anomaly: Anomaly = {
  id: "a1",
  source: "unifi",
  metric: "dns_query",
  expected: 10,
  actual: 50,
  z_score: 4.2,
  severity: "critical",
  detected_at: Date.UTC(2026, 0, 1),
  acknowledged: false,
};
const baseline: BaselineEntry = {
  source: "unifi",
  metric: "dns_query",
  mean: 10,
  stddev: 2,
  count: 30,
  min: 4,
  max: 18,
  window_hours: 24,
  updated_at: 0,
};

function stubFetch(res: Response) {
  // A fresh clone per call: a Response body can be read only once.
  const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => res.clone());
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("generateNarrative", () => {
  it("posts a prompt carrying the anomaly, baseline and recent context, and returns the text", async () => {
    const f = stubFetch(Response.json({ content: [{ type: "text", text: "the story" }] }));
    const recent = [anomaly, { ...anomaly, id: "a2", severity: "low" as const }, { ...anomaly, id: "a3", metric: "x" }];
    const out = await generateNarrative({ anomaly, baseline, recentAnomalies: recent, totalEventsIngested: 77 }, "k");
    expect(out).toBe("the story");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string) as { messages: { content: string }[]; system: string };
    const prompt = body.messages[0]!.content;
    expect(prompt).toContain("- Z-score: 4.2 standard deviations");
    expect(prompt).toContain("- Detected at: 2026-01-01T00:00:00.000Z");
    expect(prompt).toContain("## Baseline Context");
    expect(prompt).toContain("- Range: 4 to 18");
    expect(prompt).toContain("- Total anomalies in window: 3");
    expect(prompt).toContain("- By severity: critical=2, low=1");
    expect(prompt).toContain("- Same metric repeated 2 times");
    expect(prompt).toContain("- Total events ingested: 77");
    expect(body.system).toContain("forensic network analyst");
  });

  it("omits baseline and recent sections when there are none, and the repeat line for a single match", async () => {
    const f = stubFetch(Response.json({ content: [{ type: "text", text: "t" }] }));
    await generateNarrative({ anomaly, baseline: null, recentAnomalies: [], totalEventsIngested: 0 }, "k");
    await generateNarrative({ anomaly, baseline: null, recentAnomalies: [anomaly], totalEventsIngested: 0 }, "k");
    const prompt = (i: number) =>
      (JSON.parse(f.mock.calls[i]![1].body as string) as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt(0)).not.toContain("## Baseline Context");
    expect(prompt(0)).not.toContain("## Recent Anomaly Context");
    expect(prompt(1)).toContain("## Recent Anomaly Context");
    expect(prompt(1)).not.toContain("Same metric repeated");
  });

  it("returns a fixed message when the reply has no content", async () => {
    stubFetch(Response.json({ content: [] }));
    expect(await generateNarrative({ anomaly, baseline, recentAnomalies: [], totalEventsIngested: 0 }, "k")).toBe(
      "Narrative generation failed — no content returned.",
    );
  });

  it("throws with the status and body on an API error", async () => {
    stubFetch(new Response("rate limited", { status: 429 }));
    await expect(
      generateNarrative({ anomaly, baseline, recentAnomalies: [], totalEventsIngested: 0 }, "k"),
    ).rejects.toThrow("Claude API error (429): rate limited");
  });
});
