#!/bin/sh
# Prints the most asked questions and the ones with no matching document.
# Usage: ./scripts/counts.sh https://YOUR-SITE.pages.dev [plugin]
set -eu

URL="${1:?Usage: $0 API_URL [plugin]}"
PLUGIN="${2:-}"

if [ -n "$PLUGIN" ]; then
  Q="plugin=$(printf '%s' "$PLUGIN" | sed 's/ /%20/g')"
else
  Q=""
fi

echo "== Top asked =="
curl -fsS "${URL%/}/api/top${Q:+?$Q}"
echo
echo "== Unanswered =="
curl -fsS "${URL%/}/api/unanswered${Q:+?$Q}"
echo
