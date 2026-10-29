# Rules for coding agents working in this repo (Muse Code etc.)

- Never read, print, copy or summarize `.env`, `~/.config/offer-guard/secrets.env`, or any environment variable whose name contains TOKEN, KEY or SECRET.
- Never put real Meta IDs, tokens or client data in code, tests, fixtures, docs or commit messages. Use obviously fake values in tests.
- Never run `npm run probe:meta -- --execute` or `npm run cleanup:probe -- --execute` — a human runs those.
- Never `git push`. A human reviews and pushes.
- Only `PAUSED` may ever be sent as an ad status.
