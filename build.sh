#!/usr/bin/env bash
# Render build command: substitutes __SUPABASE_URL__ and __SUPABASE_ANON_KEY__
# placeholders with the real values from environment variables, set under
# Render's dashboard -> your service -> Environment.
set -euo pipefail

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variable." >&2
  exit 1
fi

for file in index.html admin.html; do
  sed "s|__SUPABASE_URL__|${SUPABASE_URL}|g; s|__SUPABASE_ANON_KEY__|${SUPABASE_ANON_KEY}|g" "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
done

echo "Injected Supabase config into index.html and admin.html."
