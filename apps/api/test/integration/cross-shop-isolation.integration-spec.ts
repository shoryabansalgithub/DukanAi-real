/**
 * Cross-shop isolation, exhaustively (audit 2026-10-12): two fully populated
 * shops attack each other through every route of the API, and every
 * background job, report, export, stored file and socket is checked for
 * what it shows each shop.
 *
 * - Seeding (`isolation/seed-shop.ts`) puts a row in nearly every table a
 *   shop owns through the routes people use, and runs the outbox relays,
 *   workers and nightly analytics, so the victim's ids cover over 90 models.
 * - The attack (`isolation/attack.ts`) runs once per direction as the
 *   attacking shop's OWNER: every GET with each victim id in each path
 *   parameter and query filter; every write with a body that passes
 *   validation and a victim id in the path, then in each id field of the
 *   body; every shop-wide write (sweeps, read-all, reindex, backup).
 *   Mapped parameters get the victim's rows of that model, unknown ones a row
 *   of every model the victim has.
 * - Proofs: no victim id ever answers 2xx where a row is read (and the
 *   attacker's own id does: the route works), a victim id answers exactly
 *   like an id nobody has (no existence oracle), the victim's data is
 *   byte-for-byte unchanged (a checksum over every column of every row the
 *   shop owns, child tables included) and so are its files, no answer of any
 *   status carries a victim id, name, phone or email the request did not
 *   send, and no row of either shop names a row of the other
 *   (`auditCrossShopReferences`, which also proves it can see a planted one).
 * - Reports, exports, KPIs, the dashboard cache, search history,
 *   reconciliation, imports, sweeps, analytics, webhook deliveries, socket
 *   broadcasts and the storage backup are each checked per shop.
 */
import { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { OUTBOUND_RESOLVER } from '../../src/common/net/outbound-url-guard';
import { OutboxRelayService } from '../../src/common/outbox/outbox-relay.service';
import { jobContext } from '../../src/iam/tenant-context/job-context';
import { TenantContextService } from '../../src/iam/tenant-context/tenant-context.service';
import { AuthenticatedIoAdapter } from '../../src/iam/websockets/authenticated-io.adapter';
import { queueInstances } from '../../src/common/lifecycle/queue-readiness';
import { AnalyticsJobScheduler } from '../../src/analytics-domain/services/analytics-job.scheduler';
import { PrismaService } from '../../src/prisma/prisma.service';
import { auditCrossShopReferences } from '../../src/prisma/cross-shop-audit';
import { WebhookHttpClient, WebhookPostRequest } from '../../src/product-events/services/webhook-http-client';
import { OutboxProcessorWorker } from '../../src/product-events/workers/outbox.worker';
import { PurchaseOutboxRelayCron } from '../../src/purchase-events-domain/workers/purchase-outbox-relay.cron';
import { StoragePathBuilder } from '../../src/storage/storage-path.builder';
import { bootApp, httpTarget, tenantRunner } from './pos-fixtures';
import { enumerateHandlers, Handler } from './route-enumeration';
import { invalidBodies, NO_CONTROL, NOT_ATTACKED, Probe, runAttack } from './isolation/attack';
import { modelsOfPath } from './isolation/id-models';
import { client, OWNER_PASSWORD, seedShop, SeededShop } from './isolation/seed-shop';
import { fingerprintDiff, shopFingerprint, ShopFingerprint, shopIds, shopStrings } from './isolation/shop-data';

jest.setTimeout(1_800_000);

const PUBLIC_IP = '93.184.216.34';

/** GET routes whose path parameter is not a row of the shop, so any value answers alike. */
const NOT_A_ROW_READ: Record<string, string> = {
  'GET /api/product-identity/barcode/:code/render': 'draws the barcode image of any code string; reads no row',
  'GET /api/imports/templates/:kind': 'serves a fixed CSV template; the parameter names a template, not a row',
};

/** Routes that answer 2xx for a victim id because they act only on the caller's own rows, exactly as for an id nobody has. */
const UNIFORM_NO_OP: Record<string, string> = {
  'DELETE /api/auth/sessions/:id': "revokes the id among the caller's own sessions only (`where: { id, userId }`); any other id is a no-op answered alike",
};

/** Single-parameter GET routes whose own-row control is not a 2xx, with the reason. */
const NO_OWN_CONTROL: Record<string, string> = {
  'GET /api/expenses/:id/receipt': 'the first expense of the shop by id may not carry the receipt; the seeded one is checked in the files test',
  'GET /api/imports/jobs/:id/errors': 'answers for the first import job by id, which may be a job without errors only when it failed outright',
};

/**
 * A refusal that comes from the ownership lookup itself (the row is looked for inside the caller's
 * shop and is not there) although the route answers it with 400: the same answer an id of nobody
 * gets. Anything else (a state or payment rule refusing first) would mean the attack never reached
 * the check, and the suite says so.
 */
const LOOKUP_REFUSAL = /not found|(do|does) not belong to this shop|belongs to another shop|must be APPROVED to publish|does not match a line of the purchase order/i;

interface Secrets {
  ids: Set<string>;
  strings: string[];
}

describe('cross-shop isolation: two shops, every route, job, report and file', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let A: SeededShop;
  let B: SeededShop;
  let handlers: Handler[];
  const deliveries: WebhookPostRequest[] = [];
  const sockets: Socket[] = [];

  const resolver = async () => [{ address: PUBLIC_IP, family: 4 as const }];
  const webhookHttp = { post: async (req: WebhookPostRequest) => (deliveries.push(req), { status: 200 }) };

  const secretsOf = async (S: SeededShop): Promise<Secrets> => {
    const all = await shopIds(prisma, S.shop.shopId, 0);
    const people = [
      ...(await shopStrings(prisma, S.shop.shopId, 'Customer', ['phone', 'email'])),
      ...(await shopStrings(prisma, S.shop.shopId, 'Supplier', ['phone'])),
      ...(await shopStrings(prisma, S.shop.shopId, 'User', ['email'])),
    ];
    return { ids: new Set([S.shop.shopId, ...[...all.values()].flat()]), strings: [S.marker, S.shop.suffix, ...people] };
  };

  /** Victim ids, names, phones or emails in an answer that the request itself did not carry. */
  const leaksIn = (probe: Pick<Probe, 'url' | 'body' | 'text'>, secrets: Secrets): string[] => {
    const sent = `${probe.url} ${JSON.stringify(probe.body ?? '')}`;
    const found = new Set<string>();
    for (const token of probe.text.match(/[A-Za-z0-9_-]{8,}/g) ?? []) if (secrets.ids.has(token) && !sent.includes(token)) found.add(token);
    for (const s of secrets.strings) if (probe.text.includes(s) && !sent.includes(s)) found.add(s);
    return [...found];
  };

  /** Every file of the shop's document store and of its media rows, with a checksum. */
  const fileTree = async (S: SeededShop): Promise<Record<string, string>> => {
    const tree: Record<string, string> = {};
    const walk = async (dir: string, rel: string) => {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, `${rel}/${e.name}`);
        else tree[`${rel}/${e.name}`] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
      }
    };
    await walk(app.get(StoragePathBuilder).getShopRoot(S.shop.shopId), 'storage');
    const media = await prisma.$queryRawUnsafe<Array<{ path: string }>>(
      'SELECT s.`path` AS path FROM `MediaStorage` s JOIN `MediaAsset` a ON a.`id` = s.`assetId` WHERE a.`shopId` = ?',
      S.shop.shopId,
    );
    for (const m of media) {
      const full = path.join(process.cwd(), 'uploads', m.path);
      tree[`media/${m.path}`] = await fs.readFile(full).then((b) => createHash('sha256').update(b).digest('hex'), () => 'missing');
    }
    return tree;
  };

  /** The id the product event log gives one of the shop's events (what `POST /events/replay` names). */
  const productEventId = async (S: SeededShop) =>
    (await prisma.$queryRawUnsafe<Array<{ eventId: string }>>('SELECT `eventId` FROM `ProductEventLog` WHERE `shopId` = ? ORDER BY `eventId` LIMIT 1', S.shop.shopId))[0].eventId;

  /** A query outside any request: as the system tenant (Prisma promises are lazy, so it is awaited inside). */
  const system = <T>(fn: () => Promise<T>) => tenantRunner(app).system(fn);
  /** A job for one shop, in the context the nightly sweep gives it. */
  const asJob = <T>(shopId: string, fn: () => Promise<T>) => app.get(TenantContextService).runWithContext(jobContext(shopId, 'cross-shop-spec'), async () => await fn());

  /** Runs `relay` until no PENDING row of the two shops is left for it, then waits for the workers to settle every row. */
  const settleOutbox = async () => {
    const relays = [() => app.get(OutboxProcessorWorker).processOutbox(), () => app.get(PurchaseOutboxRelayCron).relayPendingEvents(), () => app.get(OutboxRelayService).relayEvents()];
    const open = async () =>
      Number(
        (
          await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            "SELECT COUNT(*) AS n FROM `OutboxEvent` WHERE `shopId` IN (?, ?) AND `status` IN ('PENDING', 'CLAIMED', 'PROCESSING') AND (`nextAttemptAt` IS NULL OR `nextAttemptAt` <= ?)",
            A.shop.shopId,
            B.shop.shopId,
            new Date(),
          )
        )[0].n,
      );
    for (let i = 0; i < 300 && (await open()) > 0; i++) {
      for (const relay of relays) await relay();
      await new Promise((r) => setTimeout(r, 100));
    }
    // Then every queue's runnable jobs (thumbnails, imports, deliveries, notifications) until none is left.
    const queues = queueInstances(app.get(ModulesContainer)).queues.filter((q): q is Queue => q instanceof Queue);
    for (let i = 0; i < 200; i++) {
      const counts = await Promise.all(queues.map((q) => q.getJobCounts('active', 'waiting', 'prioritized')));
      if (counts.every((c) => (c.active ?? 0) + (c.waiting ?? 0) + (c.prioritized ?? 0) === 0)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    app = await bootApp(
      (b) => b.overrideProvider(OUTBOUND_RESOLVER).useValue(resolver).overrideProvider(WebhookHttpClient).useValue(webhookHttp),
      (a) => a.useWebSocketAdapter(new AuthenticatedIoAdapter(a)),
    );
    await app.listen(0);
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    A = await seedShop(app, 'xa', 2);
    B = await seedShop(app, 'xb', 3);
    await settleOutbox();
    for (const S of [A, B]) await asJob(S.shop.shopId, () => app.get(AnalyticsJobScheduler).runForShop(S.shop.shopId));
    handlers = enumerateHandlers(app);
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
  });

  it('seeds both shops with rows in over 90 models and gives the attack a valid body for every write', async () => {
    for (const S of [A, B]) expect((await shopIds(prisma, S.shop.shopId, 1)).size).toBeGreaterThan(90);
    expect(invalidBodies(handlers)).toEqual([]);
    for (const key of Object.keys({ ...NOT_A_ROW_READ, ...UNIFORM_NO_OP, ...NO_OWN_CONTROL, ...NOT_ATTACKED })) expect(handlers.map((h) => h.key)).toContain(key);
  });

  describe('reports: each shop sees exactly its own figures', () => {
    const summaryOf = async (S: SeededShop) => {
      const res = await client(app, S.tokens.owner).call('get', '/api/dashboard/summary');
      expect(res.status).toBe(200);
      return res.body as Record<string, unknown> & { businessDate: string };
    };

    it("dashboard summary: today's sales, returns, orders, customers and udhar are the shop's own", async () => {
      // A sold 2 units for cash (200) and 2 on credit (100), returned 1 (100), cancelled one sale; B sold 3 (300) + 100 on credit.
      for (const [S, gross] of [[A, 300], [B, 400]] as const) {
        const summary = await summaryOf(S);
        expect(summary.failedSections).toEqual([]);
        expect({ gross: Number(summary.todayGrossSales), returns: Number(summary.todayReturns), net: Number(summary.todaySales), orders: summary.todayOrders, returnCount: summary.todayReturnCount }).toEqual({
          gross,
          returns: 100,
          net: gross - 100,
          orders: 2,
          returnCount: 1,
        });
        expect(summary.totalCustomers).toBe(2);
        expect(Number(summary.outstandingUdhar)).toBe(60);
        const recent = (summary.recentInvoices as Array<{ id: string }>).map((i) => i.id);
        expect(recent.sort()).toEqual([S.ids.invoice, S.ids.creditInvoice, S.ids.cancelledInvoice, S.ids.returnInvoice].sort());
      }
    });

    it('exports, KPIs, analytics and insights carry the shop’s own documents and figures only', async () => {
      for (const [S, other] of [[A, B], [B, A]] as const) {
        const owner = client(app, S.tokens.owner);
        const { businessDate } = await summaryOf(S);
        const secrets = await secretsOf(other);
        const range = `from=${businessDate}&to=${businessDate}`;
        const invoices = await owner.call('get', `/api/dashboard/export/invoices.csv?${range}`);
        expect(invoices.status).toBe(200);
        // The shop's own four documents of the day (two sales, the cancelled one, the return), named after its own customer.
        expect(invoices.text.trim().split('\n')).toHaveLength(5);
        expect(invoices.text).toContain(`Cust ${S.marker}`);
        for (const url of [`/api/dashboard/export/invoices.csv?${range}`, `/api/dashboard/export/invoice-items.csv?${range}`, `/api/dashboard/export/gst-summary.csv?${range}`, '/api/dashboard/kpis', '/api/dashboard/analytics', '/api/dashboard/insights', '/api/dashboard/trends', '/api/dashboard/products', '/api/dashboard/low-stock', '/api/dashboard/forecast', '/api/purchase-analytics/dashboard', '/api/suppliers/summary', '/api/expenses/summary']) {
          const res = await owner.call('get', url);
          expect([url, res.status]).toEqual([url, 200]);
          expect([url, leaksIn({ url, text: res.text }, secrets)]).toEqual([url, []]);
        }
      }
    });

    it('reconciliation of the business day is CLEAN for each shop on its own books', async () => {
      for (const S of [A, B]) {
        const run = await client(app, S.tokens.owner).must('post', '/api/reconciliation/run', {});
        expect([S.shop.suffix, run.status]).toEqual([S.shop.suffix, 'CLEAN']);
      }
    });

    it("the dashboard cache is per shop: a sale in one shop moves only that shop's figures", async () => {
      const before = { a: await summaryOf(A), b: await summaryOf(B) };
      const sale = await client(app, B.tokens.owner).must('post', '/api/billing/invoice', { idempotencyKey: randomUUID(), items: [{ productId: B.ids.product, quantity: 1 }], payments: [{ tender: 'CASH', amount: 100 }] });
      expect(sale.invoice).toBeDefined();
      const after = { a: await summaryOf(A), b: await summaryOf(B) };
      expect(Number(after.a.todayGrossSales)).toBe(Number(before.a.todayGrossSales));
      expect(Number(after.b.todayGrossSales)).toBe(Number(before.b.todayGrossSales) + 100);
    });
  });

  describe.each([
    ['A attacks B', () => A, () => B],
    ['B attacks A', () => B, () => A],
  ])('%s through every route', (direction, attackerOf, victimOf) => {
    let X: SeededShop;
    let Y: SeededShop;
    let probes: Probe[];
    let before: ShopFingerprint;
    let after: ShopFingerprint;
    let filesBefore: Record<string, string>;
    let filesAfter: Record<string, string>;
    let secrets: Secrets;

    const show = (p: Probe) => `${p.phase} ${p.route} [${p.target} <- ${p.sent}] ${p.url} -> ${p.status} ${p.text.slice(0, 160)}`;

    beforeAll(async () => {
      X = attackerOf();
      Y = victimOf();
      await settleOutbox();
      secrets = await secretsOf(Y);
      const victim = await shopIds(prisma, Y.shop.shopId, 3);
      const own = await shopIds(prisma, X.shop.shopId, 3);
      before = await shopFingerprint(prisma, Y.shop.shopId);
      filesBefore = await fileTree(Y);
      const victimSkus = (await shopStrings(prisma, Y.shop.shopId, 'Product', ['sku', 'barcode'])).slice(0, 4);
      const [ownBarcode] = await shopStrings(prisma, X.shop.shopId, 'Product', ['barcode']);
      // Product identity routes read the barcode registry; search reads the product's own barcode column.
      const ownCode = (h: Handler) => (h.path.includes('product-identity') ? X.ids.barcode : ownBarcode);
      // The attacker's own documents in the state each route acts on, so the request gets as far as its ownership check.
      const ownFor: Record<string, Record<string, string>> = {
        // A product and a variant of that very product, wherever a body names both.
        '*': { productId: X.ids.product3, variantId: X.ids.variant },
        'POST /api/media/order': { variantId: X.ids.variant, referenceId: X.ids.variantMediaReference },
        'POST /api/events/replay': { eventId: await productEventId(X) },
        'POST /api/grn': { purchaseOrderId: X.ids.purchaseOrder3, purchaseOrderItemId: X.ids.purchaseOrder3Item, productId: X.ids.product, variantId: '', supplierId: X.ids.supplier, warehouseId: X.ids.warehouse },
        'POST /api/grn/:id/receive': { ':id': X.ids.goodsReceipt2, id: X.ids.goodsReceipt2Line, productId: X.ids.product },
        'POST /api/grn/:id/inspect': { ':id': X.ids.goodsReceipt3, id: X.ids.goodsReceipt3Line },
        'PUT /api/purchases/:id/draft': { ':id': X.ids.purchaseOrder4, supplierId: X.ids.supplier, productId: X.ids.product },
        'POST /api/purchases': { supplierId: X.ids.supplier, productId: X.ids.product },
        'POST /api/inventory-domain/transfer': { fromLocationId: X.ids.saleLocation, toLocationId: X.ids.rack },
        'POST /api/products/:productId/revisions/:revId/approve': { ':productId': X.ids.product, ':revId': X.ids.revision },
        'POST /api/products/:productId/revisions/:revId/publish': { ':productId': X.ids.product2, ':revId': X.ids.revision2 },
        'POST /api/products/:productId/revisions/:revId/submit': { ':productId': X.ids.product3, ':revId': X.ids.revision3 },
        'PATCH /api/products/:productId/revisions/:revId': { ':productId': X.ids.product3, ':revId': X.ids.revision3 },
        'POST /api/billing/returns': { invoiceId: X.ids.invoice, invoiceItemId: X.ids.invoiceItem },
      };
      const extraBodies = {
        'POST /api/media/order': [() => ({ productId: X.ids.product, referenceIds: [X.ids.productMediaReference] })],
        // A sale that pays exactly (a custom line of 10), so the customer and the drawer are looked up.
        'POST /api/billing/invoice': [
          () => ({ idempotencyKey: randomUUID(), items: [{ custom: { name: 'Iso line', unitPrice: 10, gstRate: 'ZERO' }, quantity: 1 }], payments: [{ tender: 'CASH', amount: 10 }], customerId: X.shop.customerId, shiftId: X.ids.shift }),
        ],
        'POST /api/shops/transfer-ownership': [() => ({ newOwnerId: X.users.admin.id, currentPassword: OWNER_PASSWORD })],
      };
      const victimFor = { 'POST /api/events/replay': { eventId: [await productEventId(Y)] } };
      probes = await runAttack({ app, handlers, token: X.tokens.owner, own, victim, victimCodes: [Y.ids.barcode, ...victimSkus], ownCode, ownFor, extraBodies, victimFor });
      await settleOutbox();
      after = await shopFingerprint(prisma, Y.shop.shopId);
      if (process.env.ISOLATION_REPORT_DIR) {
        await fs.mkdir(process.env.ISOLATION_REPORT_DIR, { recursive: true });
        const name = `${direction.replace(/\W+/g, '-').toLowerCase()}.json`;
        await fs.writeFile(path.join(process.env.ISOLATION_REPORT_DIR, name), JSON.stringify(probes.map(({ text, ...p }) => ({ ...p, text: text.slice(0, 300) })), null, 1));
      }
      filesAfter = await fileTree(Y);
    });

    it('covers every route that takes a shop context, with a foreign id in every place it takes one', () => {
      const sent = new Set(probes.map((p) => p.route));
      const missing = handlers.filter((h) => !h.isPublic && !(h.key in NOT_ATTACKED) && !sent.has(h.key)).map((h) => h.key);
      expect(missing).toEqual([]);
      expect(probes.filter((p) => p.sent !== 'random' && p.sent !== 'own' && p.sent !== 'none').length).toBeGreaterThan(3000);
    });

    it('never answers 500 (an unhandled error) to any probe', () => {
      expect(probes.filter((p) => p.status === 500 || p.status === 0).map(show)).toEqual([]);
    });

    it("never answers 2xx for a victim's row in a path parameter (reads and writes)", () => {
      const leaks = probes
        .filter((p) => (p.phase === 'read' || p.phase === 'write-path') && p.target.startsWith(':') && !['random', 'own'].includes(p.sent))
        .filter((p) => p.status < 300 && !(p.route in NOT_A_ROW_READ) && !(p.route in UNIFORM_NO_OP))
        .map(show);
      expect(leaks).toEqual([]);
    });

    it("never accepts a write that names a victim's row in its body", () => {
      const accepted = probes.filter((p) => p.phase === 'write-body' && !['random', 'own'].includes(p.sent) && p.status < 300).map(show);
      expect(accepted).toEqual([]);
    });

    it('reaches the ownership check on every write: each victim id is refused by the lookup of that very field', () => {
      const refusedByLookup = (p: Probe) => p.status === 404 || ([400, 409].includes(p.status) && LOOKUP_REFUSAL.test(p.text));
      // Path parameters: every victim id refused by a lookup.
      const paths = new Map<string, Probe[]>();
      for (const p of probes.filter((q) => q.phase === 'write-path' && !['random', 'own'].includes(q.sent) && !(q.route in UNIFORM_NO_OP))) {
        const key = `${p.route} ${p.target}`;
        paths.set(key, [...(paths.get(key) ?? []), p]);
      }
      const unreachedPaths = [...paths.entries()].filter(([, ps]) => !ps.every(refusedByLookup)).map(([k, ps]) => `${k}: ${ps[0].status} ${ps[0].text.slice(0, 100)}`);
      // Body fields: in at least one body of the route, every victim id refused by a lookup while the same body
      // with the attacker's own id there passes every lookup (its control), so the refusal is the attacked field's.
      const controls = new Map(probes.filter((p) => p.phase === 'write-body' && p.target.startsWith('control')).map((p) => [`${p.route} ${p.target.replace('control ', '')}`, p]));
      const bodies = new Map<string, Probe[]>();
      for (const p of probes.filter((q) => q.phase === 'write-body' && !['random', 'own'].includes(q.sent))) {
        const key = `${p.route} ${p.target}`;
        bodies.set(key, [...(bodies.get(key) ?? []), p]);
      }
      const fields = new Map<string, string[]>();
      for (const [key, ps] of bodies) {
        const route = ps[0].route;
        const body = /\(body (\d+)\)$/.exec(ps[0].target)?.[1] ?? '1';
        const field = `${route} ${ps[0].target.replace(/ \(body \d+\)$/, '')}`;
        const control = controls.get(`${route} (body ${body})`);
        const problem = !ps.every(refusedByLookup)
          ? `victim id: ${ps.find((p) => !refusedByLookup(p))!.status} ${ps.find((p) => !refusedByLookup(p))!.text.slice(0, 100)}`
          : control && refusedByLookup(control)
            ? `body ${body} is refused with the attacker's own ids too: ${control.status} ${control.text.slice(0, 100)}`
            : null;
        fields.set(field, [...(fields.get(field) ?? []), ...(problem ? [problem] : ['ok'])]);
        void key;
      }
      const unreachedFields = [...fields.entries()].filter(([field, results]) => !results.includes('ok') && !(field.split(' ').slice(0, 2).join(' ') in NO_CONTROL)).map(([field, results]) => `${field}: ${results.join(' / ')}`);
      expect([...unreachedPaths, ...unreachedFields]).toEqual([]);
      expect(paths.size + fields.size).toBeGreaterThan(150);
    });

    it('answers a victim id exactly as an id nobody has (no existence oracle)', () => {
      const baseline = new Map(probes.filter((p) => p.sent === 'random').map((p) => [`${p.phase} ${p.route} ${p.target}`, p]));
      const oracles = probes
        .filter((p) => p.target && !['random', 'own', 'none'].includes(p.sent) && p.phase !== 'read-query')
        .filter((p) => {
          const b = baseline.get(`${p.phase} ${p.route} ${p.target}`);
          return b && (b.status !== p.status || b.code !== p.code) && !(p.route in NOT_A_ROW_READ);
        })
        .map((p) => {
          const b = baseline.get(`${p.phase} ${p.route} ${p.target}`)!;
          return `${show(p)}  (random id: ${b.status} ${b.code ?? ''})`;
        });
      expect(oracles).toEqual([]);
    });

    it("answers the attacker's own row with 2xx on every single-row read (the routes work; the refusals are about the shop)", () => {
      const controls = probes.filter((p) => p.phase === 'read' && p.sent === 'own' && modelsOfPath(p.route.split(' ')[1]).length === 1);
      const failed = controls.filter((p) => p.status >= 300 && !(p.route in NO_OWN_CONTROL) && !(p.route in NOT_A_ROW_READ)).map(show);
      expect(failed).toEqual([]);
      expect(controls.length).toBeGreaterThan(30);
    });

    it("leaves the victim's data byte-for-byte unchanged: every column of every row it owns, child tables included", () => {
      expect(Object.keys(before).length).toBeGreaterThan(90);
      expect(fingerprintDiff(before, after)).toEqual([]);
    });

    it("leaves the victim's stored documents and media files unchanged", () => {
      expect(Object.keys(filesBefore).length).toBeGreaterThan(3);
      expect(filesAfter).toEqual(filesBefore);
    });

    it("no answer of any status carries a victim id, name, phone or email the request did not send", () => {
      const leaks = probes.map((p) => ({ p, found: leaksIn(p, secrets) })).filter((r) => r.found.length > 0).map((r) => `${show(r.p)} LEAKS ${r.found.join(', ')}`);
      expect(leaks).toEqual([]);
    });

    it('no row of either shop names a row of the other', async () => {
      const audit = await auditCrossShopReferences(prisma, { shops: [A.shop.shopId, B.shop.shopId] });
      expect(audit.checked).toBeGreaterThan(150);
      expect(audit.findings).toEqual([]);
    });
  });

  describe('background jobs, files and channels', () => {
    const victimUnchanged = async (S: SeededShop, act: () => Promise<void>) => {
      await settleOutbox();
      const fp = await shopFingerprint(prisma, S.shop.shopId);
      await act();
      await settleOutbox();
      expect(fingerprintDiff(fp, await shopFingerprint(prisma, S.shop.shopId))).toEqual([]);
    };

    it("sweeps: one shop's expiry sweeps never touch the other shop's expired reservations or batches", async () => {
      await system(() => prisma.stockReservation.update({ where: { id: B.ids.reservation }, data: { expiresAt: new Date(Date.now() - 60_000) } }));
      await system(() => prisma.batch.update({ where: { id: B.ids.batch }, data: { expiryDate: new Date(Date.now() - 86_400_000) } }));
      await victimUnchanged(B, async () => {
        await client(app, A.tokens.owner).must('post', '/api/reservations/sweep', {});
        await client(app, A.tokens.owner).must('post', '/api/batches/sweep-expiry', {});
      });
      // The same sweeps run by B do act on B's rows.
      await client(app, B.tokens.owner).must('post', '/api/reservations/sweep', {});
      expect((await system(() => prisma.stockReservation.findUniqueOrThrow({ where: { id: B.ids.reservation } }))).status).not.toBe('ACTIVE');
    });

    it("nightly analytics and reconciliation for one shop leave the other's rows alone and reference only its own", async () => {
      await victimUnchanged(B, async () => {
        await asJob(A.shop.shopId, () => app.get(AnalyticsJobScheduler).runForShop(A.shop.shopId));
        await client(app, A.tokens.owner).must('post', '/api/reconciliation/run', {});
      });
      expect(await system(() => prisma.inventoryKpi.count({ where: { shopId: A.shop.shopId } }))).toBeGreaterThan(0);
      expect((await auditCrossShopReferences(prisma, { shops: [A.shop.shopId, B.shop.shopId] })).findings).toEqual([]);
    });

    it("webhooks: every delivery goes to an endpoint of the event's shop and carries nothing of the other shop", async () => {
      await client(app, A.tokens.owner).must('patch', `/api/products/${A.ids.product}`, { name: `Renamed ${A.marker}` });
      await client(app, B.tokens.owner).must('patch', `/api/products/${B.ids.product}`, { name: `Renamed ${B.marker}` });
      await settleOutbox();
      const to = (label: string) => deliveries.filter((d) => d.target.url.hostname === `hooks-${label}.example.test`);
      expect(to('xa').length).toBeGreaterThan(0);
      expect(to('xb').length).toBeGreaterThan(0);
      const [secretsA, secretsB] = [await secretsOf(A), await secretsOf(B)];
      for (const [label, other] of [['xa', secretsB], ['xb', secretsA]] as const) {
        const leaks = to(label)
          .filter((d) => leaksIn({ url: d.target.url.href, text: d.body }, other).length > 0)
          .map((d) => d.body.slice(0, 200));
        expect(leaks).toEqual([]);
      }
      expect(to('xa').some((d) => d.body.includes(A.ids.product))).toBe(true);
    });

    it('sockets: a stock change in one shop reaches that shop only, whatever the other socket asks for', async () => {
      const connect = (token: string) =>
        new Promise<Socket>((resolve, reject) => {
          const socket = io(`${baseUrl}/inventory`, { transports: ['websocket'], auth: { token }, reconnection: false, timeout: 5_000 });
          sockets.push(socket);
          socket.on('connect', () => resolve(socket));
          socket.on('connect_error', reject);
        });
      const socketA = await connect(A.tokens.owner);
      const socketB = await connect(B.tokens.owner);
      const gotA: unknown[] = [];
      const gotB: unknown[] = [];
      socketA.onAny((event, payload) => gotA.push({ event, payload }));
      socketB.onAny((event, payload) => gotB.push({ event, payload }));
      // The attacker asks to be put in the other shop's room; there is no handler that joins rooms on request.
      socketA.emit('join', `tenant:${B.shop.shopId}`);
      socketA.emit('subscribe', { room: `tenant:${B.shop.shopId}`, shopId: B.shop.shopId });
      await client(app, B.tokens.owner).must('post', '/api/billing/invoice', { idempotencyKey: randomUUID(), items: [{ productId: B.ids.product, quantity: 1 }], payments: [{ tender: 'CASH', amount: 100 }] });
      await new Promise((r) => setTimeout(r, 750));
      expect(JSON.stringify(gotB)).toContain(B.ids.product);
      expect(gotA).toEqual([]);
    });

    it("storage backup: a shop's archive holds its own documents and nothing of the other shop", async () => {
      const backup = await client(app, A.tokens.owner).must('post', '/api/storage/backup', { type: 'Daily' });
      const relative = String(backup.path);
      expect(relative).toMatch(/^Backups\/Daily\/backup_.*\.zip$/);
      // A zip stores its entry names uncompressed (local headers and the central directory), so the names are searchable in the bytes.
      const zip = (await fs.readFile(path.join(app.get(StoragePathBuilder).getShopRoot(A.shop.shopId), relative))).toString('latin1');
      expect(zip).toContain(A.shop.customerId);
      for (const foreign of [B.shop.shopId, B.shop.customerId, B.ids.customer2]) expect(zip).not.toContain(foreign);
    });

    it("search, suggestions and popular searches never show the other shop's products or queries", async () => {
      const secrets = await secretsOf(B);
      const owner = client(app, A.tokens.owner);
      // Popular searches first: B searched for its own marker while seeding; A has not (yet).
      for (const url of ['/api/search/popular', `/api/search?q=${B.marker}`, `/api/search/suggestions?q=${B.marker.slice(0, 6)}`, `/api/products?q=${B.marker}`, `/api/search/barcode/${B.ids.barcode}`]) {
        const res = await owner.call('get', url);
        expect([url, res.status < 500]).toEqual([url, true]);
        expect([url, leaksIn({ url, text: res.text }, secrets)]).toEqual([url, []]);
      }
    });

    // Last: it gives the importing shop rows that carry the other shop's SKU and phone on purpose.
    it("imports: another shop's SKU, barcode and phone create rows in the importing shop only, and its report shows nothing of the other", async () => {
      const owner = client(app, A.tokens.owner);
      const bProduct = await system(() => prisma.product.findUniqueOrThrow({ where: { id: B.ids.product2 } }));
      const bCustomer = await system(() => prisma.customer.findUniqueOrThrow({ where: { id: B.shop.customerId } }));
      const upload = (kind: string, csv: string) =>
        owner.call('post', `/api/imports/${kind}/upload`).field('mode', 'UPSERT').attach('file', Buffer.from(csv), { filename: `${kind}.csv`, contentType: 'text/csv' });
      const finished = async (jobId: string) => {
        for (let i = 0; i < 300; i++) {
          const res = await owner.call('get', `/api/imports/jobs/${jobId}`);
          if (!['PENDING', 'PROCESSING'].includes(res.body.status)) return res.body as { status: string };
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`import ${jobId} did not finish`);
      };
      const secrets = await secretsOf(B);
      await victimUnchanged(B, async () => {
        const jobs = [
          await upload('products', `sku,name,sellingPrice,costPrice,barcode\n${bProduct.sku},Mine ${A.marker},20,10,${bProduct.barcode}\n`),
          await upload('customers', `name,phone,openingBalance\nMine ${A.marker},${bCustomer.phone},25\n`),
          await upload('opening-stock', `sku,quantity\n${bProduct.sku},7\n`),
        ];
        for (const job of jobs) {
          expect(job.status).toBe(201);
          await finished(job.body.jobId);
          for (const sub of ['', '/rows', '/errors', '/report']) {
            const url = `/api/imports/jobs/${job.body.jobId}${sub}`;
            const res = await owner.call('get', url);
            expect([url, res.status]).toEqual([url, 200]);
            expect([url, leaksIn({ url, text: res.text }, { ids: secrets.ids, strings: [B.marker] })]).toEqual([url, []]);
          }
        }
      });
      // The SKU and phone of B are free to use in A: they created A's own rows.
      expect(await system(() => prisma.product.count({ where: { shopId: A.shop.shopId, sku: bProduct.sku } }))).toBe(1);
      expect(await system(() => prisma.customer.count({ where: { shopId: A.shop.shopId, phone: bCustomer.phone } }))).toBe(1);
      expect((await auditCrossShopReferences(prisma, { shops: [A.shop.shopId, B.shop.shopId] })).findings).toEqual([]);
    });

    it('the audit sees a cross-shop row when one exists (planted, then removed)', async () => {
      const planted = await tenantRunner(app).system(() => prisma.batch.create({ data: { shopId: A.shop.shopId, productId: B.ids.product, batchNumber: `PLANT-${A.shop.suffix}`, type: 'PURCHASE' } }));
      try {
        const audit = await auditCrossShopReferences(prisma, { shops: [A.shop.shopId] });
        expect(audit.findings).toEqual([expect.objectContaining({ model: 'Batch', target: 'Product', rows: 1 })]);
        expect(JSON.stringify(audit.findings[0].sample)).toContain(planted.id);
      } finally {
        await tenantRunner(app).system(() => prisma.batch.delete({ where: { id: planted.id } }));
      }
      expect((await auditCrossShopReferences(prisma, { shops: [A.shop.shopId, B.shop.shopId] })).findings).toEqual([]);
    });
  });

  describe('the gaps this audit closed (regression)', () => {
    it("purchase event replay: another shop's document answers 404 like an id of nothing; the shop's own is accepted", async () => {
      const owner = client(app, A.tokens.owner);
      for (const aggregateId of [B.ids.purchaseOrder, `c${randomUUID().replace(/-/g, '').slice(0, 24)}`]) {
        const res = await owner.call('post', '/api/purchase-events/replay').send({ aggregateId });
        expect([res.status, res.body.code]).toEqual([404, 'PURCHASE_AGGREGATE_NOT_FOUND']);
      }
      expect((await owner.call('post', '/api/purchase-events/replay').send({ aggregateId: A.ids.purchaseOrder })).status).toBe(201);
      const replays = await prisma.$queryRawUnsafe<Array<{ targetAggregateId: string }>>('SELECT `targetAggregateId` FROM `PurchaseEventReplay` WHERE `shopId` = ?', A.shop.shopId);
      expect(replays.map((r) => r.targetAggregateId)).not.toContain(B.ids.purchaseOrder);
    });

    it("ownership transfer: another shop's user answers exactly like an unknown id (no existence oracle) and nothing moves", async () => {
      const owner = client(app, A.tokens.owner);
      const answers = [];
      for (const newOwnerId of [B.users.admin.id, `c${randomUUID().replace(/-/g, '').slice(0, 24)}`]) {
        const res = await owner.call('post', '/api/shops/transfer-ownership').send({ newOwnerId, currentPassword: OWNER_PASSWORD });
        answers.push([res.status, res.body.code]);
      }
      expect(answers).toEqual([
        [404, 'USER_NOT_FOUND'],
        [404, 'USER_NOT_FOUND'],
      ]);
      const [shop] = await prisma.$queryRawUnsafe<Array<{ ownerId: string }>>('SELECT `ownerId` FROM `Shop` WHERE `id` = ?', A.shop.shopId);
      expect(shop.ownerId).toBe(A.shop.ownerId);
    });

    it("warehouse subtree: another shop's warehouse is a 404, not an empty page", async () => {
      const owner = client(app, A.tokens.owner);
      expect((await owner.call('get', `/api/warehouse-domain/warehouses/${B.ids.warehouse}/locations/subtree?path=/`)).status).toBe(404);
      const own = await owner.call('get', `/api/warehouse-domain/warehouses/${A.ids.warehouse}/locations/subtree?path=/${A.ids.warehouse}`);
      expect(own.status).toBe(200);
      expect((own.body as Array<{ id: string }>).map((l) => l.id)).toEqual(expect.arrayContaining([A.ids.zone, A.ids.rack]));
    });

    it("draft order: the supplier can be changed to another of the shop's own, never to another shop's", async () => {
      const owner = client(app, A.tokens.owner);
      const foreign = await owner.call('put', `/api/purchases/${A.ids.purchaseOrder4}/draft`).send({ supplierId: B.ids.supplier });
      expect([foreign.status, foreign.body.code]).toEqual([404, 'SUPPLIER_NOT_FOUND']);
      const second = await owner.must('post', '/api/suppliers', { name: `Second supplier ${A.marker}`, phone: `8${A.shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '4')}` });
      const moved = await owner.call('put', `/api/purchases/${A.ids.purchaseOrder4}/draft`).send({ supplierId: second.id });
      expect([moved.status, moved.body.supplierId]).toEqual([200, second.id]);
    });
  });

  it('the in-process server answered every probe (no transport errors)', async () => {
    const res = await request(httpTarget(app)).get('/api/health');
    expect(res.status).toBe(200);
  });
});
