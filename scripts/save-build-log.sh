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
# refuse to keep a log that contains something that looks like a real Meta token
if grep -qE 'EAA[A-Za-z0-9]{20,}|LLM[_|][0-9]{6,}[_|][A-Za-z0-9]{8,}' "$file"; then
  echo "WARNING: $file looks like it contains a Meta access token — not copied to backup. Inspect it." >&2
  exit 1
fi
cp "$file" "$backup_dir/"
echo "saved $file (+ copy in $backup_dir)"
