Next: the **repair proof** kill test from docs/ARCHITECTURE.md section 12 (sections 8 and 5 are the spec), plus **full English support**. Follow AGENTS.md. Model API calls (Spark, SAM) are allowed live, a few cents; never call the Graph API. Do not commit or push.

## 0. Bilingual — everything works in Hebrew AND English
The product will be demoed to an English-speaking jury, and must work on both Hebrew and English ads.
- New English fixtures are in `fixtures/ads/`: `ad-01-clean-en.png`, `ad-02-wrong-en.png`, `ad-03-overlap-en.png` — same layout and geometry as the Hebrew set (panel, product and logo boxes identical); only the text and direction differ. See `fixtures/ads/README.md`. Add them to `tests/fixtures/ground-truth.json`:
  - ad-01-clean-en: "20% off selected models" / "Valid until 10.11 · paid shipping" → 20, selected_models, paid, 10.11
  - ad-02-wrong-en: "30% off everything" / "+ free shipping · valid until 10.11" → 30, all, free, 10.11
  - ad-03-overlap-en: "30% off everything" / "+ free shipping · until 10.11" → same, overlapping panel
  - English tagline "Thermal bottle · 750 ml" ≈ {x:665,y:140,w:349,h:42} — product info, not an offer.
- Add `language: "he" | "en"` (the language of the offer text) to `AdClaims` + the JSON schema + prompt. The extraction prompt must be language-neutral (verbatim in whatever language is printed).
- Extend `killtest:spark` to run all 6 fixtures (same thresholds, language must be correct). Re-run it once at the end.
- Add `src/shared/i18n.ts`: one dictionary `{he, en}` for every user-facing string this task produces (blocker reasons, proof summary lines, verdict names, revalidation messages). Code uses message keys, never inline user text. Scripts print English by default, `--lang he` for Hebrew. This dictionary is what the UI will use later.

## 1. Panel snap (`src/server/repair/panel.ts`)
Spark's panel box is rough (±15 px; ad-01 IoU 0.66). Never use it as the edit rectangle directly.
- `snapPanel(imageRGBA, w, h, roughBox)`: take the dominant color inside the rough box (the panel fill, not the text), then grow/shrink to the exact bounding rectangle of the connected region of that color (small color tolerance), searching up to 40 px beyond the rough box. Estimate the corner radius and the text color.
- Gate `opaque`: on the panel's border band (excluding the rounded corners), ≥ 97% of pixels match the fill color with low variance. ad-03 (alpha 0.92 over the bottle) must fail this → blocker `panel_not_opaque`.
- Result: exact rect, fill color, text color, radius, or a blocker. Expected on ad-01/ad-02 (both languages): exactly {x:90,y:840,w:900,h:170} ± 1 px.

## 2. Protection masks
Reuse `segment()` from `sam.ts`. Product: phrase "bottle". Logo: the kill test showed "logo" segments only the circle mark, not the "GALI" wordmark → union of the "logo" phrase mask AND a box prompt on Spark's `logo_bbox` (fall back to ground truth only in the kill test, labeled). `protected = dilate(union(product, logo), 4)`. Blockers: empty/tiny mask; `protected ∩ panel rect > 0` → `panel_overlaps_protected`.

## 3. Repair gates (before rendering) — refuse instead of repairing when
- any offer text with `in_panel: false` contradicts the spec (`wrong_text_outside_panel`)
- the panel is not opaque, or overlaps the protected mask
- the corrected text does not fit at the minimum font size (see 4)
- the ad already matches the spec → no repair at all (CLEAN never creates a repair)

## 4. Render (`src/server/repair/render.ts`) — Chromium via Playwright
- Add `playwright` (Chromium only) and fonts `@fontsource/noto-sans-hebrew` + `@fontsource/noto-sans` (OFL — keep their license files reachable; note them in README). Load fonts from local files, never from the network at render time.
- Approved templates filled ONLY from spec fields — no free text, no model-written copy:
  - he: main `{percent}% הנחה על {דגמים נבחרים | הכל}`, sub `בתוקף עד {DD.MM} · משלוח {בתשלום | חינם}`
  - en: main `{percent}% off {selected models | everything}`, sub `Valid until {DD.MM} · {paid shipping | free shipping}`
  - Template language = the ad's detected `language`.
- HTML: `lang` + `dir` (`rtl` for he, `ltr` for en); numbers, `%`, dates in `<span dir="ltr" style="unicode-bidi:isolate">`; logical string order (never reverse strings).
- Viewport exactly the panel rect size, deviceScaleFactor 1, transparent background (`omitBackground`), panel fill = sampled color, radius = estimated radius, text color = sampled text color.
- Wait for `document.fonts.ready` and check the font actually loaded. Fit: start at a size proportional to the panel height, shrink until no overflow (scrollWidth/scrollHeight ≤ client); below min (main 28 px, sub 18 px) → blocker `text_does_not_fit`.
- If Chromium cannot launch inside your sandbox, ask for the one-time unsandboxed approval (like the live API runs) — do NOT swap the renderer for something else. `npx playwright install chromium` will also need network approval.

## 5. Composite + pixel proof (`src/server/repair/composite.ts`, `proof.ts`)
- Sharp: composite the rendered panel PNG at the rect onto the decoded source; output lossless PNG, same dimensions.
- Proof, computed on raw RGBA of before vs after: `changed_outside_rect = 0`, `changed_inside_protected = 0`, `max_channel_diff_outside = 0`, same width/height. Then decode the exported PNG again and re-check (round-trip). Any non-zero → the repair is rejected.
- `artifact_digest = sha256(after.png bytes) + spec version` — stored in proof.json (approval will bind to it later).
- Write `artifacts/repair/<ad>/`: `before.png`, `after.png`, `panel.png`, `masks.png` (overlay), `diff.png` (changed pixels highlighted, everything else dimmed), `proof.json`, `revalidation.json`.

## 6. Revalidation (fresh Spark call on `after.png`)
Pass only if: percent/scope/shipping/valid_until now match the spec; no old promise remains anywhere in `offer_texts` (e.g. 30%, "free shipping"/"משלוח חינם", "everything"/"הכל"); no new unsupported promise; language unchanged.

## 7. Kill test `npm run killtest:repair` (runs live on all 6 fixtures)
Expected results — print a PASS/FAIL table per ad, in English (and `--lang he`):
- ad-01-clean / ad-01-clean-en → CLEAN, no repair job created
- ad-02-wrong / ad-02-wrong-en → repaired: proof all zeros, round-trip OK, revalidation PASS
- ad-03-overlap / ad-03-overlap-en → REFUSED with blockers `panel_not_opaque` and `panel_overlaps_protected`
Print latency, number of model calls and the artifact paths.

## 8. Tests and finish
- Unit tests (no network): panel snap on synthetic images (uniform panel on a gradient → exact rect; semi-transparent panel → not opaque), template text for he/en from the spec (exact strings), bidi markup (numbers isolated, `dir` correct), pixel proof (one changed pixel outside the rect → fail; inside the protected mask → fail; identical → pass), i18n dictionary has every key in both languages.
- `npm test`, `npm run typecheck`, `killtest:spark` (6 ads) and `killtest:repair` live. Paste both tables in the final message, and say which blockers fired where.
- Update README Status (both languages supported; results). Add a short "Languages" line to docs/ARCHITECTURE.md (Hebrew + English ads, bilingual UI strings via i18n.ts, demo in English). Do not commit, do not push.
