# Offer Guard

Verify that ad promises match the approved offer — and build a PAUSED, pixel-proven
replacement when they don't. Meta Global AI Developer Hackathon (Indie track).

Design source of truth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

Day-1 model kill tests (Oct 29, live Model API calls, read-only; Graph API untouched).
Both Hebrew and English ads are supported (6 fixtures); scripts print English
by default, `--lang he` for Hebrew.

- **Repair proof** — `npm run killtest:repair`: ALL PASS on all 6 ads
  (Oct 29 rerun). ad-01 clean (he+en) → CLEAN, no repair; ad-02 wrong (he+en)
  → repaired with zero-diff pixel proof (0 changed outside the panel, 0 in the
  protected mask), PNG round-trip OK, fresh-Spark revalidation PASS; ad-03
  overlap (he+en) → REFUSED with `panel_not_opaque` + `panel_overlaps_protected`.
  Panel snap hits {x:90,y:840,w:900,h:170} exactly on ad-01/ad-02 (both
  languages) from rough Spark boxes; the logo mask is the union of the `logo`
  phrase (circle mark) and a box prompt on Spark's `logo_bbox` (wordmark).
  Artifacts (gitignored) at `artifacts/repair/<ad>/`: before/after/panel/
  masks/diff PNGs + proof, revalidation and result JSON.
- **Ad extraction (Spark 1.3)** — `npm run killtest:spark`: all semantic
  fields PASS on all 6 ads (language he/en correct, percent/scope/shipping/
  valid_until exact, verbatim offer words, tagline never listed as an offer,
  panel opaque correct). Panel bbox IoU passes the Hebrew ads (0.88/0.82/0.95)
  and ad-03-en (0.93) but the English bottom-panel ads score 0.66 — Spark boxes
  the text block plus padding instead of the full panel edges (same known
  roughness as Hebrew ad-01's 0.66 in the first run; threshold kept — the
  repair pipeline never uses the rough box directly, it snaps to exact edges).
  JSON-schema `response_format` works; coordinates come back in source pixels.
- **Protection masks (SAM 3.1)** — `npm run killtest:sam`: ALL PASS on ad-02 +
  ad-03. First phrases worked (`bottle`, `logo`; no box fallback needed);
  product mask IoU 0.99/1.00 with fill 0.89/0.55; ad-02 protected∩panel = 0 px
  (repair allowed); ad-03 protected∩panel = 1506 px (correct
  "panel overlaps protected product" blocker). Overlays at
  `artifacts/killtests/sam-<ad>.png` (gitignored) for human inspection.
  Follow-up: `logo` segments the circle mark only, not the wordmark — the
  repair pipeline protects both (union of the phrase mask and a box prompt on
  Spark's `logo_bbox`).

## Day-1 probe

Proves the Meta write path on our own account: upload a test image, create a
PAUSED ad in our PAUSED ad set, and read it back. Nothing else is touched —
no existing ads are edited, no budgets, no campaigns or ad sets.

Setup:

```sh
cp .env.example .env   # then fill in the real IDs + token (never commit .env)
npm install
```

Run (dry run is the default — POSTs are printed, not sent):

```sh
npm run probe:meta              # dry run: safe reads + local test image only
npm run probe:meta -- --execute # actually create the PAUSED probe ad
```

Every step is logged to the console and appended to `.local/probe-journal.jsonl`
(gitignored; request summaries never contain the token).

Clean up the probe objects (only the IDs recorded in the journal, nothing else):

```sh
npm run cleanup:probe              # dry run: list what would be deleted
npm run cleanup:probe -- --execute # delete the probe ads + creatives
```

Safety details: the ad set must exist and must NOT be ACTIVE or the probe aborts;
the only status ever sent is `PAUSED`; a timed-out POST is never retried blindly
(the probe looks the object up by name first); Graph errors print `code`,
`error_subcode`, `error_user_msg` and `fbtrace_id`, then stop.

## Tests

```sh
npm test        # vitest: config, masking, PAUSED guard, repair units (snap, templates, bidi, proof, i18n)
npm run typecheck
npm run killtest:repair            # live repair proof on all 6 ads (Model API, read-only)
npm run killtest:repair -- --lang he  # same, Hebrew output
```

The repair renderer needs Chromium once: `npx playwright install chromium`.
Panel fonts are bundled Noto Sans + Noto Sans Hebrew (`@fontsource` packages,
SIL Open Font License — license text in `node_modules/@fontsource/*/LICENSE`),
loaded from local files at render time, never from the network.

## Layout

`src/shared` (schemas, config, guards, i18n) · `src/server/meta|browser|workflow|models|repair` ·
`src/web` · `scripts` (day-1 probes) · `fixtures/ads` (synthetic test ads, fictional brand) ·
`tests` · `.local` (gitignored runtime journal + generated images).

## How this was built

Everything in this repository was written during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026), mostly with **Muse Code**, Meta's coding agent.
The commit history is the timeline of the work. After each Muse Code session we export its redacted log (`npm run buildlog:save -- <label>`); these logs are kept outside the public repo and can be shared with the judges on request.
