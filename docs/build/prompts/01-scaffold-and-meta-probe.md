You are starting a new hackathon project called **Offer Guard** in this empty folder. Read the design first, then do ONLY the two tasks below. Do not build the rest of the system yet.

## 0. Context
- Copy `<team workspace>/offer-guard-architecture.md` into `docs/ARCHITECTURE.md` and read it. It is the source of truth (stack, repo layout, Graph API flow, safety rules).
- Rules of the hackathon: public GitHub repo, only code written now, no client data, no secrets in the repo.

## 1. Scaffold (small)
- TypeScript on Node 20 (installed here: v20.18), ES modules, `tsx` for running scripts, `vitest` for tests, Zod for schemas.
- Create the folder layout from docs/ARCHITECTURE.md section 10 (empty `index.ts` placeholders are fine), plus `scripts/` and `.local/` (gitignored).
- `.gitignore`: node_modules, .env, .local/, artifacts/, *.log.
- A `.env` and `.gitignore` already exist in this folder — keep them, do not print `.env` contents, extend `.gitignore` if needed.
- `.env.example` with: `META_ACCESS_TOKEN=`, `META_GRAPH_VERSION=v25.0`, `META_AD_ACCOUNT_ID=` (without `act_`), `META_PAGE_ID=`, `META_ADSET_ID=`, `META_TEST_LINK_URL=`, `MODEL_API_KEY=`, `MODEL_API_BASE=https://api.meta.ai/v1`.
- Load config from `.env` with Zod validation; never print the token (mask it in all logs).
- `git init` locally and add the remote `https://github.com/Mashrokit-AI/offer-guard.git` (already created, public, empty). Do NOT push — I will review and push myself.
- Copy the test images and offer spec from `<team workspace>/fixtures/` into `fixtures/ads/`.

## 2. Day-1 kill test: Meta write path (`scripts/probe-meta-write.ts`)
Goal: prove we can create a PAUSED replacement ad on our own account and read it back.

Steps, each logged to the console and appended to `.local/probe-journal.jsonl` (timestamp, step, request summary without token, response IDs, error if any):
1. `GET /me?fields=id,name` and `GET /act_{id}?fields=name,account_status,currency` — sanity check token and account.
2. `GET /{adset_id}?fields=id,name,status,campaign{id,name,status,objective}` — the ad set must exist and its status must NOT be ACTIVE; abort otherwise.
3. Generate a simple 1080×1080 PNG test image locally with Sharp (solid background + a rectangle "offer panel"; no text needed yet).
4. `POST /act_{id}/adimages` (upload the PNG) → keep the returned `hash`.
5. `POST /act_{id}/adcreatives` with an explicit payload: `name`, `object_story_spec { page_id, link_data { image_hash, link: META_TEST_LINK_URL, message: "Offer Guard probe – test only", name: "Offer Guard probe", call_to_action { type: "LEARN_MORE" } } }`. Try to opt out of automatic creative enhancements using the field that Graph v25 documents; if Meta rejects that field, log the error, retry once without it, and report it clearly.
6. `POST /act_{id}/ads` with `name: "Offer Guard probe <timestamp>"`, `adset_id`, `creative: { creative_id }`, `status: "PAUSED"`.
7. Readback: `GET /{new_ad_id}?fields=id,name,status,configured_status,effective_status,adset_id,creative{id,image_hash,object_story_spec}` and assert: status/configured_status is PAUSED, adset_id matches, image_hash matches step 4, link and message match. Print PASS/FAIL per assertion.

Safety rules (hard requirements):
- **Dry run by default**: without `--execute` the script only prints the requests it would send (steps 4–6). With `--execute` it sends them.
- The script must never send any status other than `PAUSED`, never edit or pause existing ads, never touch budgets, and never create campaigns or ad sets.
- Persist every returned ID to the journal immediately after each POST. If a POST times out, do not retry blindly: first look for the object (by name, in the ad set) and report what you find.
- On any Graph error, print `error.code`, `error_subcode`, `error_user_msg` and `fbtrace_id`, then stop.

Also add `scripts/cleanup-probe.ts`: reads `.local/probe-journal.jsonl` and, only with `--execute`, deletes ONLY the ads and creatives created by the probe (by the IDs in the journal). Nothing else.

## 3. Deliverables
- `npm run probe:meta` (dry run) and `npm run probe:meta -- --execute`.
- A short `README.md` section "Day-1 probe" explaining how to run it.
- Unit tests for: config validation, token masking, and the "only PAUSED" guard.
- At the end, show me the dry-run output and stop. I will run `--execute` myself.
