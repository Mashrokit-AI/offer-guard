# MatchPic demo brands — synthetic only

Every brand under `fixtures/brands/` is **fictional and synthetic**, made for
this demo. No real client brand data may enter the repo.

- **GALI** — fictional thermal-bottle brand. `source-he.png` / `source-en.png`
  are the source creatives; `tpl-*.png` are Chromium-rendered brand templates
  (see `scripts/render-adfit-fixtures.ts`); `logo.png` is the rendered logo
  lockup; `frame-9x16.png` is a transparent brand frame overlay for 9:16.
  `spec-*.json` files are Spark-parsed layout specs of the templates,
  committed so fresh clones work without re-parsing (regenerate with the live
  script). `demo/` holds a finished, saved GALI job served at `GET /api/demo`:
  the 8 protected sizes plus one fast-mode LinkedIn output that passed QA
  only after an automatic retry (kept as the demo's "Auto-fixed" example —
  re-exporting the demo from the `demo` live step drops it).
- **NOA** — fictional coffee brand. `source.png` is an **AI-generated
  synthetic** photographic creative (Muse Image `muse-image-1.0`,
  `/v1/images/generations`, generated once and committed); `tpl-*.png` are
  Chromium-rendered templates for 2 sizes; `logo.png` is the rendered logo.
