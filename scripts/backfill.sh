#!/bin/sh
# Embeds existing documents so semantic search works. Run again and again
# until it prints "All done."
#   ./scripts/backfill.sh https://YOUR-SITE.pages.dev
set -e
URL="${1:?Usage: ./scripts/backfill.sh https://YOUR-SITE.pages.dev}"
URL="${URL%/}"
while :; do
  out=$(curl -s -X POST "$URL/api/backfill")
  echo "$out"
  case "$out" in *'"more":false'*|*'"more": true'*) echo "All done."; exit 0;; esac
  sleep 2
done
