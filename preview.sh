#!/usr/bin/env bash
# Local preview server with real Supabase config injected, without ever
# touching the tracked index.html / admin.html (which keep the __PLACEHOLDER__
# tokens that Render's build.sh fills in at deploy time).
#
# Usage: bash preview.sh   (reads ./.env, serves on http://localhost:8000)
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "Missing SUPABASE_URL or SUPABASE_ANON_KEY (add them to .env)." >&2
  exit 1
fi

rm -rf .preview
mkdir .preview
cp -r ./*.html ./*.png .preview/ 2>/dev/null || true

for file in .preview/index.html .preview/admin.html; do
  sed "s|__SUPABASE_URL__|${SUPABASE_URL}|g; s|__SUPABASE_ANON_KEY__|${SUPABASE_ANON_KEY}|g" "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
done

echo "Serving .preview/ with real Supabase config at http://localhost:8000"
cd .preview && python3 -m http.server 8000
