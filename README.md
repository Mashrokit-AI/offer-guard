# MatchPic — one creative → every placement size

Our studio adapts every approved creative to 6–8 placement sizes by hand,
every day, for 100+ brands. Generic AI resizers redraw the product, break
Hebrew lettering and ignore the brand's own layout rules for each size.
MatchPic adapts with Meta's models and is trustworthy: brand templates per size,
protected product/logo pixels with proof, and a model QA check on every
output.

**Live demo: https://app.mashrokit.co.il/matchpic/**

Upload a finished creative, pick a brand and sizes, get every placement back —
in **Protected** mode (AI paints only the background; product, logo and text
go back as original pixels, with a pixel proof) or **Fast** mode (AI
recomposes the whole creative in one pass). A brand teaches its layout per
size through **templates**: past finished creatives that Spark reads into a
stored layout spec. Every output is QA-checked by a fresh Spark call; on FAIL
it retries once, then marks the output "needs review".

Everything is bilingual (English default, Hebrew toggle, RTL). All demo
brands are synthetic and fictional; nothing is ever published.

## How it works

1. **Spark** (`muse-spark-1.3`) reads the source creative: products, logo,
   verbatim headline/sub-text, offer/CTA panel, background style,
   language/direction.
2. **SAM** (`sam-3.1`) cuts exact product and logo masks (phrase + box-prompt
   union); contrast completion finishes the logo lockup when Spark's box ends
   mid-word. Code plans the layout from the brand template for that size, or
   from default rules (logo top corner by direction, product centered in the
   safe area, panel bottom), nudging free texts out of other elements.
3. **Muse Image** (`muse-image-1.0`) paints the background plate (Protected)
   or recomposes the whole creative (Fast). The wire size is aspect-only, so
   code cover-fits every output to the exact preset and verifies.
4. Code places the original pixels (uniform scale only, recorded), re-renders
   free text verbatim in Chromium with bundled Noto fonts, copies opaque
   panels as pixel blocks, and applies the brand frame overlay last.
5. A fresh **Spark** call QA-checks every output against the source analysis:
   every verbatim text exact, logo/product present and uncropped, safe area
   respected (judged against the exact safe-area pixel lines, never eyeballed
   percents), no invented text.

## Meta models used where

| Step | Model | What |
|---|---|---|
| Source analysis | `muse-spark-1.3` | elements + verbatim texts + background |
| Template reading | `muse-spark-1.3` | layout spec per size (zones 0–1) |
| Masks | `sam-3.1` | product/logo/frame masks |
| Generation | `muse-image-1.0` | background plate or full recompose |
| QA | `muse-spark-1.3` | fresh PASS/FAIL read of every output |
| Brand match | `muse-spark-1.3` | propose a brand for an upload |

## Run

```bash
npm install
npm run web        # build the UI + start on http://127.0.0.1:3023/
```

The Model API key lives **outside the repo** in
`~/.config/offer-guard/secrets.env` (`MODEL_API_KEY=…`, chmod 600) —
the historical path, kept after the MatchPic pivot. Non-secret settings go in
`.env` (see `.env.example`).

Useful commands:

```bash
npm test                    # unit tests (no network)
npm run typecheck
npm run render:adfit-fixtures   # regenerate synthetic brand assets
npm run adfit:live              # live batch: all sizes × modes + demo export
npm run ui-shots                # Playwright screenshot matrix → artifacts/ui/
```

## Env vars (all `ADFIT_*`, see `.env.example`)

The `ADFIT_*` prefix is historical — kept after the MatchPic pivot so
existing setups keep working. The names are stable; do not rename them.

`ADFIT_PORT` (3023) · `ADFIT_BASE_PATH` (/) · `ADFIT_LIVE` (on/off kill
switch) · `ADFIT_TRUST_PROXY` (0) · `ADFIT_DAILY_MODEL_CALLS` (300) ·
`ADFIT_DAILY_IMAGES` (200) · `ADFIT_RATE_PER_HOUR` (3) ·
`ADFIT_QUEUE_MAX` (3) · `ADFIT_JOB_TIMEOUT_MS` · `ADFIT_UPLOAD_MAX_BYTES`
(10 MB) · `ADFIT_UPLOAD_MAX_PIXELS` (24 MP). Model names/keys:
`MODEL_API_KEY`, `MODEL_API_BASE`, `MODEL_EXTRACT`, `MODEL_SAM`,
`MODEL_IMAGE`.

## Limits and safety

- Kill switch (`ADFIT_LIVE=off`): live work refused, saved results keep working.
- One heavy job at a time, queue ≤ 3, 3 live jobs/IP/hour, daily caps on
  model calls **and** images, sizes of one job run 2 at a time.
- Uploads: JPEG/PNG/WebP by content, ≤ 10 MB, ≤ 24 MP, re-encoded
  (metadata stripped, huge photos normalized to 1600 px), deleted after 24 h;
  visitor brands/templates expire after 24 h too. Max 3 sources × 8 sizes
  per job. Demo brands are permanent fixtures.
- The product name is one string in `src/shared/brand.ts` (exports follow
  via `BRAND_SLUG`). `ADFIT_*` env vars, `data/adfit.db`, trace step names and
  the `src/server/adfit/` dir are stable internal identifiers and intentionally
  not renamed.

## Honest limitations

- Synthetic demo brands only — no real advertisers in this demo.
- Single-image creatives with one clear product and one logo work best.
- Fast mode redraws pixels; only Protected mode carries a pixel proof (a
  soft 1–2 px feather is allowed only outside the mask core).
- The QA check reads pixels, not intent; "needs review" means a human looks.
- Fast mode follows the brand template — including placements that fall
  inside platform UI zones; QA catches most safe-area violations, but the
  vision judgment is not pixel-exact: it has flagged exactly-placed elements
  and, once, passed a Fast output whose template-taught logo sits in the
  UI zone.
- Pixel identity is for our exported PNG; platforms may recompress after upload.
- `docs/build/` is the honest build history, including the Offer Guard era.
