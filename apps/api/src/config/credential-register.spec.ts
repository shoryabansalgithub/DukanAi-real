import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * docs/SECRETS.md is the register of every secret (roadmap 9.11). A new
 * secret-looking variable in a committed template must get a row there
 * (its owner and rotation), and a row must name a variable a template
 * documents, so the register and the templates cannot drift apart.
 */
const ROOT = resolve(__dirname, '../../../..');
const TEMPLATES = ['.env.example', 'apps/api/.env.example', 'apps/web/.env.example', 'deploy/k8s/dukaanai-secrets.env.example'];
const SECRET_SUFFIX = /(_SECRET|_PASSWORD|_TOKEN|_API_KEY|_DSN|_WEBHOOK_URL|_ROUTING_KEY|_CRYPT_PASSWORD|_CRYPT_SALT|_SECRET_KEY|_ACCESS_KEY)$/;
const SECRET_NAMES = new Set(['DATABASE_URL', 'DB_OPS_DATABASE_URL', 'REDIS_URL', 'SMTP_URL']);
/** Register rows that name a family of variables rather than one. */
const FAMILIES = ['RCLONE_CONFIG_<NAME>_*'];

function templateVariables(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of TEMPLATES) {
    for (const line of readFileSync(resolve(ROOT, file), 'utf8').split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
      if (!match) continue;
      const list = found.get(match[1]) ?? [];
      list.push(file);
      found.set(match[1], list);
    }
  }
  return found;
}

function registerVariables(): string[] {
  const doc = readFileSync(resolve(ROOT, 'docs/SECRETS.md'), 'utf8');
  const register = doc.slice(doc.indexOf('## Register'), doc.indexOf('## Procedures'));
  const names: string[] = [];
  for (const row of register.split('\n').filter((l) => l.startsWith('| `'))) {
    const firstCell = row.split('|')[1];
    for (const m of firstCell.matchAll(/`([A-Z][A-Z0-9_<>*]*)`/g)) names.push(m[1]);
  }
  return names;
}

describe('secrets register (docs/SECRETS.md)', () => {
  const templates = templateVariables();
  const register = registerVariables();

  it('lists every secret-looking variable of the committed templates', () => {
    const secrets = [...templates.keys()].filter((name) => SECRET_SUFFIX.test(name) || SECRET_NAMES.has(name));
    expect(secrets.length).toBeGreaterThanOrEqual(20);
    const missing = secrets.filter((name) => !register.includes(name));
    expect(missing).toEqual([]);
  });

  it('names only variables a template documents (or a documented family)', () => {
    const unknown = register.filter((name) => !templates.has(name) && !FAMILIES.includes(name) && !name.startsWith('GITHUB_') && !['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(name));
    expect(unknown).toEqual([]);
  });

  it('holds a procedure for the secrets the roadmap names', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/SECRETS.md'), 'utf8');
    for (const heading of ['### `JWT_SECRET`', '### `NEXTAUTH_SECRET`', '### `DATABASE_URL`', '### `SMTP_URL`', '### `GOOGLE_CLIENT_SECRET`', '### `SENTRY_DSN`', '### `METRICS_TOKEN`']) {
      expect(doc).toContain(heading);
    }
    expect(doc).toContain('sessions:revoke-all');
  });
});
