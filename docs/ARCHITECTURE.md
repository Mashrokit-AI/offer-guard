# Offer Guard — Architecture (design only, nothing built yet)

Meta Global AI Developer Hackathon · Indie track · team Mashrokit (Oz + Evyatar)
Submit: Wed Nov 4 evening Israel time (hard deadline Thu Nov 5 04:00 IL).
Sources: brainstorm with ChatGPT, Gemini and Instinct (2 rounds each, 29.10.2026) + Meta docs checked directly the same day.

---

## בעברית בקצרה

**מה בונים:** סוכן שעובר על כל המודעות בקמפיין, קורא מה כל מודעה מבטיחה (בתמונה ובטקסט), משווה למבצע שאושר ולעמוד הנחיתה, ומחליט: תקינה / מודעה שגויה שאפשר לתקן / מודעה שגויה שמסוכן לתקן (מסרב) / האתר שגוי (רק מתריע) / לא ברור (שואל שאלה אחת). כשאפשר לתקן — הוא מחליף רק את פאנל המחיר בתמונה, מוכיח מתמטית שאף פיקסל של המוצר והלוגו לא זז, ואחרי אישור אנושי יוצר במטא מודעה מחליפה **מושהית**.

**החלטות שכולם הסכימו עליהן:**
- צינור קבוע (state machine) עם שלב חקירה אחד מוגבל של Wonder — לא סוכן חופשי.
- TypeScript מקצה לקצה (כמו השירותים שלנו), Playwright לצילום האתר, Chromium לעימוד עברית, Sharp להרכבת התמונה.
- Spark 1.3 קורא ומחלץ; Wonder חוקר רק מקרים לא פתורים; SAM מסמן מוצר ולוגו.
- אין "ציון ביטחון" של המודל — רק כללים ובדיקות קוד.
- Graph API v25, פורמט אחד בלבד (מודעת תמונה אחת בפייסבוק), בלי עגלה.
- 8 מקרי בדיקה, הקפאת פיצ'רים ביום שלישי.

**המחלוקת היחידה:** האם להוסיף את יכולת ה"גלישה העצמית" של Wonder (computer use) לבדיקת תנאים שמסתתרים מאחורי לחיצה. Gemini — כן, ChatGPT ואינסטינקט — לא. **ההכרעה כאן:** לא בגרסה הבסיסית; תוספת אופציונלית רק אם הכל עובד עד יום שני בערב.

---

## 1. Decisions

| # | Decision | Agreed by |
|---|---|---|
| 1 | Fixed pipeline / state machine + one bounded Wonder investigation stage. App owns every transition. Publishing is NOT an agent tool. | ChatGPT, Gemini, Instinct |
| 2 | TypeScript end-to-end: Express API + React/Vite UI, SQLite, local artifact dir. One app, one in-process worker. | All three (Instinct suggested Next.js; Express chosen to match our services) |
| 3 | Landing pages: Playwright capture (screenshot + visible DOM text), not computer-use. | All three |
| 4 | Hebrew: render the offer panel as HTML in Chromium (Playwright screenshot), composite with Sharp. No Pillow/bidi. | All three |
| 5 | Models: Spark 1.3 = extraction + revalidation; Wonder 1.0 = bounded investigation of unresolved findings; SAM 3.1 = protected masks. No Muse Image / Voice in v1. | All three |
| 6 | Gating = evidence coverage + deterministic rules. No self-reported confidence thresholds. | All three |
| 7 | Graph API pinned to v25.0. Single-image Facebook link ad in a pre-made ad set. | All three |
| 8 | Test set: 8 semantic cases (6 dev + 2 held-out, one authored blind by the teammate) + separate operational fault checks. | ChatGPT, Instinct (Gemini: 6) |
| 9 | Stretch only: Wonder/Spark computer-use "deep check" when offer terms are behind a click. | Gemini yes; ChatGPT, Instinct no → stretch |

## 2. Verified Meta facts (docs, 29.10.2026)

- API base `https://api.meta.ai/v1`, OpenAI-compatible (Responses, Chat Completions). Bearer `MODEL_API_KEY`.
- `muse-spark-1.3`: text/image/video/PDF in, 1M ctx, tool calling, structured output; tuned for agentic/browser loops; cheaper. Audio input degraded on 1.3.
- `muse-wonder-1.0`: preview; same inputs; computer use (Responses API, `tools:[{type:"computer"}]`, we supply the Playwright driver and must handle `pending_safety_checks`). Wonder Full is NOT on the API.
- `sam-3.1`: via Responses API; noun phrase or box/point prompts; image or video; returns boxes + pixel masks as special-token text → parse with `@meta-sam/parser` (`parseImageStream`, `decodeMaskToRaster`, `metadata.mask_encoding: "one_bit"`). Zero matches = empty output.
- `muse-image-1.0`: generate/edit by instruction only — `mask` param returns 400; `size` is aspect ratio only; $0.01/image. (Not used in v1.)
- Responses/Chat Completions accept only `tool_choice: "auto"` → enforce required steps in our state machine (per ChatGPT's doc check).

## 3. Data flow

```
Confirmed offer spec + campaign_id
  → Snapshot: list ads, read creatives, download source images, capture landing pages (Playwright)
  → Extract (Spark 1.3, JSON schema): claims from ad image + copy; claims from page screenshot + text
  → Compare (code): normalized fields vs spec
  → Investigate (Wonder 1.0, bounded): only unresolved/semantic findings; may request more evidence
  → Verdict (code, from findings)
  → If AD_WRONG_REPAIRABLE: SAM masks → Chromium Hebrew panel → Sharp composite → pixel proof → Spark revalidation
  → Human approval (bound to artifact digest + spec version)
  → Publish (code): adimages → adcreatives → ads(status=PAUSED) → readback
```

| Component | Model or code | Owner |
|---|---|---|
| Spec confirmation | Spark proposes structured spec from a short brief; human confirms | Evyatar |
| Campaign adapter | Code (Graph v25) | Oz |
| Page capture | Code (Playwright) | Oz |
| Claim extraction | Spark 1.3 | Evyatar |
| Comparison + verdict | Code | Evyatar |
| Investigation | Wonder 1.0, max 3 rounds / 4 tool calls per ad | Evyatar |
| Protection masks | SAM 3.1 + code | Evyatar |
| Repair render + composite + proof | Code (Chromium, Sharp) | Evyatar |
| Revalidation | Fresh Spark call + code | Evyatar |
| Publisher + readback | Code only | Oz |
| UI + trace | Code | Oz (shell), Evyatar (repair view) |

*(Owner split is a proposal — swap if it suits you better.)*

## 4. Records (SQLite)

| Record | Contents |
|---|---|
| OfferSpec | discount, scope/eligibility, shipping terms, validity (dates + year + TZ), required disclosures, version. "Unspecified" ≠ "none". |
| SourceSnapshot | ad / creative / adset IDs, original copy, image bytes + local SHA-256 + Meta image hash, destination URL, capture time |
| PageCapture | requested URL, final URL, screenshots (≤3 viewport sections), visible text chunks with bounds, capture time |
| Claim | field, normalized value, verbatim source text, source location, evidence ID |
| Finding | spec fact, observed claim, contradiction / missing, repair blocker |
| RepairArtifact | before/after image + copy, edit rectangle, protected masks, pixel-check results, revalidation result, digest |
| Approval / PublishJournal | artifact digest, spec version, approver + time, operation key, returned Meta IDs, readback |

## 5. Verdict logic (code)

| Condition | Verdict |
|---|---|
| Evidence complete, ad and page agree with spec | CLEAN (= no contradiction in the inspected ad + page; not a policy approval) |
| Ad contradicts spec, page agrees, every edit supported | AD_WRONG_REPAIRABLE |
| Ad contradicts spec + any repair blocker | AD_WRONG_UNSAFE → refuse, explain |
| Ad agrees, page contradicts spec | PAGE_WRONG → flag only, never rewrite the promise |
| Both wrong | AD_WRONG_UNSAFE + separate PAGE_WRONG finding |
| A material fact can't be resolved | AMBIGUOUS → one focused question |

Operational states (CAPTURE_FAILED, UNSUPPORTED_FORMAT) are separate and never become CLEAN.

## 6. Agent tools (Wonder investigation stage)

| Tool | Input → output |
|---|---|
| inspect_ad_region | snapshot ID + rectangle → enlarged crop + evidence ID |
| inspect_page_region | capture ID + element/region → text, crop, bounds |
| capture_more_page | capture ID + allowed scroll position → new screenshot + text |
| check_offer_facts | spec version + normalized claims → deterministic field comparison |
| propose_panel_repair | ad ID + panel bounds + corrected fields → candidate or explicit blocker |
| validate_candidate | candidate ID → pixel checks + semantic checks |
| request_clarification | finding ID + one question → pending human answer |

Reliability rules: JSON-schema outputs validated again locally (Zod) · every material claim cites evidence · DOM quotes verified against stored text · original Hebrew stored next to normalized value · one retry with enlarged crop · one repair revision, then abstain · retry transient errors twice with backoff · concurrency 2 · revalidation in a fresh context · page content is evidence, never instructions.

## 7. Landing-page capture (Playwright)

Chromium, 390×844 CSS px, fixed device scale, `he-IL` locale, `Asia/Jerusalem` TZ · bounded timeout, wait for fonts + short settle (no endless network-idle) · initial viewport + up to 2 more sections · visible text with element bounds (no scripts/hidden/raw HTML) · record final URL + time · reuse one capture per identical URL in a sweep · consent wall / login / bot challenge → AMBIGUOUS · allowlist our demo domains, block private/loopback/metadata addresses · browser never sees Meta credentials · no cart, login or form submit.

## 8. Repair pipeline

Supported family only: **one opaque rectangular offer panel, separated from product and logo.**

1. **Source:** download the real source image (not thumbnail), normalize once to a canonical pixel buffer, keep original dimensions.
2. **Panel:** Spark proposes the rectangle and transcribes ALL offer text in the image. Code checks it fits the family; the user sees the outline.
3. **Refuse when:** wrong text exists outside the panel · panel transparent/textured/irregular · product or logo overlaps panel · corrected text doesn't fit at minimum size · erasing would need hidden product pixels.
4. **Protect:** separate SAM requests for product and logo (box prompts if the phrase fails) → union → dilate a few px → show overlay. Empty/incomplete mask = blocker.
5. **Render:** small HTML panel, bundled Noto Sans Hebrew (+ license), `dir="rtl" lang="he"`, numbers/%/₪/dates in explicit bidi-isolated spans, logical order (never reverse strings), wait for fonts, check overflow. Text comes from approved templates filled from spec fields — no creative rewriting of the promise.
6. **Composite:** Sharp replaces pixels only inside the edit rectangle. No Muse Image.
7. **Proof:** changed pixels inside protected mask = 0 · max channel diff = 0 · changed pixels outside the edit rectangle = 0 · same dimensions. Export lossless PNG, decode it, check again. (Pixel equality proves only the measured region — the outside-rectangle check is the stronger guarantee.)
8. **Revalidate:** fresh Spark extraction on the final PNG + copy; fail if an old promise remains, a qualification disappears, or a new unsupported promise appears.

## 9. Marketing API flow (Graph v25.0)

| # | Call | Notes |
|---|---|---|
| 1 | `GET /{campaign_id}/ads` | paginate; ad IDs, adset IDs, status, creative IDs |
| 2 | `GET /{creative_id}` | link_data, image ref, copy, destination, enhancement settings |
| 3 | `GET /act_{id}/adimages` | resolve original image by hash |
| 4 | `GET /{adset_id}` | confirm account/campaign + supported config |
| 5 | Human approval | bound to artifact digest + spec version |
| 6 | `POST /act_{id}/adimages` | upload repaired PNG → keep returned **image_hash** |
| 7 | `POST /act_{id}/adcreatives` | allowlisted payload: page_id, `object_story_spec.link_data` {image_hash, message, link, name, CTA} |
| 8 | `POST /act_{id}/ads` | original adset_id, new creative_id, `status=PAUSED` |
| 9 | `GET /{new_ad_id}` + creative | confirm configured status PAUSED, adset, creative, copy, image hash |

Input gate: accept only the verified single-image link-ad format; reject carousel, catalog, dynamic/multi-asset, video and unsupported existing-post creatives (→ UNSUPPORTED_FORMAT). Store immutable snapshots and build an explicit new-creative payload — never a blind clone of the read response. Keep destination, CTA, tracking and Page/identity exactly as they were unless the approved change covers them. Repair a contradictory headline too, not only the caption. *(Instinct)*

Gotchas: `ads_management` doesn't prove Page access — test the real Page · image_hash ≠ our SHA-256 · read configured `status`, not only `effective_status` (new ads show PENDING_REVIEW) · disable creative enhancements so Meta doesn't alter the reviewed creative · creation ≠ approval/delivery — say "PAUSED replacement created and verified" · old ad stays untouched — say so in the UI · POST timeouts can duplicate → operation key = hash(source ad + spec version + artifact digest + target), journal every returned ID, reconcile before retry, "creative created, ad unconfirmed" is a valid partial state · re-read source + spec before publishing; any change voids approval.

## 10. Repo structure

```
offer-guard/                 (new public repo, only new code)
  src/shared/                schemas (Zod), verdict rules, tool contracts   ← agree together in hour 1
  src/server/meta/           campaign import, asset resolution, publisher, readback
  src/server/browser/        Playwright page capture
  src/server/workflow/       job state machine, retries, approvals, journal
  src/server/models/         Spark / Wonder / SAM adapters + prompts
  src/server/repair/         masks, Chromium panel renderer, Sharp composite, pixel proof
  src/web/                   sweep view, evidence view, repair diff, approve, trace
  fixtures/                  synthetic ads + demo landing pages (public)
  tests/                     verdict rules, renderer, pixel proof, workflow
```
Secrets (Meta token, Model API key) server-side only, never in repo or traces. Runtime artifacts gitignored.

## 11. Test set (8 cases + fault checks)

| Class | Cases |
|---|---|
| CLEAN | exact match; equivalent Hebrew phrasing |
| AD_WRONG_REPAIRABLE | wrong % in panel; "free shipping" in panel when shipping is paid |
| AD_WRONG_UNSAFE | offer text overlaps the product |
| PAGE_WRONG | page shows a different discount than the spec |
| AMBIGUOUS | "selected products" with no identified scope |
| Held-out / unseen | one case the teammate authors after prompts freeze |

If the budget reaches ~36+ person-hours, grow toward Instinct's set: 20 cases (4 per verdict, PAGE_WRONG including both-sides-wrong), 12 for development and 8 held-out **frozen before any prompt tuning**, with different products / phrasing / layout. Vary: selected vs all products, "up to" vs exact discount, free vs paid shipping, expiry, minimum spend / codes, image-vs-caption conflict, Hebrew + numerals + Latin brand names. One developer labels, the other checks.

Invariant / fault checks (separate): page timeout · empty SAM mask · wrong mask dimensions · panel overlaps product · Meta API error · source changed after approval · double-click approve · timeout after POST · page text trying to instruct the agent · both sides wrong · image and caption disagree · a CLEAN ad never creates a repair or publish job.
Report with denominators: confusion matrix, repair precision, unsafe repairs attempted (target 0), wrong-as-CLEAN count, preservation pass count, sweep time, model cost. Never feed labels or fixture names to the extractor. Label the fixtures as synthetic in the video.

## 12. Day-1 kill tests (before any UI)

| Test | Pass | If it fails |
|---|---|---|
| Meta write path | upload → creative → PAUSED ad → correct readback on our own account | fix permissions/config first; nothing else matters until this works |
| Hebrew extraction | Spark reads the right facts from one clean + one wrong ad image | enlarged crops; keep abstention |
| SAM masks | usable product + logo masks | box prompts; narrow the asset family |
| Repair proof | readable Hebrew panel; zero diff inside masks and outside panel | fix renderer before anything else |
| Page evidence | mobile capture + quotes support the right comparison | stick to our own demo pages |

A failed test means narrowing that interface (one verified identity/ad format, human-confirmed geometry/masks, a more legible badge) — never quietly swapping in a mock for a failed API integration. Any replay mode is labeled as such.

## 13. Schedule (~28 person-hours core; extra hours → hardening, not features)

| When | Oz | Evyatar |
|---|---|---|
| Thu 29.10 PM | Meta write-path probe; campaign import | Spark extraction probe; SAM masks |
| Fri 30.10 AM | page capture; shared schemas | Chromium Hebrew panel + pixel proof |
| Sat | — | — |
| Sun 1.11 | job state machine + evidence snapshots; sweep UI | comparison rules + Wonder stage; repair gates |
| Mon 2.11 | approval-bound publisher + readback; evidence view | full repair + revalidation; repair diff view; dev cases |
| Tue 3.11 | trace view; failure handling; README · **feature freeze** | held-out cases; fix only real failures |
| Wed 4.11 | final live run + recording; submission check | close-ups, edit/export video; submit by evening |

Same plan as a cumulative person-hour budget (Instinct, 36h baseline, both people together):

| Hours | Work |
|---|---|
| 0–2 | contracts/schemas, fixture definitions, permissions and safety boundaries |
| 2–8 | parallel kill tests: Meta API, image/SAM/renderer, page capture |
| 8–14 | collection, claim extraction, comparison, evidence |
| 14–22 | repair, SAM coverage, Hebrew layout, pixel proof |
| 22–27 | sweep / evidence / approval UI, journal, readback |
| 27–32 | held-out evaluation, refusals, stale-approval and timeout tests |
| 32–36 | video, README, clean-clone rehearsal, submission buffer |

If we only get ~28 hours: cut animated traces, extra layouts and the optional Wonder escalation — **never** approval, evidence, refusal, pixel checks or readback. If we get ~44: spend the extra on robustness and recording, not features. Integrate early; Wednesday is for validation, recording and submission, not first integration.

Prerequisites to sort before Thursday's probes: a campaign + ad set (paused) in our own agency ad account and its Page · Model API key (credit card added; $150 credit pending) · a public host for the demo landing pages (e.g. GitHub Pages) · the new public repo · Muse Code installed.

## 14. Demo video (3:00)

| Time | Scene |
|---|---|
| 0:00–0:20 | Problem: the approved offer changed, an old image still promises the wrong deal. Say the fixtures are synthetic, in our own account. |
| 0:20–0:45 | Confirm the short spec, sweep the campaign, real verdict counts. |
| 0:45–1:15 | Open the AD_WRONG ad: ad quote, spec and page evidence side by side. |
| 1:15–1:50 | SAM overlay → panel → Hebrew before/after → "0 protected pixels changed, 0 outside panel" → fresh Spark check. |
| 1:50–2:10 | CLEAN left untouched; overlap case refused; PAGE_WRONG flagged, not "fixed". |
| 2:10–2:40 | Approve → upload → creative → PAUSED ad → readback IDs; original ad unchanged. |
| 2:40–3:00 | Held-out results with denominators, real tool timeline, honest limits, public repo. |

English narration/subtitles; Hebrew stays visible. Label any cached or sped-up part. Keep a labeled recorded fallback for network failure — never fake API results.

## 15. Top risks

| Risk | Mitigation |
|---|---|
| Accusing or "fixing" a valid ad | confirmed spec, evidence-backed claims, explicit unknowns, fresh revalidation |
| Preservation claimed over incomplete masks | visible masks + zero change outside the edit rectangle |
| Hebrew panel breaks or old text remains | one opaque panel family, full-image claim scan, bundled font, overflow check, refusal |
| Meta API fails or duplicates | prove the write path on day 1, one config, operation journal, reconcile uncertain POSTs |
| Scope eats the video time | one campaign, one format, no cart, no Muse Image, freeze Tuesday |

## 16. Stretch (only if everything above works by Monday evening)

Bounded "deep check": when the page says "selected products" or "see terms" and the facts are behind a click, run a short computer-use loop (Spark 1.3 or Wonder, `tools:[{type:"computer"}]`, Playwright driver, max ~8 steps, allowlisted domain, safety checks surfaced) and feed the revealed text back as evidence. This makes the agent's behaviour more visible in the video, but it is not needed for the core.
