#!/usr/bin/env bash
# Export the latest Muse Code session (redacted) as evidence that the work was built during the hackathon.
# Usage: npm run buildlog:save -- <short-label>      e.g. npm run buildlog:save -- 02-spark-extraction
set -euo pipefail
label="${1:-session}"
stamp="$(date +%Y%m%d-%H%M)"
out_dir=".local/build-log"
backup_dir="${OFFER_GUARD_BUILDLOG_BACKUP:-$HOME/Desktop/משרוקית/meta-hackathon/build-log}"
mkdir -p "$out_dir" "$backup_dir"
file="$out_dir/${stamp}-${label}.json"
"$HOME/.local/bin/muse" export --last --redacted --out "$file" >/dev/null
# refuse to keep a log that contains one of our real secrets (exact values from the out-of-repo secrets file),
# or anything token-shaped that starts on a word boundary (not inside base64 image data)
if ! python3 -I - "$file" "${OFFER_GUARD_SECRETS_FILE:-$HOME/.config/offer-guard/secrets.env}" <<'PY'
import os, re, sys
log = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
secrets = []
if os.path.exists(sys.argv[2]):
    for line in open(sys.argv[2], encoding='utf-8'):
        name, _, value = line.strip().partition('=')
        if re.search(r'TOKEN|KEY|SECRET', name) and len(value) >= 12:
            secrets.append(value)
if any(v in log for v in secrets):
    print('contains a real secret from the secrets file', file=sys.stderr); sys.exit(1)
if re.search(r'(?<![A-Za-z0-9+/_-])(EAA[A-Za-z0-9]{20,}|LLM[_|][0-9]{6,}[_|][A-Za-z0-9]{8,})', log):
    print('contains something that looks like an access token or API key', file=sys.stderr); sys.exit(1)
PY
then
  echo "WARNING: $file — not copied to backup. Inspect it." >&2
  exit 1
fi
cp "$file" "$backup_dir/"
echo "saved $file (+ copy in $backup_dir)"
