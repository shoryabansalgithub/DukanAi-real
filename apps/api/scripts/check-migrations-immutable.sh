#!/usr/bin/env bash
# Roadmap 3.12 (audit P2-33): a migration that has been applied anywhere is
# never edited. Every migration file that exists on a base ref must be
# byte-identical on HEAD; new migration folders are fine, renamed, edited or
# deleted ones fail the build.
#
#   check-migrations-immutable.sh <base-ref> [<base-ref> ...]
#
# CI passes every ref a deployment may already have applied (audit
# 2026-10-11, P1-14: comparing origin/main with itself on a push to main
# compared nothing): the commit before the push (github.event.before) or the
# pull request's base, and the newest release tag (`--latest-tag` below
# resolves it, skipping a tag on HEAD itself). A base that IS HEAD compares
# nothing; when HEAD itself changes the migrations directory that is an error,
# never a silent pass.
#
#   --latest-tag   also compare with the newest v* tag merged into HEAD
#                  (by tag date) that does not point at HEAD, when one exists
set -euo pipefail
dir="apps/api/prisma/migrations"
root="$(git rev-parse --show-toplevel)"
cd "$root"

bases=()
latest_tag=0
for arg in "$@"; do
  case "$arg" in
    --latest-tag) latest_tag=1 ;;
    -*) echo "check-migrations-immutable: unknown option $arg" >&2; exit 2 ;;
    *) bases+=("$arg") ;;
  esac
done
head="$(git rev-parse HEAD)"
if [ "$latest_tag" = 1 ]; then
  tag=""
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    [ "$(git rev-parse "$t^{commit}")" = "$head" ] && continue
    tag="$t"; break
  done < <(git tag --merged HEAD --list 'v[0-9]*' --sort=-creatordate)
  if [ -n "$tag" ]; then bases+=("$tag"); else echo "check-migrations-immutable: no earlier v* tag is merged into HEAD (fetch tags, or none was released yet)."; fi
fi
[ "${#bases[@]}" -gt 0 ] || bases=(origin/main)

# HEAD's own change to the migrations directory (first parent; the root commit counts in full).
head_touches_migrations() {
  if git rev-parse --verify --quiet "HEAD^" >/dev/null; then
    ! git diff --quiet HEAD^ HEAD -- "$dir"
  else
    [ -n "$(git ls-tree -r --name-only HEAD -- "$dir")" ]
  fi
}

status=0
compared=0
for base in "${bases[@]}"; do
  if ! sha="$(git rev-parse --verify --quiet "$base^{commit}")"; then
    echo "::error::check-migrations-immutable: base ref '$base' is not available; fetch it first." >&2
    exit 2
  fi
  if [ "$sha" = "$head" ]; then
    if head_touches_migrations; then
      echo "::error::check-migrations-immutable: base '$base' is HEAD itself, so nothing was compared, and HEAD changes $dir. Pass the commit before the push or the pull request base." >&2
      status=1
    else
      echo "check-migrations-immutable: base '$base' is HEAD itself (HEAD does not touch $dir); nothing to compare there."
    fi
    continue
  fi
  compared=$((compared + 1))
  base_status=0
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if git cat-file -e "$base:$file" 2>/dev/null; then
      if ! git diff --quiet "$base" HEAD -- "$file"; then
        echo "::error file=$file::applied migration was modified or removed after $base; add a new migration instead" >&2
        base_status=1
      fi
    fi
  done < <(git diff --name-only "$base" HEAD -- "$dir")
  if [ "$base_status" -eq 0 ]; then
    echo "check-migrations-immutable: every migration on $base ($(git rev-parse --short "$sha")) is unchanged on HEAD."
  else
    status=1
  fi
done
if [ "$status" -eq 0 ] && [ "$compared" -eq 0 ]; then
  echo "check-migrations-immutable: no base differed from HEAD; nothing was compared." >&2
fi
exit "$status"
