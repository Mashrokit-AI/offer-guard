Small follow-up to session 8 — Home layout only, no new features. Follow AGENTS.md. You run without approval prompts, so be careful: never `git push`, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. No live Model API calls are needed for this session. Do not commit.

## Problem
On Home the upload form ("Try it yourself") is now at the very bottom, ~10,000px down, below the whole demo grid. A visitor sees it for a split second while the demo loads, then it is pushed off screen and looks like it disappeared. The owner wants the form at the top.

## Change (src/web/home.ts + CSS)
1. Order on Home: title + subtitle → the upload form card (drop zone, brand, mode, sizes, Generate) → job banner / live run progress / live results → Meta models row → the saved demo.
2. The form must not jump: reserve its space on first render, so nothing above it changes height when brands, presets or the demo finish loading.
3. Keep the demo exactly as it is (same groups, same cards, uncropped), just below the form. Its heading stays "See the demo" with the "saved demo · created {time}" line. Add a small link/button in the form card, next to Generate, that scrolls to the demo (reuse `btn_demo` text, both languages already exist).
4. The demo source card currently sits alone in its own row with empty space beside it. Put the source in the same row as the first group ("Square & portrait") so the row reads: source → outputs; on narrow screens it may wrap.
5. When a live run starts, scroll the live results into view; they appear directly under the form.
6. Hebrew and English both: in Hebrew the source stays on the right side (RTL).

## Verify
`npm test`, `npm run typecheck`, rebuild web, then Playwright screenshots of Home in EN and HE at 1440 and 390 width → `artifacts/ui/`, taken both immediately after load and after the demo finished loading (to prove the form does not move). Zero console errors. Look at every screenshot. Report what changed and the screenshot list.
