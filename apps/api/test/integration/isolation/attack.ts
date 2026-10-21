import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { httpTarget } from '../pos-fixtures';
import { Handler } from '../route-enumeration';
import { modelOfField, modelsOfPath, NOT_A_ROW } from './id-models';
import { bodyProblems, exampleBody, idPaths, isIdField, withValueAt } from './request-bodies';
import { JPEG, PDF, PNG } from './seed-shop';

/**
 * The attack the cross-shop suite runs, once per direction: the attacker
 * shop's OWNER sends the victim shop's ids to every route, in every place a
 * route takes one (path parameters, body fields at any depth, query fields),
 * with a body that passes validation so the request reaches the code behind
 * the pipe. Every answer is recorded with a baseline: the same request with
 * an id nobody has. Assertions live in the spec.
 */

export type Ids = Map<string, string[]>;

export interface Probe {
  phase: 'read' | 'read-query' | 'write-path' | 'write-body' | 'shop-wide';
  route: string;
  /** Where the foreign id went (`:id`, `items.0.productId`, `?customerId`), or '' for none. */
  target: string;
  /** The model of the foreign id sent (or 'random' for the baseline, 'own' for the control). */
  sent: string;
  url: string;
  body?: unknown;
  status: number;
  code?: string;
  text: string;
  contentType: string;
}

/** Routes the attack never sends: they end the attacker's own session or shop, or take no shop context. */
export const NOT_ATTACKED: Record<string, string> = {
  'POST /api/auth/logout': "ends the attacker's own session; takes a refresh token, not an id",
  'POST /api/auth/change-password': "ends every session of the attacker's own account; takes no id",
  'DELETE /api/shops': "deletes the attacker's own shop; takes no id",
};

/** Write routes never sent with the attacker's own ids only: the request would succeed and end the attacker's session or shop. */
export const NO_CONTROL: Record<string, string> = {
  'POST /api/shops/transfer-ownership': "would hand the attacker's own shop to its own admin and end the attacking session",
};

/** The target name of a body's own-ids control. */
export const controlTarget = (bodyIndex: number) => `control (body ${bodyIndex + 1})`;

/** Multipart routes: the file part each needs and the fields that go with it. */
const UPLOADS: Record<string, { field: string; file: Buffer; filename: string; contentType: string; fields?: Record<string, string> }> = {
  'POST /api/expenses/:id/receipt': { field: 'file', file: JPEG, filename: 'r.jpg', contentType: 'image/jpeg' },
  'POST /api/media/upload/product/:id': { field: 'file', file: PNG, filename: 'p.png', contentType: 'image/png' },
  'POST /api/media/upload/variant/:id': { field: 'file', file: PNG, filename: 'v.png', contentType: 'image/png' },
  'POST /api/storage/bills/:customerId/:billId': { field: 'image', file: PNG, filename: 'b.png', contentType: 'image/png' },
  'POST /api/storage/invoices/:customerId/:invoiceId': { field: 'pdf', file: PDF, filename: 'i.pdf', contentType: 'application/pdf', fields: { jsonContent: '{}' } },
  'POST /api/storage/statements/:customerId': { field: 'pdf', file: PDF, filename: 's.pdf', contentType: 'application/pdf' },
  'POST /api/storage/cloud/upload': { field: 'file', file: PDF, filename: 'c.pdf', contentType: 'application/pdf' },
  'POST /api/ocr/scan-bill': { field: 'file', file: JPEG, filename: 'o.jpg', contentType: 'image/jpeg' },
  'POST /api/imports/products/upload': { field: 'file', file: Buffer.from('sku,name,sellingPrice,costPrice\nISO-1,Iso,10,5\n'), filename: 'p.csv', contentType: 'text/csv' },
  'POST /api/imports/customers/upload': { field: 'file', file: Buffer.from('name,phone\nIso,9876543210\n'), filename: 'c.csv', contentType: 'text/csv' },
  'POST /api/imports/opening-stock/upload': { field: 'file', file: Buffer.from('sku,quantity\nISO-1,1\n'), filename: 'o.csv', contentType: 'text/csv' },
};

/** Bodies the generator cannot derive from the DTO alone. */
const BODY_OVERRIDES: Record<string, Record<string, unknown>> = {
  'POST /api/products/:productId/variants/generate': { attributes: { Size: ['IsoS', 'IsoM'] } },
  'DELETE /api/storage/files/:customerId': { category: 'Invoices', datePath: '2026/10', fileName: 'none.pdf' },
};

const cuidLike = () => `c${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export interface AttackSetup {
  app: INestApplication;
  handlers: Handler[];
  token: string;
  own: Ids;
  victim: Ids;
  /** `:code` parameters: the victim's values to try (barcodes, SKUs) and the attacker's own, per route. */
  victimCodes: string[];
  ownCode: (handler: Handler) => string;
  /**
   * The attacker's own row to use, per route (`'*'` for every route), where the first row of the
   * model would stop the request before its ownership check (a document in the wrong state, a
   * variant of another product): `':param'` for a path parameter, the field name for a body field.
   * An empty string leaves an optional field out.
   */
  ownFor?: Record<string, Record<string, string>>;
  /** The victim's values to try for a field whose rows the model map cannot name (an event log's own event id, say). */
  victimFor?: Record<string, Record<string, string[]>>;
  /** More bodies per route, each attacked field by field like the generated one (a sale that pays exactly, say). */
  extraBodies?: Record<string, Array<() => Record<string, unknown>>>;
}

export async function runAttack(setup: AttackSetup): Promise<Probe[]> {
  const { app, handlers, token, own, victim } = setup;
  const probes: Probe[] = [];
  const ownId = (model: string | null | undefined) => (model ? own.get(model)?.[0] : undefined);
  /** One victim row of every model: what an unknown field or parameter is tried with. */
  const everyModel = [...victim.entries()].map(([model, ids]) => ({ model, id: ids[0] }));
  const victimRows = (model: string | null | undefined) => (model && victim.get(model) ? victim.get(model)!.map((id) => ({ model, id })) : everyModel);

  const send = async (phase: Probe['phase'], handler: Handler, target: string, sent: string, url: string, body?: unknown): Promise<Probe> => {
    let req = request(httpTarget(app))[handler.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](url).set('Authorization', `Bearer ${token}`);
    const upload = UPLOADS[handler.key];
    if (upload) {
      for (const [k, v] of Object.entries({ ...(body as Record<string, unknown> | undefined), ...upload.fields })) req = req.field(k, typeof v === 'string' ? v : JSON.stringify(v));
      req = req.attach(upload.field, upload.file, { filename: upload.filename, contentType: upload.contentType });
    } else if (handler.method !== 'GET') {
      req = req.set('Content-Type', 'application/json').send((body ?? {}) as object);
    }
    const res = await req;
    const contentType = String(res.headers['content-type'] ?? '');
    const text = contentType.includes('json') || contentType.startsWith('text/') ? (res.text ?? '') : `<${contentType} ${res.body?.length ?? 0} bytes>`;
    const probe: Probe = { phase, route: handler.key, target, sent, url, body, status: res.status, code: (res.body as { code?: string } | undefined)?.code, text, contentType };
    probes.push(probe);
    return probe;
  };

  /** The path with every parameter filled: `fill(param)` decides each one. */
  const pathWith = (handler: Handler, fill: (param: string, model: string | null) => string | undefined) => {
    let url = handler.path;
    for (const { param, model } of modelsOfPath(handler.path)) url = url.replace(`:${param}`, encodeURIComponent(fill(param, model) ?? cuidLike()));
    return url;
  };
  /** The attacker's own value for `name` on this route: per route, then for every route; undefined when it has none ('' = leave out). */
  const ownForRoute = (handler: Handler, name: string): string | undefined | null => {
    for (const scope of [handler.key, '*']) {
      const table = setup.ownFor?.[scope];
      if (table && name in table) return table[name] === '' ? null : table[name];
    }
    return undefined;
  };
  const ownParamOf = (handler: Handler) => (param: string, model: string | null) => ownForRoute(handler, `:${param}`) ?? (param === 'code' ? setup.ownCode(handler) : param === 'kind' ? 'products' : param === 'billId' ? `iso-${randomUUID().slice(0, 8)}` : ownId(model));
  const ownIdsOf = (handler: Handler) => (field: string) => {
    const chosen = ownForRoute(handler, field);
    return chosen === null ? undefined : (chosen ?? ownId(modelOfField(field, handler.path)));
  };
  const bodyFor = (handler: Handler) => BODY_OVERRIDES[handler.key] ?? (handler.bodyType ? exampleBody(handler.bodyType, ownIdsOf(handler), 'att') : undefined);
  /** The query a GET needs to pass validation (required fields of its query DTO), with `extra` on top. */
  const withQuery = (handler: Handler, url: string, extra: Record<string, string> = {}) => {
    const required = handler.queryType ? exampleBody(handler.queryType, ownIdsOf(handler), 'q') : {};
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...required, ...extra })) if (v !== undefined && typeof v !== 'object') params.set(k, String(v));
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  };

  const attacked = handlers.filter((h) => !h.isPublic && !(h.key in NOT_ATTACKED));

  // 1. Reads: every GET, the victim's rows in each path parameter; the own row as control, a random id as baseline.
  for (const handler of attacked.filter((h) => h.method === 'GET')) {
    const params = modelsOfPath(handler.path);
    if (params.length === 0) {
      await send('read', handler, '', 'none', withQuery(handler, handler.path));
      continue;
    }
    await send('read', handler, '', 'own', withQuery(handler, pathWith(handler, ownParamOf(handler))));
    for (const { param, model } of params) {
      const others = (p: string, m: string | null) => (p === param ? undefined : ownParamOf(handler)(p, m));
      await send('read', handler, `:${param}`, 'random', withQuery(handler, pathWith(handler, (p, m) => (p === param ? (param === 'code' ? `NOCODE${randomUUID().slice(0, 6)}` : cuidLike()) : others(p, m)))));
      if (param === 'kind' || param === 'billId') continue;
      // The victim's rows of the parameter's model, then one row of every other model it has (a route reading the wrong table).
      const tries = param === 'code' ? setup.victimCodes.map((id) => ({ model: 'code', id })) : [...victimRows(model), ...(model ? everyModel.filter((t) => t.model !== model) : [])];
      for (const t of tries) await send('read', handler, `:${param}`, t.model, withQuery(handler, pathWith(handler, (p, m) => (p === param ? t.id : others(p, m)))));
    }
  }

  // 2. Reads with ids in the query (filters such as ?customerId=): the victim's rows must filter to nothing of theirs.
  for (const handler of attacked.filter((h) => h.method === 'GET')) {
    const fields = [...(handler.queryType ? Object.keys(exampleBody(handler.queryType, () => 'x', 'q')) : []), ...handler.queryNames].filter(isIdField);
    for (const field of new Set(fields)) {
      for (const t of victimRows(modelOfField(field, handler.path))) {
        await send('read-query', handler, `?${field}`, t.model, withQuery(handler, pathWith(handler, ownParamOf(handler)), { [field]: t.id }));
      }
    }
  }

  // 3. Writes addressed at a victim row: a valid body of the attacker's own ids, the victim's row in the path.
  for (const handler of attacked.filter((h) => h.method !== 'GET')) {
    const params = modelsOfPath(handler.path).filter((p) => !NOT_A_ROW.has(p.param));
    for (const { param, model } of params) {
      const others = (p: string, m: string | null) => (p === param ? undefined : ownParamOf(handler)(p, m));
      await send('write-path', handler, `:${param}`, 'random', pathWith(handler, (p, m) => (p === param ? cuidLike() : others(p, m))), bodyFor(handler));
      for (const t of victimRows(model)) await send('write-path', handler, `:${param}`, t.model, pathWith(handler, (p, m) => (p === param ? t.id : others(p, m))), bodyFor(handler));
    }
  }

  // 4. Writes of the attacker's own rows that name a victim row in the body, one field at a time, in every body the route is given.
  for (const handler of attacked.filter((h) => h.method !== 'GET' && h.bodyType)) {
    const templates = [() => bodyFor(handler), ...(setup.extraBodies?.[handler.key] ?? [])];
    for (const [i, template] of templates.entries()) {
      for (const path of idPaths(template())) {
        const field = path.split('.').pop()!;
        if (NOT_A_ROW.has(field)) continue;
        const model = modelOfField(field, handler.path);
        const target = i === 0 ? path : `${path} (body ${i + 1})`;
        const url = pathWith(handler, ownParamOf(handler));
        const tries = setup.victimFor?.[handler.key]?.[field]?.map((id) => ({ model: field, id })) ?? victimRows(model);
        await send('write-body', handler, target, 'random', url, withValueAt(template(), path, cuidLike()));
        for (const t of tries) await send('write-body', handler, target, t.model, url, withValueAt(template(), path, t.id));
      }
      // Last, the body as it is (every id the attacker's own): proof that the refusals above came from the attacked field.
      if (!(handler.key in NO_CONTROL)) await send('write-body', handler, controlTarget(i), 'own', pathWith(handler, ownParamOf(handler)), template());
    }
  }

  // 5. Shop-wide writes with no id at all (sweeps, read-all, reindex, backup, ...): they must stay inside the attacker's shop.
  for (const handler of attacked.filter((h) => h.method !== 'GET' && modelsOfPath(h.path).length === 0)) {
    if (handler.key === 'POST /api/shops/transfer-ownership') continue; // only ever sent with a victim user (phase 4)
    await send('shop-wide', handler, '', 'own', handler.path, bodyFor(handler));
  }
  return probes;
}

/** The generated bodies that would not pass validation (the attack would stop at the pipe for those routes). */
export function invalidBodies(handlers: Handler[]): string[] {
  return handlers
    .filter((h) => h.method !== 'GET' && !h.isPublic && h.bodyType && !(h.key in BODY_OVERRIDES) && !(h.key in NOT_ATTACKED))
    .map((h) => ({ h, problems: bodyProblems(h.bodyType!, exampleBody(h.bodyType!, () => cuidLike(), 'att')) }))
    .filter((r) => r.problems.length > 0)
    .map((r) => `${r.h.key}: ${r.problems.join('; ')}`);
}
