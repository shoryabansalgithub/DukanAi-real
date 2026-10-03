/**
 * Static policy scan over every controller source file (no app boot):
 *  1. every POST/PUT/PATCH/DELETE handler declares `@Roles`, `@AnyAuthenticated`
 *     or `@Public` (on the method or the class) — the runtime twin is
 *     `RouteAuthorizationAssertion`, which refuses to boot otherwise;
 *  2. every `@Body()` parameter is typed with a validated DTO class, never
 *     `any`, `unknown`, `object`, an array of those or an inline object type,
 *     so `ValidationPipe` (whitelist + forbidNonWhitelisted) always runs and
 *     no request body can reach Prisma unfiltered. A body that is a free-form
 *     JSON document goes through an explicit pipe (`@Body(JsonObjectPipe)`).
 */
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '..');
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All']);
const READ_DECORATORS = new Set(['Get', 'Head', 'Options']);
const POLICY_DECORATORS = new Set(['Roles', 'AnyAuthenticated', 'Public']);
const FORBIDDEN_BODY_TYPES = /^(any|unknown|object|any\[\]|unknown\[\]|object\[\]|\{[\s\S]*\})$/;

interface Handler {
  location: string;
  http: string;
  hasPolicy: boolean;
  bodies: { type: string; hasPipe: boolean }[];
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

function decoratorNames(node: ts.Node, sf: ts.SourceFile): { name: string; args: readonly ts.Expression[] }[] {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  return decorators.map((d) => {
    const ex = d.expression;
    return ts.isCallExpression(ex) ? { name: ex.expression.getText(sf), args: ex.arguments } : { name: ex.getText(sf), args: [] };
  });
}

function scan(): Handler[] {
  const handlers: Handler[] = [];
  for (const file of controllerFiles(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const rel = path.relative(SRC, file);
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && decoratorNames(node, sf).some((d) => d.name === 'Controller')) {
        const classPolicy = decoratorNames(node, sf).some((d) => POLICY_DECORATORS.has(d.name));
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const decos = decoratorNames(member, sf);
          const http = decos.find((d) => HTTP_DECORATORS.has(d.name));
          if (!http) continue;
          handlers.push({
            location: `${rel} ${node.name?.text}.${member.name.getText(sf)}`,
            http: http.name,
            hasPolicy: classPolicy || decos.some((d) => POLICY_DECORATORS.has(d.name)),
            bodies: member.parameters
              .filter((p) => decoratorNames(p, sf).some((d) => d.name === 'Body'))
              .map((p) => ({
                type: (p.type?.getText(sf) ?? 'any').replace(/\s+/g, ' '),
                hasPipe: decoratorNames(p, sf).some((d) => d.name === 'Body' && d.args.length > 0 && !ts.isStringLiteral(d.args[0])),
              })),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return handlers;
}

describe('route authorization policy (static scan of every controller)', () => {
  const handlers = scan();

  it('finds the controllers', () => {
    expect(handlers.length).toBeGreaterThan(100);
  });

  it('every state-changing handler declares @Roles, @AnyAuthenticated or @Public', () => {
    const offenders = handlers.filter((h) => !READ_DECORATORS.has(h.http) && !h.hasPolicy).map((h) => `${h.http} ${h.location}`);
    expect(offenders).toEqual([]);
  });

  it('every @Body() parameter is a validated DTO class (no any / inline object types)', () => {
    const offenders = handlers.flatMap((h) =>
      h.bodies
        .filter((b) => FORBIDDEN_BODY_TYPES.test(b.type) || (/^Record<|Record</.test(b.type) && !b.hasPipe))
        .map((b) => `${h.location}: @Body() ${b.type}`),
    );
    expect(offenders).toEqual([]);
  });
});
