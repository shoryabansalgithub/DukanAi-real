#!/usr/bin/env bash
# Attaches release assets to the GitHub release of a tag: the certification
# evidence bundle (roadmap 9.12) and the CycloneDX SBOMs of the images
# (roadmap 9.14). The release is created as a DRAFT when the tag has none, so
# the owner publishes it after reading the evidence; an asset of the same name
# is replaced (a re-run of the job). Plain REST calls with the workflow's own
# token (contents: write); no third-party action.
#
# RELEASE_NOTES_FILE (roadmap 9.21): the notes a new draft starts with (the
# tag's CHANGELOG.md section, `scripts/release/release.mjs notes`); a release
# that already exists keeps the text the owner gave it. A tag with a
# pre-release part (v1.0.0-rc3) is created as a pre-release.
#
#   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo [RELEASE_NOTES_FILE=notes.md] \
#     scripts/certify/attach-release.sh v1.2.3 certification-v1.2.3.tar.gz sbom-api.cdx.json ...
set -euo pipefail
TAG="${1:?usage: attach-release.sh TAG FILE [FILE...]}"
shift
[ "$#" -ge 1 ] || { echo "usage: attach-release.sh TAG FILE [FILE...]" >&2; exit 2; }
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY (owner/repo) is required}"
API="${GITHUB_API_URL:-https://api.github.com}"
for f in "$@"; do [ -f "$f" ] || { echo "no such file: $f" >&2; exit 2; }; done

gh_api() {
  curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}
json_field() { node -e 'let b="";process.stdin.on("data",(d)=>b+=d).on("end",()=>{const v=JSON.parse(b)[process.argv[1]];process.stdout.write(v===undefined||v===null?"":String(v))})' "$1"; }
# A conservative media type from the extension (GitHub stores the bytes regardless).
content_type() {
  case "$1" in
    *.tar.gz|*.tgz) echo 'application/gzip' ;;
    *.json) echo 'application/json' ;;
    *.txt|*.md) echo 'text/plain' ;;
    *) echo 'application/octet-stream' ;;
  esac
}

release="$(gh_api "$API/repos/$GITHUB_REPOSITORY/releases/tags/$TAG" 2>/dev/null || true)"
if [ -z "$release" ]; then
  echo "no release for $TAG yet: creating a draft"
  notes=""
  if [ -n "${RELEASE_NOTES_FILE:-}" ]; then
    [ -f "$RELEASE_NOTES_FILE" ] || { echo "RELEASE_NOTES_FILE $RELEASE_NOTES_FILE does not exist" >&2; exit 2; }
    notes="$RELEASE_NOTES_FILE"
  fi
  body="$(node -e '
    const [tag, notesFile] = process.argv.slice(1);
    const notes = notesFile ? require("fs").readFileSync(notesFile, "utf8").trim() : "";
    const evidence = "Release evidence (roadmap 9.12 / 9.14): the certification bundle (see its SUMMARY.md) and the CycloneDX SBOMs of the images are attached. Publish once the evidence has been read (RELEASE.md).";
    process.stdout.write(JSON.stringify({ tag_name: tag, name: tag, draft: true, prerelease: tag.includes("-"), body: notes ? `${notes}\n\n---\n\n${evidence}` : evidence }));
  ' "$TAG" "$notes")"
  release="$(gh_api -X POST "$API/repos/$GITHUB_REPOSITORY/releases" -d "$body")"
fi
id="$(printf '%s' "$release" | json_field id)"
[ -n "$id" ] || { echo "could not read the release id" >&2; exit 1; }
upload_url="$(printf '%s' "$release" | json_field upload_url)"
upload_url="${upload_url%%\{*}"

for file in "$@"; do
  name="$(basename "$file")"
  # Replace an asset of the same name (idempotent re-runs).
  existing="$(gh_api "$API/repos/$GITHUB_REPOSITORY/releases/$id/assets?per_page=100" | node -e 'let b="";process.stdin.on("data",(d)=>b+=d).on("end",()=>{const a=JSON.parse(b).find((x)=>x.name===process.argv[1]);process.stdout.write(a?String(a.id):"")})' "$name")"
  if [ -n "$existing" ]; then
    echo "replacing the existing asset $name (id $existing)"
    gh_api -X DELETE "$API/repos/$GITHUB_REPOSITORY/releases/$id/assets/$existing" >/dev/null
  fi
  gh_api -X POST -H "Content-Type: $(content_type "$name")" --data-binary "@$file" "$upload_url?name=$name" | json_field browser_download_url
  echo " <- $name"
done
echo "attached $# asset(s) to release $id ($TAG)$( [ "$(printf '%s' "$release" | json_field draft)" = true ] && echo ', a draft until the owner publishes it' )"
