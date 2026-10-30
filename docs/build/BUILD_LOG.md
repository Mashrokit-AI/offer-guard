# Build log

Everything in this repository was built during the Meta Global AI Developer Hackathon (building period Oct 27 – Nov 4, 2026). There is no pre-existing code: the repository started empty on Oct 29, 2026.

The code was built mainly with **Muse Code** (Meta's coding agent, model `muse-spark-1.3-contributor`); the rows without a session number are small follow-up commits made outside Muse Code. Each session was started with one written prompt; the exact prompts are in [`prompts/`](prompts/) (local paths, an image hash and a trace id replaced with placeholders). Every Muse Code session was exported with `muse export --redacted` right after it ended; those exports are kept privately because they contain our ad-account identifiers, and can be shared with the judges on request.

Times are Israel time (UTC+2).

| # | Date | Muse Code session | Prompt | Commit | Result |
|---|---|---|---|---|---|
| 1 | Oct 29 | 14:56–15:15 | [01-scaffold-and-meta-probe](prompts/01-scaffold-and-meta-probe.md) | `1803449` | TypeScript scaffold; day-1 Meta write-path probe (upload → creative → PAUSED ad → readback), dry run by default |
| — | Oct 29 | — | — | `a79a13d` | Follow-up hardening: secrets loaded from outside the repo, `AGENTS.md` rules for coding agents, stricter `.gitignore`, fake IDs in tests |
| 2 | Oct 29 | 15:51–15:56 | [02-fix-optout](prompts/02-fix-optout.md) | `462c0ba` | Graph v25 rejected `standard_enhancements` (subcode 3858504): detect by subcode, retry once without it, reuse the uploaded image hash. Live probe then passed all 6 readback checks |
| — | Oct 29 | — | — | `e58d440` | Build-log export guard |
| 3 | Oct 29 | 20:01–20:26 | [03-model-killtests](prompts/03-model-killtests.md) | `d7f007d` | Spark 1.3 Hebrew extraction and SAM 3.1 protection masks, live kill tests |
| — | Oct 29 | — | — | `77df8b6` | English twins of the synthetic GALI fixtures |
| 4 | Oct 29 | 20:30–21:12 | [04-repair-and-english](prompts/04-repair-and-english.md) | `e1e28b3` | Panel snap, protected masks, Chromium panel render (Hebrew + English), zero-diff pixel proof, fresh Spark revalidation; `killtest:repair` passes on all 6 fixtures |
| 5 | Oct 29–30 | 21:46–00:04, then one approval-gated command at 07:39 (the session waited overnight for a human approval) | [05-pages-capture-sweep](prompts/05-pages-capture-sweep.md) | `f9aa58f` | Landing pages (correct + wrong, with a visible prompt-injection line), guarded Playwright page capture, Spark page extraction with verified quotes, verdict rules in code, tool-call trace, SQLite store + cache, campaign sweep: 12/12 ads (6 cases × he/en) correct on a fresh run (32 model calls), 12/12 cache hits on the rerun; read-only campaign import and dry-run seed script (mocked tests) |

Live model calls in these sessions were made against Meta Model API; the Graph API was only called by the day-1 probe, against our own agency ad account, creating PAUSED objects in a dedicated test ad set. All ads and landing pages are synthetic (fictional brand "GALI").

This log is updated after every session.
