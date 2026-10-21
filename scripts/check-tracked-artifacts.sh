#!/usr/bin/env bash
# Roadmap 7.4: runtime artifacts never enter the repository. Fails when git
# tracks anything under an upload directory, the storage root, the turbo
# daemon directory, a log file, a Redis dump or a database backup (roadmap 7.7). The ignore rules already
# refuse new ones (root .gitignore, apps/api/.gitignore, apps/api/uploads/
# .gitignore); this catches a `git add -f` or a rule that was added after
# the file.
set -euo pipefail
cd "$(dirname "$0")/.."
pattern='(^|/)\.turbo/|(^|/)uploads/.+|(^|/)data/storage/|\.log$|(^|/)dump\.rdb$|\.sql\.gz(\.sha256)?$'
offenders="$(git ls-files | grep -E "$pattern" | grep -vE '(^|/)\.gitignore$' || true)"
if [ -n "$offenders" ]; then
  printf 'Tracked runtime artifacts (remove with `git rm --cached <path>`):\n%s\n' "$offenders" >&2
  exit 1
fi
echo "No tracked runtime artifacts."
