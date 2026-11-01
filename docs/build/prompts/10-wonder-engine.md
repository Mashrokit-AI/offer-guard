Next: make the engine produce designer-quality layouts, fast and verifiably, with Muse Wonder as a constrained art director. The owner reviewed the live demo: quality and speed are not impressive yet, and two outside design/engineering reviews agreed the biggest risk is "attractive claims beside visibly broken outputs". This session is the ENGINE. The next session does a focused UX pass and regenerates the demo, so keep UI changes here to what the engine needs (statuses, overlay, trace). Follow AGENTS.md. You run without approval prompts, so be careful: never `git push`, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. Do not commit.

**Model API budget for this session: up to $25 total** (Wonder + Spark + SAM + Muse Image). Add a cost ledger (tokens × list price: Wonder $4 in / $20 out per 1M tokens; Spark standard $1.25 / $4.25; SAM $2.50 per 1000 images; Muse Image $0.01 per image), log real usage from API responses, and stop calling Wonder when the session ledger passes $25. **Iterate on 3 sizes only (ig-feed-11, fb-link, ig-story-916); run all 8 only once those are good.**

## Measured today (demo trace, fb-link protected, 52 s)
Spark analyze 13.3 s → SAM 9.1 s → **plan = code:planLayout, 1 ms** → Muse Image plate 12.7 s → composite 0.3 s (panel pasted at **0.56×**) → proof → Spark QA 16.3 s. Every output's trace marks analyze and SAM `cached: false`; verify whether they really repeat per size and whether sizes run sequentially.

## 1. One resolved layout manifest (do this first)
Today the detail overlay disagrees with the output and the Brands page already shows misplaced/overlapping template zones. Introduce a single **resolved layout manifest** per output, written after constraint enforcement: every element's final box, group, z-order, alignment edge, scale. The compositor, the overlays, the proof and the review all read this one object. Keep "template target zones" and "actual placement" as two distinct things in data and in the overlay (two toggles). Also fix the template parser output so zones of the GALI/NOA templates don't overlap or sit in the wrong place (look at them). Test: overlay rectangles == manifest == where pixels were placed, for every preset.

## 2. Panels and text are rebuilt, not pasted
Stop pasting the offer panel as an image (at 0.56× it is unreadable and can't reflow). Protect pixels only for **products and logo**. Rebuild simple panels (rounded rect / band, colour sampled from the source) in code and render their text with Chromium; groups: headline, offer/price, subline, CTA, terms. Text is immutable: use exactly the strings read from the source (gershayim ״ / geresh ׳ never become ASCII quotes), wait for fonts to load, and measure the real rendered text bounds before layout. If a source panel is too complex to rebuild (photo texture, illustration), fall back to pasting it but never below the scale where its text stays ≥ the minimum legible size for that canvas — otherwise flag it.

## 3. Wonder art director (one call per source, all sizes)
Call `muse-wonder-1.0` once per source with: the source image, Spark's analysis, element boxes/aspect ratios (from SAM), measured text-block sizes, the brand template preview + zones for each size when present, platform safe areas, and the rules below. It must choose, per size, one of three **composition families** — `landscape_split` (product one side, text group the other), `portrait_stack`, `square_balanced` — and return normalized boxes per element/group, alignment edge, z-order, a background brief for the plate, and one short rationale line. Structured output with a JSON schema.
- Code then **enforces** hard constraints deterministically and records any correction: margins ≥ 6% of the short side; key content inside safe areas (9:16: top 14% / bottom 20%); no unintended overlap; product ≥ ~45% of safe height on 9:16 and ~70–80% of height on landscape; text group shares one alignment edge (right for RTL, left for LTR) with consistent gaps; no empty region > ~25% of the canvas.
- When a brand template exists for a size, its zones bind the layout; Wonder only adapts within them.
- Fallback to the existing code planner on error / timeout / budget cap; record the planner used.

## 4. Wonder design review — bounded and actionable
After the sizes of a source are composed, send the source + all outputs (labeled, ≥ 768 px long side) to Wonder once. Run the deterministic geometry/text checks FIRST and include their results. Wonder must return specific defects with element-level patches against the manifest (e.g. `{size:"fb-link", element:"logo", action:"scale", by:1.3}`, `{group:"text", action:"move", dy:-0.08}`), never scores or vague advice. Apply **at most one repair pass**; layout/text patches recompose from cached layers without a new image call (only regenerate a plate if the background itself is the defect). Anything still failing → status "Needs review". Keep before/after of every repaired size in the record (this is the demo moment for the Wonder prize: one real landscape defect diagnosed and fixed).
This review **replaces the 8 routine per-size Spark QA calls**; keep targeted Spark text checks only where text was re-rendered, plus all deterministic checks.

## 5. Speed
- Analyze (Spark) once per source; immediately start SAM and the Wonder plan in parallel; start plates as soon as each size's plan exists. Cache layers by source digest (trace `cached: true` on reuse).
- Worker pool of 4 sizes (`ADFIT_SIZE_CONCURRENCY`), one shared Chromium.
- Stream each composed size to the UI immediately with status "Review pending", then update to Passed / Fixed / Needs review when the batch review lands.
- Measure and report: time to first preview and time to complete batch, for the 3-size and the 8-size GALI job, before vs after. Promise nothing you didn't measure.

## 6. Cut-outs, shadow, plate
- SAM per product instance (box prompts per product; validate coverage — 2 products must both be found). Immutable mask core; clean the fringe separately (defringe/feather 1–2 px only in the edge band, documented). The stair-stepped dark left edge of the GALI bottle must be gone.
- Contact shadow in code under the product's actual support point (lowest opaque pixels), not the bbox centre; skip it for floating products or when the plate's lighting makes it implausible. Ask the plate for no product shadows.
- Plate prompt gets the resolved layout guide ("keep these regions clean/low-detail") and the source as reference; resize/crop exactly to the canvas; reject plates that contain duplicated products, logos or lettering (cheap Spark check) and regenerate once.
- 9:16: the GALI frame's solid dark bottom block must go — background continues under the frame or the band becomes a designed strip; panel sits just above the UI zone.

## 7. Honest verification
Replace the single green "Checked by Spark" with three independent statuses per output — **Protected pixels**, **Text**, **Layout review** — each Pending / Passed / Fixed / Needs review. Proof label: "Protected core matches the resized source" with the compared-pixel coverage %, not a bare "0 px changed". Never erode the core to make a diff disappear.

## 8. Harder fixtures (needed for the demo next session)
Create two synthetic fixtures (invented brands only; document in `fixtures/brands/README.md`):
- **English, complex**: photographic lifestyle background generated once with Muse Image `/v1/images/generations` (commit it like NOA's source), 2 products, headline, price "$39", CTA "Shop now", small terms line, logo; Chromium-rendered brand templates for 1:1, 1.91:1, 9:16.
- **Hebrew, complex**: same idea in Hebrew — photo background, 2 products, ₪ price, CTA "לקנייה", terms line, logo, exact Hebrew; templates for 1:1, 1.91:1, 9:16.
Never simplify a creative to make it pass; fix the engine.

## 9. Security + public spend caps
- `PATCH /api/templates/:id` lacks the `is_demo` guard → any visitor can permanently change GALI/NOA. Add the guard (400 `err_bad_request`), show demo brand boxes read-only, tests.
- `ADFIT_WONDER_DAILY_USD` (default 3) and `ADFIT_DAILY_USD` (default 8) from the ledger; over cap → code planner / skip review, live generation shows the existing busy message. Tests with a fake ledger.

## 10. Verify and report
- Run protected jobs (3 sizes while iterating, then all 8) for GALI-he, the two complex fixtures, and NOA. Look at every output at full size; fix anything you would hesitate to show a client before reporting.
- `npm test`, `npm run typecheck`, rebuild web; Playwright: fb-link detail with both overlays, 9:16 detail with safe area, trace drawer showing Wonder plan + review rows (with one before/after repair) → `artifacts/ui/`.
- Don't overwrite the saved demo yet; save this session's outputs under `artifacts/engine-10/<source>/`.
- Report: what changed; timing table (first preview / full batch, before vs after); per-output table (source, preset, family, planner, review result, statuses, proof coverage, seconds); ledger spend by model; anything still not good.
