#!/usr/bin/env node
// Release checks and notes (roadmap 9.21). RELEASE.md runs `check` before a
// version tag is pushed, and .github/workflows/release.yml runs it again on
// the tag before any image is built, so a tag that is not a release cannot
// produce release images.
//
//   node scripts/release/release.mjs check v1.0.0-rc3     # exit 1 with every problem listed
//   node scripts/release/release.mjs notes v1.0.0-rc3     # the CHANGELOG.md section, for the release notes
//   node scripts/release/release.mjs lint                 # CHANGELOG.md in the shape a release needs (CI)
//
// `check` requires:
//   1. a semantic version tag: vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE
//      (semver 2.0.0, no build metadata, no leading zeros);
//   2. the "version" of the root, apps/api and apps/web package.json equal to it
//      without the v (the product's version; packages/invoice-math keeps its own);
//   3. a dated CHANGELOG.md section for it, `## [vX.Y.Z...] - YYYY-MM-DD`, with
//      at least one entry (an "UNRELEASED" section is not a release);
//   4. a version above every release tag already in the repository (semver
//      precedence: v1.0.0-rc3 < v1.0.0; rc1..rc9 compare as intended, rc10
//      would sort before rc2, so a tenth candidate is a reason to release);
//   5. the commit on main, when the main branch is known locally (origin/main or main).
//
// `lint` (every CI run) requires every "## " heading of CHANGELOG.md to be
// "## [Unreleased]" (first, optional) or "## [vX.Y.Z...] - YYYY-MM-DD", newest
// first, each version once, and the newest dated section to be the root
// package.json version: the version is bumped in the commit that dates its
// section, never on its own.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/** The parts of a release tag, or null when it is not a semantic version tag. */
export function parseTag(tag) {
  const m = SEMVER.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [] };
}

/** Semver 2.0.0 precedence: negative when a < b. */
export function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) throw new Error(`not a version tag: ${!x ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return x[key] - y[key];
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The CHANGELOG.md section of a version: its heading's date and its body, or null. */
export function changelogSection(changelog, tag) {
  const lines = changelog.split('\n');
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^## \\[${escaped}\\]`).test(line));
  if (start < 0) return null;
  const heading = lines[start];
  // A section ends at the next version heading or at the link definitions at the foot.
  let end = lines.findIndex((line, i) => i > start && (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)));
  if (end < 0) end = lines.length;
  const date = /^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(heading)?.[1] ?? null;
  return { heading, date, body: lines.slice(start + 1, end).join('\n').trim() };
}

/** The structural problems of CHANGELOG.md (see `lint` above); empty when there are none. */
export function changelogProblems(changelog, packageVersion) {
  const problems = [];
  const versions = [];
  changelog.split('\n').forEach((line, i) => {
    if (!/^## /.test(line)) return;
    if (line === '## [Unreleased]') {
      if (versions.length > 0) problems.push(`line ${i + 1}: [Unreleased] comes before every version`);
      return;
    }
    const m = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (!m) return problems.push(`line ${i + 1}: "${line}" is not "## [vX.Y.Z] - YYYY-MM-DD" or "## [Unreleased]"`);
    const [, version, date] = m;
    if (!parseTag(version)) return problems.push(`line ${i + 1}: ${version} is not a semantic version tag`);
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) problems.push(`line ${i + 1}: ${date} is not a date`);
    if (versions.includes(version)) problems.push(`line ${i + 1}: ${version} has a second section`);
    else if (versions.length > 0 && compareTags(versions[versions.length - 1], version) <= 0) problems.push(`line ${i + 1}: ${version} is listed below ${versions[versions.length - 1]} but is not older`);
    versions.push(version);
  });
  if (versions.length === 0) problems.push('CHANGELOG.md has no dated version section');
  else if (packageVersion !== undefined && versions[0] !== `v${packageVersion}`) problems.push(`the newest CHANGELOG.md section is ${versions[0]} but package.json says ${packageVersion}: bump both in the same commit`);
  return problems;
}

/** Every problem that keeps `tag` from being released; empty when it may be. */
export function releaseProblems({ tag, packageVersion, workspaceVersions = {}, changelog, existingTags, onMain }) {
  const problems = [];
  if (!parseTag(tag)) {
    problems.push(`${tag} is not a semantic version tag (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE)`);
    return problems;
  }
  const bump = `npm version ${tag.slice(1)} --no-git-tag-version --include-workspace-root -w api -w dukaanai-web`;
  if (packageVersion !== tag.slice(1)) problems.push(`package.json version is ${packageVersion}, the tag says ${tag.slice(1)} (${bump})`);
  for (const [where, version] of Object.entries(workspaceVersions)) {
    if (version !== tag.slice(1)) problems.push(`${where}/package.json version is ${version}, the tag says ${tag.slice(1)} (${bump})`);
  }
  const section = changelogSection(changelog, tag);
  if (!section) problems.push(`CHANGELOG.md has no "## [${tag}] - YYYY-MM-DD" section`);
  else {
    if (!section.date) problems.push(`the CHANGELOG.md section of ${tag} is not dated: "${section.heading}"`);
    else if (Number.isNaN(Date.parse(`${section.date}T00:00:00Z`))) problems.push(`the CHANGELOG.md section of ${tag} has an impossible date ${section.date}`);
    if (!/^\s*- /m.test(section.body)) problems.push(`the CHANGELOG.md section of ${tag} lists no change`);
  }
  for (const other of existingTags.filter((t) => t !== tag && parseTag(t))) {
    if (compareTags(other, tag) >= 0) problems.push(`${other} is already released and is not below ${tag}`);
  }
  if (onMain === false) problems.push(`the commit is not on main: a release is cut from main`);
  return problems;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const readVersion = (dir) => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')).version;

function main(argv) {
  const [command, tag] = argv;
  if (!(['check', 'notes'].includes(command) && tag) && command !== 'lint') {
    console.error('usage: release.mjs check|notes vX.Y.Z[-PRERELEASE] | release.mjs lint');
    return 2;
  }
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (command === 'lint') {
    const problems = changelogProblems(changelog, readVersion('.'));
    if (problems.length > 0) {
      console.error(`CHANGELOG.md:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
      return 1;
    }
    console.log(`CHANGELOG.md: well formed, newest section v${readVersion('.')} = package.json`);
    return 0;
  }
  if (command === 'notes') {
    const section = changelogSection(changelog, tag);
    if (!section) {
      console.error(`CHANGELOG.md has no section for ${tag}`);
      return 1;
    }
    process.stdout.write(`${section.body}\n`);
    return 0;
  }
  const packageVersion = readVersion('.');
  const workspaceVersions = { 'apps/api': readVersion('apps/api'), 'apps/web': readVersion('apps/web') };
  const existingTags = (git(['tag', '--list', 'v*']) ?? '').split('\n').filter(Boolean);
  const main = git(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main' : git(['rev-parse', '--verify', '--quiet', 'main']) ? 'main' : null;
  const commit = git(['rev-parse', `${tag}^{commit}`]) ?? git(['rev-parse', 'HEAD']);
  const onMain = main && commit ? git(['merge-base', '--is-ancestor', commit, main]) !== null : undefined;
  const problems = releaseProblems({ tag, packageVersion, workspaceVersions, changelog, existingTags, onMain });
  if (problems.length > 0) {
    console.error(`${tag} cannot be released:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }
  const earlier = existingTags.filter((t) => t !== tag && parseTag(t)).length;
  console.log(`${tag}: semantic version, package.json ${packageVersion}, CHANGELOG section dated ${changelogSection(changelog, tag).date}, above ${earlier} earlier release tag(s)${onMain === undefined ? ' (main not known locally: not checked)' : ', on main'}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
