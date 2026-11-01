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
- **VELA** — fictional English skincare brand (complex engine fixture).
  `bg-photo.png` is a Muse Image lifestyle background, generated once and
  committed (`scripts/gen-fixture-backgrounds.ts`); `source-en.png` and
  `tpl-*.png` (1:1, 1.91:1, 9:16) are Chromium composites of that photo with
  2 SVG products (serum bottle + cream jar), headline "Morning glow,
  bottled", subline, offer panel ("$39" + "Shop now" + terms line) and logo
  (see `scripts/render-complex-fixtures.ts`). `spec-*.json` are authored from
  the same geometry constants as the HTML — no Spark re-read needed.
- **DAFNA** — fictional Hebrew cosmetics brand (complex engine fixture,
  invented name). Same structure as VELA: committed Muse Image background,
  Chromium composites with 2 products, headline "זוהר בוקר בבקבוק", subline
  with exact Hebrew (gershayim מ״ל), offer panel ("₪149" + "לקנייה" + terms),
  logo. Templates for 1:1, 1.91:1, 9:16; specs authored from HTML geometry.
