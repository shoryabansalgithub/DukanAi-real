// node --test scripts/release/attach-release.test.mjs (run by the CI lint job)
//
// scripts/certify/attach-release.sh against a stub of the GitHub releases API
// that behaves like the real one where it matters: GET /releases/tags/{tag}
// answers 404 for a DRAFT (audit 2026-10-11, R6: the images job created the
// draft, the certify job could not see it and created a second one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'certify', 'attach-release.sh');
const REPO = 'owner/repo';

function stubGitHub({ failList = false } = {}) {
  const state = { releases: [], nextId: 100, posts: 0, uploads: [], deletes: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      const base = `/repos/${REPO}/releases`;
      const path = url.pathname;
      if (req.method === 'GET' && path.startsWith(`${base}/tags/`)) {
        const release = state.releases.find((r) => r.tag_name === decodeURIComponent(path.slice(`${base}/tags/`.length)) && !r.draft);
        return release ? send(200, release) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'GET' && path === base) {
        if (failList) return send(500, { message: 'boom' });
        const page = Number(url.searchParams.get('page') ?? 1);
        return send(200, page === 1 ? [...state.releases].reverse() : []);
      }
      if (req.method === 'POST' && path === base) {
        state.posts += 1;
        const input = JSON.parse(body);
        const id = state.nextId++;
        const release = { ...input, id, assets: [], upload_url: `http://127.0.0.1:${server.address().port}/uploads${base}/${id}/assets{?name,label}` };
        state.releases.push(release);
        return send(201, release);
      }
      let m = /^\/repos\/owner\/repo\/releases\/(\d+)$/.exec(path);
      if (req.method === 'GET' && m) {
        const release = state.releases.find((r) => r.id === Number(m[1]));
        return release ? send(200, release) : send(404, { message: 'Not Found' });
      }
      m = /^\/repos\/owner\/repo\/releases\/(\d+)\/assets$/.exec(path);
      if (req.method === 'GET' && m) return send(200, state.releases.find((r) => r.id === Number(m[1])).assets);
      m = /^\/repos\/owner\/repo\/releases\/(\d+)\/assets\/(\d+)$/.exec(path);
      if (req.method === 'DELETE' && m) {
        const release = state.releases.find((r) => r.id === Number(m[1]));
        release.assets = release.assets.filter((a) => a.id !== Number(m[2]));
        state.deletes += 1;
        return send(204);
      }
      m = /^\/uploads\/repos\/owner\/repo\/releases\/(\d+)\/assets$/.exec(path);
      if (req.method === 'POST' && m) {
        const release = state.releases.find((r) => r.id === Number(m[1]));
        const name = url.searchParams.get('name');
        const asset = { id: state.nextId++, name, browser_download_url: `https://example.invalid/${release.tag_name}/${name}` };
        release.assets.push(asset);
        state.uploads.push({ release: release.id, name, bytes: body.length });
        return send(201, asset);
      }
      send(404, { message: `stub: no route ${req.method} ${path}` });
    });
  });
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => resolveServer({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function attach(apiUrl, tag, files, extraEnv = {}) {
  const env = { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: REPO, GITHUB_API_URL: apiUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...extraEnv };
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'RELEASE_ID', 'GITHUB_OUTPUT', 'RELEASE_NOTES_FILE']) if (!(key in extraEnv)) delete env[key];
  return new Promise((resolveRun) => {
    execFile('bash', [SCRIPT, tag, ...files], { env }, (error, stdout, stderr) => resolveRun({ code: error ? error.code : 0, stdout, stderr }));
  });
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'attach-release-'));
  const file = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  return { dir, file };
}

test('the images job creates ONE draft; the certify job finds that draft and attaches to it', async () => {
  const { server, state, url } = await stubGitHub();
  const ws = workspace();
  try {
    const notes = ws.file('notes.md', '### Fixed\n- Something.\n');
    const output = ws.file('github-output', '');
    const images = await attach(url, 'v1.2.3', [ws.file('sbom-dukaanai-api.cdx.json', '{}')], { RELEASE_NOTES_FILE: notes, GITHUB_OUTPUT: output });
    assert.equal(images.code, 0, images.stderr);
    assert.equal(state.posts, 1);
    assert.equal(state.releases[0].draft, true);
    assert.match(state.releases[0].body, /Something/);
    assert.match(readFileSync(output, 'utf8'), new RegExp(`^release-id=${state.releases[0].id}$`, 'm'));

    // The real API answers 404 for the draft by tag: the lookup must not depend on it.
    const byTag = await fetch(`${url}/repos/${REPO}/releases/tags/v1.2.3`);
    assert.equal(byTag.status, 404);

    const certify = await attach(url, 'v1.2.3', [ws.file('certification-v1.2.3.tar.gz', 'bundle')]);
    assert.equal(certify.code, 0, certify.stderr);
    assert.equal(state.posts, 1, 'no second release was created');
    assert.equal(state.releases.length, 1);
    assert.deepEqual(state.releases[0].assets.map((a) => a.name).sort(), ['certification-v1.2.3.tar.gz', 'sbom-dukaanai-api.cdx.json']);
  } finally {
    server.close();
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('RELEASE_ID names the release directly; a re-run replaces an asset of the same name', async () => {
  const { server, state, url } = await stubGitHub();
  const ws = workspace();
  try {
    const first = await attach(url, 'v2.0.0', [ws.file('a.json', '{}')]);
    assert.equal(first.code, 0, first.stderr);
    const id = String(state.releases[0].id);
    const again = await attach(url, 'v2.0.0', [ws.file('a.json', '{"v":2}')], { RELEASE_ID: id });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(state.posts, 1);
    assert.equal(state.deletes, 1);
    assert.deepEqual(state.releases[0].assets.map((a) => a.name), ['a.json']);
  } finally {
    server.close();
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('a failed lookup never creates a draft (a transient error must not leave two releases)', async () => {
  const { server, state, url } = await stubGitHub({ failList: true });
  const ws = workspace();
  try {
    const run = await attach(url, 'v3.0.0', [ws.file('a.json', '{}')]);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /could not read the releases/);
    assert.equal(state.posts, 0);
  } finally {
    server.close();
    rmSync(ws.dir, { recursive: true, force: true });
  }
});
