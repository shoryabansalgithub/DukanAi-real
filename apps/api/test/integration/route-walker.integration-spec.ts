import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { ANY_AUTHENTICATED_KEY } from '../../src/auth/any-authenticated.decorator';
import { IS_PUBLIC_KEY } from '../../src/auth/public.decorator';
import { ROLES_KEY } from '../../src/auth/roles.decorator';
import { bearerToken, createUser, ownerOf } from '../security/security-fixtures';
import { bootApp, createShop, httpTarget, TestShop } from './pos-fixtures';

/**
 * Phase 4 exit gate: every registered route, as nobody, a VIEWER, the OWNER of
 * another shop and the OWNER of the shop, with an empty body and random ids.
 * The domain suites prove the happy paths; this one proves the edges the
 * audit called out: no handler answers 500 (a missing parameter, an unknown
 * id or a wrong state is a 4xx with a code), anonymous callers get 401
 * everywhere but the public routes, a VIEWER is refused on every role-gated
 * write before any validation runs, and an id of another shop never answers
 * 2xx. The handler list comes from the Nest discovery metadata, the same
 * source `RouteAuthorizationAssertion` uses at boot, so a new controller is
 * walked without touching this file. Under CERTIFY_API_URL (roadmap 9.12)
 * every request goes to the running release candidate image instead of the
 * in-process server, the booted module only supplies the fixtures, and a
 * route the image does not serve (Nest's "Cannot GET /..." 404) fails the
 * walk; CERTIFY_REPORT_DIR receives every outcome as route-walk.json.
 */
jest.setTimeout(240_000);

interface Handler {
  key: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  isPublic: boolean;
  anyAuthenticated: boolean;
  roles: Role[] | undefined;
}

const METHODS: Record<number, Handler['method'] | undefined> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

/**
 * Routes that end a session or the shop: walked last, as the OWNER only, in
 * this order. Logout runs first on a session opened just for it, so the
 * owner's walking session stays valid; the shop delete is the very last call.
 */
const DESTRUCTIVE_TAIL = ['POST /api/auth/logout', 'DELETE /api/auth/sessions/:id', 'POST /api/shops/transfer-ownership', 'DELETE /api/shops'];

/** Public routes where a 401 is the credential verdict, not a missing session. */
const PUBLIC_MAY_ANSWER_401: Record<string, string> = {
  'POST /api/auth/login': 'an empty body is a failed credential check (LocalAuthGuard), which is 401 by contract',
};

/** Routes whose path parameter is not a row of the shop, so a foreign id legitimately answers 2xx. */
const FOREIGN_ID_IS_NOT_A_ROW: Record<string, string> = {
  'GET /api/product-identity/barcode/:code/render': 'renders the barcode image for any code string; no row is read',
};

function enumerateHandlers(app: INestApplication): Handler[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const handlers = new Map<string, Handler>();
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    const prefixes = ([] as string[]).concat((Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined) ?? '');
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, metatype) === true;
    const classAny = Reflect.getMetadata(ANY_AUTHENTICATED_KEY, metatype) === true;
    const classRoles = Reflect.getMetadata(ROLES_KEY, metatype) as Role[] | undefined;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const fn = prototype[name];
      if (typeof fn !== 'function') continue;
      const method = METHODS[Reflect.getMetadata(METHOD_METADATA, fn) as number];
      if (!method) continue;
      const paths = ([] as string[]).concat((Reflect.getMetadata(PATH_METADATA, fn) as string | string[] | undefined) ?? '');
      for (const prefix of prefixes) {
        for (const sub of paths) {
          const path = ('/api/' + [prefix, sub].filter((p) => p && p !== '/').join('/')).replace(/\/+/g, '/').replace(/\/$/, '');
          const key = `${method} ${path}`;
          handlers.set(key, {
            key,
            method,
            path,
            isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, fn) === true,
            anyAuthenticated: classAny || Reflect.getMetadata(ANY_AUTHENTICATED_KEY, fn) === true,
            roles: (Reflect.getMetadata(ROLES_KEY, fn) as Role[] | undefined) ?? classRoles,
          });
        }
      }
    }
  }
  return [...handlers.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Every path parameter becomes a random id (an unknown row), `:code` a code no barcode carries. */
const withRandomIds = (path: string) => path.replace(/:([A-Za-z]+)/g, (_, name: string) => (name === 'code' ? `NOCODE-${randomUUID().slice(0, 8)}` : randomUUID()));

interface Outcome {
  who: string;
  handler: Handler;
  status: number;
  body: string;
}

describe('route walker (phase 4 exit gate): every handler, four identities, never a 500', () => {
  let app: INestApplication;
  let shop: TestShop;
  let foreignShop: TestShop;
  let tokens: { viewer: string; foreign: string; owner: string; ownerLogout: string };
  let handlers: Handler[];
  const outcomes: Outcome[] = [];

  async function hit(who: string, token: string | null, handler: Handler): Promise<void> {
    const url = withRandomIds(handler.path);
    let req = request(httpTarget(app))[handler.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](url);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    if (handler.method !== 'GET') req = req.set('Content-Type', 'application/json').send({});
    const res = await req;
    outcomes.push({ who, handler, status: res.status, body: typeof res.text === 'string' ? res.text.slice(0, 200) : '' });
  }

  beforeAll(async () => {
    app = await bootApp();
    shop = await createShop(app, 'walk');
    foreignShop = await createShop(app, 'walkB');
    const viewer = await createUser(app, shop, Role.VIEWER);
    tokens = {
      viewer: await bearerToken(app, shop, viewer),
      foreign: await bearerToken(app, foreignShop, ownerOf(foreignShop)),
      owner: await bearerToken(app, shop, ownerOf(shop)),
      // A second session of the same owner, spent by POST /auth/logout in the tail.
      ownerLogout: await bearerToken(app, shop, ownerOf(shop)),
    };
    handlers = enumerateHandlers(app);
    const body = handlers.filter((h) => !DESTRUCTIVE_TAIL.includes(h.key));
    const tail = DESTRUCTIVE_TAIL.map((key) => handlers.find((h) => h.key === key)).filter((h): h is Handler => Boolean(h));
    for (const h of body) await hit('anonymous', null, h);
    for (const h of body) await hit('viewer', tokens.viewer, h);
    for (const h of body) await hit('foreign owner', tokens.foreign, h);
    for (const h of body) await hit('owner', tokens.owner, h);
    for (const h of tail) await hit('owner', h.key === 'POST /api/auth/logout' ? tokens.ownerLogout : tokens.owner, h);
  });

  afterAll(async () => {
    if (process.env.CERTIFY_REPORT_DIR) {
      mkdirSync(process.env.CERTIFY_REPORT_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.CERTIFY_REPORT_DIR, 'route-walk.json'),
        JSON.stringify(
          {
            target: process.env.CERTIFY_API_URL ?? 'in-process',
            handlers: handlers.length,
            outcomes: outcomes.map((o) => ({ who: o.who, route: o.handler.key, status: o.status, body: o.body })),
          },
          null,
          2,
        ),
      );
    }
    await app?.close();
  });

  const describeOutcome = (o: Outcome) => `${o.who}: ${o.handler.key} -> ${o.status} ${o.body}`;

  it('enumerates the whole route surface from the discovery metadata', () => {
    expect(handlers.length).toBeGreaterThan(200);
    expect(handlers.some((h) => h.key === 'POST /api/billing/invoice')).toBe(true);
    for (const key of DESTRUCTIVE_TAIL) expect(handlers.some((h) => h.key === key)).toBe(true);
  });

  it('every enumerated route is served by the target (no "Cannot <METHOD> /..." answer)', () => {
    // Nest answers an unregistered path with a 404 whose message starts with "Cannot <METHOD>";
    // a handler's own NotFoundException names a code instead. Under CERTIFY_API_URL this is
    // what proves the image carries the same route surface as the checkout it was built from.
    const missing = outcomes.filter((o) => o.status === 404 && /Cannot (GET|POST|PUT|PATCH|DELETE) /.test(o.body)).map(describeOutcome);
    expect(missing).toEqual([]);
  });

  it('no handler answers 500 (or drops the connection) for any identity', () => {
    const failures = outcomes.filter((o) => o.status >= 500 || o.status === 0).map(describeOutcome);
    expect(failures).toEqual([]);
  });

  it('an anonymous caller gets 401 on every route that is not @Public', () => {
    const leaks = outcomes.filter((o) => o.who === 'anonymous' && !o.handler.isPublic && o.status !== 401).map(describeOutcome);
    expect(leaks).toEqual([]);
    const publicOk = outcomes
      .filter((o) => o.who === 'anonymous' && o.handler.isPublic && (o.status === 403 || (o.status === 401 && !(o.handler.key in PUBLIC_MAY_ANSWER_401))))
      .map(describeOutcome);
    expect(publicOk).toEqual([]);
    for (const key of Object.keys(PUBLIC_MAY_ANSWER_401)) expect(handlers.some((h) => h.key === key && h.isPublic)).toBe(true);
  });

  it('a VIEWER is refused (403) on every role-gated write before anything else runs', () => {
    const leaks = outcomes
      .filter((o) => o.who === 'viewer' && o.handler.method !== 'GET' && !o.handler.isPublic && !o.handler.anyAuthenticated)
      .filter((o) => o.handler.roles && !o.handler.roles.includes(Role.VIEWER) && o.status !== 403)
      .map(describeOutcome);
    expect(leaks).toEqual([]);
  });

  it('the OWNER is never refused for want of a session or a role, and the logout session really ends', () => {
    const refused = outcomes
      .filter((o) => o.who === 'owner' && !o.handler.isPublic)
      .filter((o) => o.status === 401 || (o.status === 403 && (!o.handler.roles || o.handler.roles.includes(Role.OWNER))))
      .map(describeOutcome);
    expect(refused).toEqual([]);
    const logout = outcomes.find((o) => o.who === 'owner' && o.handler.key === 'POST /api/auth/logout');
    expect(logout?.status).toBeLessThan(300);
  });

  it("another shop's OWNER never gets 2xx for an id that is not theirs", () => {
    const leaks = outcomes
      .filter((o) => o.who === 'foreign owner' && o.handler.path.includes(':') && o.status < 300)
      .filter((o) => !(o.handler.key in FOREIGN_ID_IS_NOT_A_ROW))
      .map(describeOutcome);
    expect(leaks).toEqual([]);
    for (const key of Object.keys(FOREIGN_ID_IS_NOT_A_ROW)) expect(handlers.some((h) => h.key === key)).toBe(true);
  });
});
