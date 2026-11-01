# MatchPic — Architecture

Meta hackathon · team Mashrokit (Oz + Evyatar).
Pivot (Nov 1): Offer Guard (checking ad promises) is dropped — not a proven
problem in our agency and it doesn't showcase Meta's models. The new product
is **one creative → every placement size**, built on Meta's models.
`docs/build/` keeps the honest history of both eras.

---

## בעברית בקצרה

**מה בונים:** מעלים קריאייטיב גמור, בוחרים מותג וגדלים, ומקבלים כל מיקום
בחזרה. המותג מלמד את הפריסה שלו לכל גודל דרך תבניות (קריאייטיבים גמורים
מהעבר). במצב מוגן ה-AI מצייר רק את הרקע, והמוצר/לוגו/טקסט חוזרים כפיקסלים
מקוריים עם הוכחה; במצב מהיר ה-AI מרכיב הכל מחדש. Spark בודק כל פלט; בכשלון
מנסים שוב פעם אחת, ואז מסמנים "דורש בדיקה".

**העקרונות:** צינור קבוע (לא סוכן חופשי); TypeScript מקצה לקצה; שום דבר לא
מתפרסם לשום פלטפורמה; הוכחות בקוד, לא ציוני ביטחון של המודל; הכל דו-לשוני.

---

## 1. Decisions

| # | Decision |
|---|---|
| 1 | Fixed pipeline per source × size: analyze → plan → generate → QA (+1 retry). App owns every transition. No free agent, no publishing. |
| 2 | TypeScript end-to-end: Hono API + dependency-free bundled UI, SQLite, local artifact dirs. One app, one in-process worker. |
| 3 | Brand templates teach layout per size. Spark reads each template into a stored `TemplateSpec` (zones 0–1); the user can nudge boxes or reject. |
| 4 | Protected mode: Muse Image paints the background plate only; code places SAM-cut product/logo pixels (uniform scale, recorded), copies opaque panels as pixel blocks, re-renders free text verbatim in Chromium (bundled Noto), applies the frame overlay last. |
| 5 | Pixel proof per pasted element: 0 differing core pixels after the recorded transform; a soft 1–2 px feather is allowed only outside the mask core. |
| 6 | QA = a fresh Spark call per output (never the analysis call): verbatim texts exact, logo/product present and uncropped, safe area respected — judged against the exact safe-area pixel lines from the plan (percent-eyeballing caused false FAILs). One retry, then "needs review". |
| 7 | Gating = deterministic rules + proofs. No self-reported confidence thresholds. |
| 8 | Hebrew + English creatives and UI (`src/shared/i18n.ts`, message keys); text stays in logical order, numerals bidi-isolated. |
| 9 | Synthetic demo brands only (GALI flat, NOA photographic AI-generated). No real client data in the repo. |

## 2. Verified Meta facts (tested Nov 1, don't re-research without cause)

- API base `https://api.meta.ai/v1`, OpenAI-compatible chat + Responses. Bearer `MODEL_API_KEY`.
- `POST /images/edits`, JSON `{model:"muse-image-1.0", prompt, size:"WxH", images:[{image_url:"data:…"}], output_format:"png", reasoning_strength:"low"|"high"}`. Up to 10 input images; multi-image composition works. `size` is **aspect ratio only** (1080x1920 → 1152x2048) — code cover-fits to the exact preset and verifies. `mask`, `enable_web_search`, `enable_image_search` → 400. ~16–18 s/image, $0.01.
- Quality on GALI: full-recompose prompts keep Hebrew and layout but redraw the bottle (proportions drift); background-plate prompts give a clean plate that composites well with SAM-cut originals.
- `muse-spark-1.3`: structured output via `response_format: json_schema` (strict), with "JSON only" + local Zod fallback and one validation retry. Boxes prompted in pixels but sometimes returned 0–1000/0–1 → detect + convert.
- `sam-3.1` via Responses streaming + `@meta-sam/parser`: noun phrase or box prompts; union of phrase + box (from Spark's box) per element; zero matches = empty, never an error. Fixture GALI: "logo" alone misses the wordmark, hence the union. Spark's logo box can still end mid-word (seen: pasted "GAL" with a missing "I"), so a contrast completion pass (`completeLogoMask`) re-grows from the padded box with a horizontally widened bound — vertical stays tight so the tagline below never joins.

## 3. Data flow

```
source upload(s) + brand + sizes + mode
  → Analyze (Spark, once per source): products/logo/texts/panel/background
  → Masks (SAM, once per source): phrase+box union per element, logo lockup
    completion → persisted PNGs
  → Plan (code, per size): template zones (mirrored on direction mismatch)
    or defaults (corner logo / centered product / bottom panel), all in safe
    area; free other-texts de-collided out of other elements
  → Generate (per size, 2 at a time):
      Fast:      Muse Image edit [source, template?] → exact-size
      Protected: Muse Image background plate → paste originals → render text
                 → frame overlay → per-element proof
  → QA (fresh Spark, exact safe-area pixel lines): PASS | FAIL→retry once→needs_review
  → SSE progress per size; ZIP + manifest download
```

## 4. Modules

- `src/shared/brand.ts` — product name in one place (`BRAND_NAME`).
- `src/shared/presets.ts` — the 8 placement presets + safe areas.
- `src/shared/schemas.ts` — `SourceAnalysis`, `TemplateSpec`, `QAverdict`, `LayoutPlan` (Zod).
- `src/shared/{config,env,guards,masking,geometry,i18n}.ts` — model config, secrets loading, PAUSED guard, masking, mask/box math, bilingual strings.
- `src/server/models/` — `client.ts` (OpenAI client, retry, usage), `spark.ts` (generic structured calls), `analyze.ts`, `template-read.ts`, `qa.ts`, `brand-match.ts`, `sam.ts` (Responses streaming), `muse-image.ts` (edits/generations + shape-tolerant parse).
- `src/server/adfit/` — `planner.ts`, `pipeline.ts` (prepare/generate/composite/proof/QA/retry, pool of 2), `seed.ts` (fixture brands + saved demo).
- `src/server/repair/` — `masks.ts` (phrase+box union, logo lockup completion), `render.ts` (Chromium panel + free-text blocks, bundled Noto), `composite.ts` (RGBA ops, feathered paste, exact-size), `proof.ts` (element proof + digest).
- `src/server/store/db.ts` — SQLite: brands, templates, sources, jobs, outputs, usage.
- `src/server/http/` — `app.ts` (routes), `jobs.ts` (one-at-a-time + queue + SSE), `uploads.ts` (content validation, re-encode), `media.ts` (by-id, contained), `zip.ts` (stored ZIP), `config.ts` (`ADFIT_*`), `dto.ts`, `server.ts`.
- `src/server/workflow/trace.ts` — tool-call trace collector.
- `src/web/` — dependency-free UI: `home.ts`, `output.ts`, `brands.ts`, `about.ts`, shell + RTL in `app.ts`/`lib.ts`.

## 5. Storage

- `data/adfit.db` — SQLite (gitignored). `data/uploads|templates|logos|outputs|masks/` — normalized PNGs (gitignored, 24 h expiry for visitor data).
- `fixtures/brands/{gali,noa}/` — committed synthetic brands: sources, templates, logos, frame, Spark specs, saved demo job.
- `artifacts/adfit-live/` — live batch outputs + report (gitignored). `artifacts/ui/` — screenshots (gitignored).

## 6. Limits

Kill switch · one heavy job + queue ≤ 3 · 3 live jobs/IP/hour · daily caps
(model calls + images) · 2 sizes in flight · ≤3 sources × ≤8 sizes per job ·
uploads JPEG/PNG/WebP ≤ 10 MB / 24 MP, re-encoded, 24 h expiry.

## 7. What was deliberately cut

Template SAM masks persist only for the logo (overlay + record); frame
pixels come from the uploaded frame overlay, logo/product pixels from the
source. No Wonder/computer-use: the pipeline needs no investigation stage.
No Graph API at all (a test enforces the module graph has no ad-platform
write imports). No confidence scores anywhere — proofs and QA verdicts only.
