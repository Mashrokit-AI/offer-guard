Next: polish MatchPic for the demo video and the judges. The product works (protected live batch 16/16 PASS). This session is UX/UI quality, Hebrew copy, vertical-format quality, and the final rename — no new features. Follow AGENTS.md. You run without approval prompts this time, so be careful: never `git push`, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. Live Model API calls are allowed (keep the session under ~$3). Do not commit.

## Context the judges care about (official guidance)
The video must show the working flow end to end with the live Meta model calls visible (model ids), and only what was built during the event. The site is public at app.mashrokit.co.il/matchpic/ — a judge lands on Home first. Within 10 seconds they must see what MatchPic does, a finished result set, and which Meta model did what.

## 1. Result cards must never crop (top priority)
Every output thumbnail (home demo grid, live results, detail page, brands) currently sits in a fixed square with object-fit: cover, so 1.91:1 and 16:9 lose the product on the left and the panel on the right, and 9:16 loses top/bottom. Show every image at its true aspect ratio (object-fit: contain inside a box sized to the preset ratio, or a masonry grid), with a subtle checkerboard/neutral backdrop. Group the grid by orientation (square/portrait, landscape, vertical) so it looks intentional. Verify with screenshots that no output is cropped anywhere.

## 2. Hebrew copy — apply exactly
Replace the `he` strings in `src/shared/i18n.ts` with the table in `.local/he-strings.md`, verbatim (it was written by a native speaker; do not rephrase). Apply the code notes at the end of that file (card_proof without `{what}` in both languages; qa_retry only when the retry fixed it; LRM in brand_colors). English: change `card_proof` to `Product & logo: {count} px changed`, `nav_about` to `How it works`, `qa_fail` to `Check this one`, `qa_retry` to `Auto-fixed`, and `btn_demo` to `See the demo`. Any new string you add needs both languages; for Hebrew follow the style rules in that file.

## 3. Home: demo first, clear call to action
- Top of Home: one-line value + the saved demo result set (source on the right side in Hebrew / left in English, then all sizes), labeled "saved demo · created {time}". Below it, a compact strip "Try it yourself" with the upload form.
- The demo must show only outputs that passed QA. If a size failed in the stored demo, regenerate it or leave it out; keep exactly one example of a caught-and-fixed output (badge "Auto-fixed") because it proves the QA loop.
- Remove the duplicated "Drop creatives here" label (keep one).
- The Generate button explains why it is disabled ("Add an image" / "Pick at least one size") and shows progress per size while running (existing SSE).
- A small "Meta models" row on Home under the demo: SAM 3.1 — protects product & logo · Muse Image — builds each background · Muse Spark 1.3 — reads, plans and checks. Each chip links to the About section.

## 4. Live model calls visible
On every output card show a one-line model footer: `muse-spark-1.3 · sam-3.1 · muse-image-1.0 · 12.4s` (real ids and the real duration from the trace). On the detail page, open the trace drawer by default on desktop and label each row with the model id, duration and cached/live. Keep it factual (no invented reasoning).

## 5. Vertical formats (9:16 stories/reels/TikTok)
Content is too small and the logo hugs the edge. Use the safe area (top 14% / bottom 20% clear for platform UI), scale the product so it fills ~45–55% of the safe height, keep the logo fully inside the safe area with margin, and place the offer panel above the bottom UI zone. Re-run GALI-he, GALI-en and NOA for both 9:16 presets in Protected mode and make sure QA passes; look at every image yourself.

## 6. Final rename to MatchPic
Replace remaining "AdFit"/"Offer Guard" mentions in README, docs/ARCHITECTURE.md, .env.example comments, package.json description, code comments and user-facing text (keep env var names `ADFIT_*` as they are — the server uses them; mention in README that the prefix is historical). Keep docs/build/ untouched. README must state where each Meta model is used (table), how to run, the live URL, and honest limits.

## 7. Verify
`npm test`, `npm run typecheck`, rebuild web, Playwright screenshots of Home (EN+HE, 1440 and 390), a detail page, Brands and About → `artifacts/ui/`; zero console errors. Look at every screenshot and fix overflow, RTL mixing, cropping, contrast. Report what changed, the 9:16 results (QA, retries), screenshots list, and anything unfinished.
