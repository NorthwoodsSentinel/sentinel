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
| 2026-10-31 | Three runtime dependencies the code never imports (`agents`, `@cloudflare/ai-chat`, `@anthropic-ai/sdk`) and an unused test runner carried one critical and fifteen high advisories into every install; two lockfiles could drift apart. | The unused packages and the empty test script were removed, Wrangler moved to 4.151.1, and the project now has a single `bun.lock`. `bun audit`: no vulnerabilities; typecheck and dry-run build pass. | Margin / review pending | *Three rooms were kept furnished that no one ever entered, and the damp came in through them; now the house is only the rooms it lives in.* |
