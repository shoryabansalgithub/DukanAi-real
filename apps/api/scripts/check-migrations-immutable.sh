#!/usr/bin/env bash
# Roadmap 3.12 (audit P2-33): a migration that has been applied anywhere is
# never edited. Every migration file that exists on the base ref must be
# byte-identical on HEAD; new migration folders are fine, renamed, edited or
# deleted ones fail the build. Usage: check-migrations-immutable.sh <base-ref>
set -euo pipefail
base="${1:-origin/main}"
dir="apps/api/prisma/migrations"
root="$(git rev-parse --show-toplevel)"
cd "$root"
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "check-migrations-immutable: base ref '$base' is not available; fetch it first." >&2
  exit 2
fi
status=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if git cat-file -e "$base:$file" 2>/dev/null; then
    if ! git diff --quiet "$base" HEAD -- "$file"; then
      echo "::error file=$file::applied migration was modified or removed after $base; add a new migration instead" >&2
      status=1
    fi
  fi
done < <(git diff --name-only "$base" HEAD -- "$dir")
if [ "$status" -eq 0 ]; then echo "check-migrations-immutable: every migration on $base is unchanged on HEAD."; fi
exit "$status"
