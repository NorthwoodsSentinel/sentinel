# Kintsugi

Kintsugi is the Japanese art of mending broken pottery with gold, so the repair becomes part of the object's history instead of something hidden.

This file is the same idea for code. Every fix here leaves a seam in three places, all carrying the same gold line:

- a short `kintsugi:` comment at the repair site;
- a `Kintsugi:` trailer on the commit;
- an entry in this append-only ledger.

The seam shows the break; it doesn't hide it. Security fixes describe what kind of thing was mended, never how to exploit it.

A repair is entered as "review pending". The reviewer is recorded only after the review has happened, in a later commit that names the verdict and the commit it reviewed, so this ledger never claims a review before it exists.

| Date | What broke | How it was mended | Mended by / reviewed by | Gold line |
|---|---|---|---|---|
| 2026-10-31 | Three runtime dependencies the code never imports (`agents`, `@cloudflare/ai-chat`, `@anthropic-ai/sdk`) and an unused test runner carried one critical and fifteen high advisories into every install; two lockfiles could drift apart. | The unused packages and the empty test script were removed, Wrangler moved to 4.151.1, and the project now has a single `bun.lock`. `bun audit`: no vulnerabilities; typecheck and dry-run build pass. | Margin / Codex read-only audit, AUDIT: pass, reviewed 05ba7a9 | *Three rooms were kept furnished that no one ever entered, and the damp came in through them; now the house is only the rooms it lives in.* |
| 2026-11-01 | The dashboard loaded Chart.js from jsDelivr with no integrity check, and from `chart.umd.min.js`, a file Chart.js 4.4.7 does not publish; jsDelivr generates it on request and warns against pinning it. | Both pages load the published `dist/chart.umd.js` with `integrity="sha384-zYPBGX…"` and `crossorigin="anonymous"`. The hash was computed from the npm registry tarball (whose sha512 matches the registry's own integrity) and the CDN file is byte-identical to it. | Margin / review pending | *The dashboard once took its charting from a stranger by name alone, a name the stranger could answer with anything; now it checks the face against a likeness kept at home, and the seam runs gold.* |
