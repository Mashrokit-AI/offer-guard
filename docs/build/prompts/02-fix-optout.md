The day-1 probe ran with --execute and failed at step 5 (adcreatives).

Graph v25 answered: code 100, error_subcode 3858504, "Invalid parameter". The user message (localized to Hebrew) says the standard_enhancements field is deprecated and individual features must be set instead. fbtrace_id <redacted>. Steps 1–4 succeeded; the uploaded image hash is <image-hash>.

The "retry once without the opt-out" fallback did NOT trigger, because the detection looked for English field names in the error text and the text was localized.

Please fix, then stop:
1. Detect the opt-out rejection by `error_subcode === 3858504` (and, as a fallback, code 100 when the request contained degrees_of_freedom_spec) — never by message language.
2. On that error, retry step 5 once WITHOUT degrees_of_freedom_spec, and journal which payload variant Meta accepted.
3. Add an optional `--image-hash <hash>` flag: when given, skip steps 3–4 and reuse that hash (so we don't re-upload images on every retry). Validate it is 32 hex chars.
4. Unit tests: the rejection detector (subcode 3858504 → true; other code-100 errors without degrees_of_freedom_spec → false), and the flag parser.
5. Run the tests and a dry run (`npm run probe:meta -- --image-hash <image-hash>`). Do NOT run --execute and do not push. Follow AGENTS.md.
