import { readdirSync, readFileSync, statSync } from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';

/**
 * Every package the API imports at runtime must be declared in its own
 * `dependencies` (roadmap 7.1 rule, enforced after 7.3): the container image
 * installs the API workspace alone (`npm ci --omit=dev -w api`), so a package
 * that only reached node_modules through another workspace (next-auth's
 * `uuid`) or through devDependencies is absent there, and the process dies at
 * boot with MODULE_NOT_FOUND. The monorepo's hoisted node_modules hides that
 * in development, so this spec is the guard.
 */
describe('runtime dependency declarations', () => {
  const apiRoot = path.resolve(__dirname, '..');
  const pkg = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const declared = new Set(Object.keys(pkg.dependencies));
  const builtins = new Set(builtinModules);
  const specifier = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"]([^'"./][^'"]*)['"]/g;

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts') ? [full] : [];
    });

  const packageName = (spec: string): string => {
    const clean = spec.replace(/^node:/, '');
    const parts = clean.split('/');
    return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  };

  it('every package imported from src/ (specs excluded) is in dependencies', () => {
    const undeclared = new Map<string, string[]>();
    for (const file of sourceFiles(path.join(apiRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifier)) {
        const name = packageName(match[1]);
        if (match[1].startsWith('node:') || builtins.has(name) || declared.has(name)) continue;
        undeclared.set(name, [...(undeclared.get(name) ?? []), path.relative(apiRoot, file)]);
      }
    }
    expect(
      [...undeclared].map(([name, files]) => `${name} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})`),
    ).toEqual([]);
  });
});
