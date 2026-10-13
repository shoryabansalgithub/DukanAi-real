// node --test scripts/release/release.test.mjs (run by the CI lint job)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changelogProblems, changelogSection, compareTags, parseTag, releaseProblems } from './release.mjs';

const CHANGELOG = `# Changelog

## [v1.0.0-rc3] - 2026-10-08

### Added
- Onboarding imports.

## [v1.0.0-rc2] - 2026-06-20

### Fixed
- Something.
`;

test('parses semantic version tags and refuses the rest', () => {
  assert.deepEqual(parseTag('v1.0.0-rc3'), { major: 1, minor: 0, patch: 0, prerelease: ['rc3'] });
  assert.deepEqual(parseTag('v2.10.3'), { major: 2, minor: 10, patch: 3, prerelease: [] });
  for (const bad of ['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0+build.1', 'v1.0.0-', 'v1.0.0-rc.01', 'release-1']) assert.equal(parseTag(bad), null, bad);
});

test('orders versions by semver precedence', () => {
  const ordered = ['v0.9.0', 'v1.0.0-alpha', 'v1.0.0-rc.2', 'v1.0.0-rc.10', 'v1.0.0-rc1', 'v1.0.0-rc2', 'v1.0.0-rc3', 'v1.0.0', 'v1.0.1', 'v1.1.0'];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareTags(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compareTags('v1.0.0-rc3', 'v1.0.0-rc3'), 0);
  // The documented trap: alphanumeric identifiers compare as text.
  assert.ok(compareTags('v1.0.0-rc10', 'v1.0.0-rc2') < 0);
});

test('reads a dated CHANGELOG section', () => {
  assert.deepEqual(changelogSection(CHANGELOG, 'v1.0.0-rc3'), { heading: '## [v1.0.0-rc3] - 2026-10-08', date: '2026-10-08', body: '### Added\n- Onboarding imports.' });
  assert.equal(changelogSection(CHANGELOG, 'v1.0.0-rc4'), null);
  assert.equal(changelogSection('## [v1.0.0] - UNRELEASED\n- x\n', 'v1.0.0').date, null);
  // The link definitions at the foot of the file are not part of the last section.
  assert.equal(changelogSection(`${CHANGELOG}\n[v1.0.0-rc3]: https://example/v1.0.0-rc3\n`, 'v1.0.0-rc2').body, '### Fixed\n- Something.');
});

test('lint: headings dated, newest first, once each, the newest = package.json', () => {
  assert.deepEqual(changelogProblems(CHANGELOG, '1.0.0-rc3'), []);
  assert.deepEqual(changelogProblems(`## [Unreleased]\n- next\n\n${CHANGELOG}`, '1.0.0-rc3'), []);
  assert.match(changelogProblems(CHANGELOG, '1.0.0')[0], /newest CHANGELOG.md section is v1.0.0-rc3 but package.json says 1.0.0/);
  assert.match(changelogProblems('## [v1.0.0-rc3] - 2026-10-08\n- a\n## [Unreleased]\n', '1.0.0-rc3')[0], /\[Unreleased\] comes before every version/);
  assert.match(changelogProblems('## [v1.0.0-rc2] - 2026-06-20\n- a\n## [v1.0.0-rc3] - 2026-10-08\n- b\n', '1.0.0-rc2')[0], /v1.0.0-rc3 is listed below v1.0.0-rc2/);
  assert.match(changelogProblems('## [v1.0.0-rc3] - 2026-10-08\n- a\n## [v1.0.0-rc3] - 2026-10-08\n- b\n', '1.0.0-rc3')[0], /second section/);
  assert.match(changelogProblems('## [v1.0.0-rc3] - UNRELEASED\n- a\n', '1.0.0-rc3')[0], /is not "## \[vX.Y.Z\] - YYYY-MM-DD"/);
  assert.match(changelogProblems('## [1.0.0] - 2026-10-08\n- a\n', '1.0.0')[0], /not a semantic version tag/);
  assert.match(changelogProblems('# Changelog\n', '1.0.0')[0], /no dated version section/);
});

test('a release needs the version everywhere, a dated section, a higher version and main', () => {
  const ok = { tag: 'v1.0.0-rc3', packageVersion: '1.0.0-rc3', changelog: CHANGELOG, existingTags: ['v1.0.0-rc1', 'v1.0.0-rc2'], onMain: true };
  assert.deepEqual(releaseProblems(ok), []);
  assert.deepEqual(releaseProblems({ ...ok, onMain: undefined }), []);
  assert.match(releaseProblems({ ...ok, packageVersion: '0.1.0' })[0], /package.json version is 0.1.0/);
  assert.deepEqual(releaseProblems({ ...ok, workspaceVersions: { 'apps/api': '1.0.0-rc3', 'apps/web': '1.0.0-rc3' } }), []);
  assert.match(releaseProblems({ ...ok, workspaceVersions: { 'apps/api': '1.0.0-rc3', 'apps/web': '0.1.0' } })[0], /apps\/web\/package.json version is 0.1.0/);
  assert.match(releaseProblems({ ...ok, tag: 'v1.0.0-rc4', packageVersion: '1.0.0-rc4' })[0], /no "## \[v1.0.0-rc4\]/);
  assert.match(releaseProblems({ ...ok, changelog: '## [v1.0.0-rc3] - UNRELEASED\n- x\n' })[0], /not dated/);
  assert.match(releaseProblems({ ...ok, changelog: '## [v1.0.0-rc3] - 2026-10-08\n\nnothing yet\n' })[0], /lists no change/);
  assert.match(releaseProblems({ ...ok, existingTags: ['v1.0.0'] })[0], /v1.0.0 is already released/);
  assert.match(releaseProblems({ ...ok, onMain: false })[0], /not on main/);
  assert.match(releaseProblems({ ...ok, tag: 'v1.0' })[0], /not a semantic version tag/);
});
