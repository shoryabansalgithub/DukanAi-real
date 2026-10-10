import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import { ENV_VARIABLE_KEY } from './registry/registry.decorators';
import { EnterpriseConfigModule } from './enterprise-config.module';

/**
 * Roadmap 8.5: `.env.example` documents every environment variable the API
 * reads, and no template carries a variable nothing reads. Both directions
 * are checked from the source of truth:
 *
 *  - declared variables are the `@EnvVariable` names of every config domain
 *    that `EnterpriseConfigModule` provides (read through the registry
 *    metadata, so a domain file nobody wires does not count) plus the direct
 *    `process.env.X` reads in application source (specs excluded);
 *  - a template key that is declared nowhere is dead config.
 *
 * Adding a variable means adding it to `.env.example` with a comment; removing
 * one means removing it from every template.
 */
const API_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(API_ROOT, 'src');
const TEMPLATES = ['.env.example', '.env.production', '.env.development', '.env.test'];

/**
 * Not configuration of the API itself: read before the config module exists
 * (`NODE_ENV` selects the env file), or consumed by a tool rather than the
 * process. Each stays documented in `.env.example` anyway.
 */
const DIRECT_READS_OUTSIDE_DOMAINS = new Set(['NODE_ENV']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

function templateKeys(file: string): string[] {
  return readFileSync(path.join(API_ROOT, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.slice(0, line.indexOf('=')).trim());
}

function providedDomains(): Array<new () => object> {
  const meta = Reflect.getMetadata('providers', EnterpriseConfigModule) as Array<{ provide?: unknown } | (new () => object)>;
  return meta.map((p) => (typeof p === 'function' ? p : p.provide)).filter((p): p is new () => object => typeof p === 'function');
}

function declaredVariables(): Set<string> {
  const declared = new Set<string>();
  for (const domain of providedDomains()) {
    for (const variable of (Reflect.getMetadata(ENV_VARIABLE_KEY, domain) as string[] | undefined) ?? []) declared.add(variable);
  }
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) declared.add(match[1]);
  }
  return declared;
}

describe('environment variables are documented and alive (roadmap 8.5)', () => {
  const declared = declaredVariables();
  const example = new Set(templateKeys('.env.example'));

  it('reads a meaningful number of variables (the scan found the domains)', () => {
    expect(declared.size).toBeGreaterThan(100);
  });

  it('every variable the API reads is documented in .env.example', () => {
    const undocumented = [...declared].filter((v) => !example.has(v)).sort();
    expect(undocumented).toEqual([]);
  });

  it.each(TEMPLATES)('%s carries no variable nothing reads, and no duplicate key', (file) => {
    const keys = templateKeys(file);
    const dead = keys.filter((k) => !declared.has(k) && !DIRECT_READS_OUTSIDE_DOMAINS.has(k)).sort();
    expect(dead).toEqual([]);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(duplicates).toEqual([]);
  });

  it('every provided config domain declares at least one variable (an empty domain is dead config)', () => {
    const empty = providedDomains()
      .filter((domain) => ((Reflect.getMetadata(ENV_VARIABLE_KEY, domain) as string[] | undefined) ?? []).length === 0)
      .map((domain) => domain.name);
    expect(empty).toEqual([]);
  });
});
