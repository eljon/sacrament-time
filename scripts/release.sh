#!/usr/bin/env bash
# Snapshot the current app into /v<APP_VERSION>/ and refresh versions.html, so a
# new version is archived in the same branch commit as the change itself — no tag
# push required. Run this after bumping APP_VERSION in app.js, before committing.
set -euo pipefail
cd "$(dirname "$0")/.."

ver=$(grep -oE 'APP_VERSION = [0-9]+' app.js | head -1 | grep -oE '[0-9]+' || true)
[ -n "${ver}" ] || { echo "error: could not read APP_VERSION from app.js" >&2; exit 1; }

mkdir -p "v${ver}"
for f in index.html styles.css app.js config.js; do
  cp "$f" "v${ver}/${f}"
done
bash scripts/gen-versions.sh
echo "snapshotted v${ver} -> v${ver}/ and refreshed versions.html"
