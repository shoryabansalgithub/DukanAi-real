/**
 * Roadmap 9.20 over HTTP: a shop's first day. Products (with categories),
 * opening stock and customers with their opening udhar are imported from
 * CSV, each first as a dry run (a report, nothing written) and then for
 * real; a re-run of the same file is all unchanged; opening stock and
 * opening udhar post against OPENING_BALANCE_EQUITY; the business day then
 * reconciles CLEAN. Also: who may import, tenant isolation of the jobs and
 * reports, the templates, and a job whose user lost the right to import.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ImportKind, LedgerAccount, Role } from '@prisma/client';
import { Queue } from 'bullmq';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { templateCsv } from '../../src/import-export/import-columns';
import { openingStockKey } from '../../src/inventory-domain/services/inventory-domain.service';
import { openingBalanceKey } from '../../src/customers/customers.service';
import { bootApp, createShop, httpTarget, num, tenantRunner, TestShop } from './pos-fixtures';
import { bearerToken, cashierOf, createUser, httpAs, ownerOf, TestUser } from '../security/security-fixtures';

jest.setTimeout(300_000);

type Http = Awaited<ReturnType<typeof httpAs>>;
type Kind = 'products' | 'customers' | 'opening-stock';

interface JobBody {
  id: string;
  status: string;
  dryRun: boolean;
  totalRows: number;
  validRows: number;
  errorRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
}

interface ReportRow {
  rowNumber: number;
  status: string;
  actionTaken: string | null;
  changes: string[] | null;
  errors: Array<{ field?: string; message: string; severity: string }> | null;
}

const counts = (job: JobBody) => ({ total: job.totalRows, valid: job.validRows, errors: job.errorRows, created: job.createdCount, updated: job.updatedCount, unchanged: job.unchangedCount, skipped: job.skippedCount });

describe('Onboarding imports (roadmap 9.20)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let owner: Http;
  let ownerToken: string;
  let manager: TestUser;
  let managerToken: string;

  const products = () =>
    [
      'Item Code,Product Name,Category,Barcode,HSN,Unit,GST %,Cost Price,Selling Price,MRP,Reorder Level,Colour',
      `P1-${A.suffix},Basmati Rice 5 kg,Rice & Grains,8901234567890,10063020,PCS,5,560,599,650,5,white`,
      `P2-${A.suffix},Toor Dal loose,Pulses,,0713,kg,5%,120.50,135,140,,`,
      `P3-${A.suffix},Lux Soap 100 g,Personal Care,8901030712345,34011110,Nos,18,28.50,32,35,24,`,
      `P4-${A.suffix},Above its MRP,,,,,18,10,20,15,,`,
      `,No SKU,,,,,5,1,2,2,,`,
      `P1-${A.suffix},Same SKU again,,,,,5,1,2,2,,`,
      `P6-${A.suffix},Nothing on the shelf,Personal Care,,,PCS,12,10,12,12,,`,
    ].join('\n');

  const upload = (kind: Kind, csv: string, fields: Record<string, string> = {}, token = ownerToken) => {
    let req = request(httpTarget(app)).post(`/api/imports/${kind}/upload`).set('Authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach('file', Buffer.from(csv), { filename: `${kind}.csv`, contentType: 'text/csv' });
  };

  const finished = async (jobId: string): Promise<JobBody> => {
    for (let i = 0; i < 600; i++) {
      const res = await owner.get(`/api/imports/jobs/${jobId}`);
      expect(res.status).toBe(200);
      if (res.body.status !== 'PENDING' && res.body.status !== 'PROCESSING') return res.body as JobBody;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`import job ${jobId} did not finish`);
  };

  const runImport = async (kind: Kind, csv: string, fields: Record<string, string> = {}, token = ownerToken): Promise<JobBody> => {
    const res = await upload(kind, csv, fields, token);
    expect([res.status, res.body]).toEqual([201, expect.objectContaining({ jobId: expect.any(String) })]);
    return finished(res.body.jobId);
  };

  const reportOf = async (jobId: string): Promise<ReportRow[]> => {
    const res = await owner.get(`/api/imports/jobs/${jobId}/rows?take=200`);
    expect(res.status).toBe(200);
    return res.body as ReportRow[];
  };

  const balance = async (account: LedgerAccount) => num((await run.system(() => prisma.ledgerAccountBalance.findFirst({ where: { shopId: A.shopId, account } })))?.balance);
  const productBySku = (sku: string) => run.system(() => prisma.product.findFirstOrThrow({ where: { shopId: A.shopId, sku, isDeleted: false }, include: { category: true } }));

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'onb');
    owner = await httpAs(app, A, ownerOf(A));
    ownerToken = await bearerToken(app, A, ownerOf(A));
    manager = await createUser(app, A, Role.MANAGER);
    managerToken = await bearerToken(app, A, manager);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the three templates the docs commit', async () => {
    for (const [slug, kind] of [['products', ImportKind.PRODUCTS], ['customers', ImportKind.CUSTOMERS], ['opening-stock', ImportKind.OPENING_STOCK]] as const) {
      const res = await owner.get(`/api/imports/templates/${slug}`);
      expect([res.status, res.headers['content-type'], res.text]).toEqual([200, 'text/csv; charset=utf-8', templateCsv(kind)]);
    }
    expect((await owner.get('/api/imports/templates/suppliers')).status).toBe(404);
  });

  it('products: a dry run reports every row and writes nothing; applying it creates the valid rows; a re-run is unchanged', async () => {
    const dry = await runImport('products', products(), { dryRun: 'true' });
    expect(dry.dryRun).toBe(true);
    expect([dry.status, counts(dry)]).toEqual(['PARTIAL_SUCCESS', { total: 7, valid: 4, errors: 3, created: 4, updated: 0, unchanged: 0, skipped: 0 }]);
    expect(await run.system(() => prisma.product.count({ where: { shopId: A.shopId } }))).toBe(0);
    expect(await run.system(() => prisma.category.count({ where: { shopId: A.shopId } }))).toBe(0);
    const report = await reportOf(dry.id);
    expect(report.map((r) => [r.rowNumber, r.status, r.actionTaken])).toEqual([
      [0, 'SUCCESS', 'FILE'],
      [2, 'SUCCESS', 'WOULD_CREATE'],
      [3, 'SUCCESS', 'WOULD_CREATE'],
      [4, 'SUCCESS', 'WOULD_CREATE'],
      [5, 'ERROR', null],
      [6, 'ERROR', null],
      [7, 'ERROR', null],
      [8, 'SUCCESS', 'WOULD_CREATE'],
    ]);
    expect(report[0].errors).toEqual([{ message: 'Column not read: "Colour".', severity: 'warning' }]);
    expect(report[1].changes).toEqual([`new product P1-${A.suffix}`, 'category "Rice & Grains" (new)']);
    expect(report[4].errors).toEqual([expect.objectContaining({ field: 'mrp', severity: 'error' })]);
    expect(report[6].errors).toEqual([expect.objectContaining({ field: 'sku', message: 'Same SKU as row 2; a file names each one once.' })]);
    const csvReport = await owner.get(`/api/imports/jobs/${dry.id}/report`);
    expect(csvReport.status).toBe(200);
    expect(csvReport.headers['content-disposition']).toBe(`attachment; filename="import-products-${dry.id}-report.csv"`);
    expect(csvReport.text.split('\n')[0]).toBe('row,status,action,changes,problems,sku,name,category,barcode,hsnCode,unit,gstRate,cessRate,costPrice,sellingPrice,mrp,wholesalePrice,reorderPoint,type,description');

    const applied = await owner.post(`/api/imports/jobs/${dry.id}/apply`);
    expect(applied.status).toBe(201);
    const real = await finished(applied.body.jobId);
    expect([real.dryRun, real.status, counts(real)]).toEqual([false, 'PARTIAL_SUCCESS', { total: 7, valid: 4, errors: 3, created: 4, updated: 0, unchanged: 0, skipped: 0 }]);
    expect((await owner.post(`/api/imports/jobs/${real.id}/apply`)).body.code).toBe('IMPORT_NOT_A_DRY_RUN');

    const rice = await productBySku(`P1-${A.suffix}`);
    expect(rice).toEqual(expect.objectContaining({ name: 'Basmati Rice 5 kg', barcode: '8901234567890', hsnCode: '10063020', unit: 'PCS', gstRate: 'FIVE', createdBy: A.ownerId }));
    expect([num(rice.costPrice), num(rice.sellingPrice), num(rice.mrp), num(rice.wholesalePrice), num(rice.reorderPoint), rice.category?.name]).toEqual([560, 599, 650, 599, 5, 'Rice & Grains']);
    const dal = await productBySku(`P2-${A.suffix}`);
    expect([dal.unit, num(dal.costPrice), num(dal.mrp), num(dal.reorderPoint), dal.category?.name]).toEqual(['KG', 120.5, 140, 10, 'Pulses']);
    // The two Personal Care rows share one category, created once; no phantom variant per product.
    expect(await run.system(() => prisma.category.count({ where: { shopId: A.shopId } }))).toBe(3);
    expect(await run.system(() => prisma.productVariant.count({ where: { shopId: A.shopId } }))).toBe(0);

    const again = await runImport('products', products());
    expect(counts(again)).toEqual({ total: 7, valid: 4, errors: 3, created: 0, updated: 0, unchanged: 4, skipped: 0 });
  });

  it('products: an update changes only what the file gives, never sells above the stored MRP, and audits the price change', async () => {
    const csv = ['sku,sellingPrice,costPrice,name', `p1-${A.suffix},620,560,Basmati Rice 5 kg`, `P2-${A.suffix},150,120.50,Toor Dal loose`].join('\n');
    const job = await runImport('products', csv);
    expect(counts(job)).toEqual({ total: 2, valid: 1, errors: 1, created: 0, updated: 1, unchanged: 0, skipped: 0 });
    const report = await reportOf(job.id);
    expect(report[0].changes).toEqual(['sellingPrice 599.00 → 620.00']);
    expect(report[1].errors).toEqual([expect.objectContaining({ field: 'mrp', message: "The selling price 150.00 is above the product's MRP 140.00; give the MRP in the file." })]);
    const rice = await productBySku(`P1-${A.suffix}`);
    expect([num(rice.sellingPrice), num(rice.mrp), rice.barcode, rice.category?.name]).toEqual([620, 650, '8901234567890', 'Rice & Grains']);
    const audit = await run.system(() => prisma.auditLog.findFirst({ where: { shopId: A.shopId, action: 'PRODUCT_PRICE_CHANGED', entityId: rice.id } }));
    expect(audit?.userId).toBe(A.ownerId);
  });

  it('opening stock: recorded once per product at cost against OPENING_BALANCE_EQUITY; a re-run is unchanged and another quantity is refused', async () => {
    const csv = [
      'sku,barcode,quantity',
      `P1-${A.suffix},,40`,
      `,8901030712345,144`,
      `P2-${A.suffix},,12.5`,
      `P3-${A.suffix},,1`,
      `NOPE-${A.suffix},,5`,
      `P6-${A.suffix},,0`,
      `P1-${A.suffix},,1.5`,
    ].join('\n');
    const dry = await runImport('opening-stock', csv, { dryRun: 'true' });
    expect(counts(dry)).toEqual({ total: 7, valid: 4, errors: 3, created: 3, updated: 0, unchanged: 0, skipped: 1 });
    expect(await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: A.shopId } }))).toBe(0);

    const job = await runImport('opening-stock', csv);
    expect(counts(job)).toEqual({ total: 7, valid: 4, errors: 3, created: 3, updated: 0, unchanged: 0, skipped: 1 });
    const report = await reportOf(job.id);
    expect(report.map((r) => [r.rowNumber, r.status, r.actionTaken])).toEqual([
      [2, 'SUCCESS', 'CREATED'],
      [3, 'SUCCESS', 'CREATED'],
      [4, 'SUCCESS', 'CREATED'],
      [5, 'ERROR', null],
      [6, 'ERROR', null],
      [7, 'SKIPPED', 'SKIPPED'],
      [8, 'ERROR', null],
    ]);
    expect(report[3].errors?.at(-1)?.message).toBe('Same product as row 3; a file names each one once.');

    for (const [sku, quantity] of [[`P1-${A.suffix}`, 40], [`P3-${A.suffix}`, 144], [`P2-${A.suffix}`, 12.5]] as const) {
      const product = await productBySku(sku);
      const item = await run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: A.shopId, productId: product.id, locationId: A.saleLocationId, variantKey: '-' } }));
      const entries = await run.system(() => prisma.stockLedgerEntry.findMany({ where: { shopId: A.shopId, inventoryItemId: item.id } }));
      expect([sku, num(product.currentStock), num(item.onHand), entries.map((e) => [e.movementType, num(e.quantity), e.correlationId])]).toEqual([sku, quantity, quantity, [['OPENING_BALANCE', quantity, openingStockKey(item.id)]]]);
    }
    // 40 × 560 + 144 × 28.50 + 12.5 × 120.50
    expect(await balance(LedgerAccount.INVENTORY)).toBe(28010.25);
    expect(await balance(LedgerAccount.OPENING_BALANCE_EQUITY)).toBe(28010.25);
    expect(await balance(LedgerAccount.INVENTORY_ADJUSTMENT)).toBe(0);

    const again = await runImport('opening-stock', csv);
    expect(counts(again)).toEqual({ total: 7, valid: 4, errors: 3, created: 0, updated: 0, unchanged: 3, skipped: 1 });
    const changed = await runImport('opening-stock', `sku,quantity\nP1-${A.suffix},45\n`);
    expect(counts(changed)).toEqual({ total: 1, valid: 0, errors: 1, created: 0, updated: 0, unchanged: 0, skipped: 0 });
    expect((await reportOf(changed.id))[0].errors?.at(-1)?.message).toBe(`The opening stock of P1-${A.suffix} is already recorded as 40; record the difference as a stock adjustment.`);
    expect(await balance(LedgerAccount.INVENTORY)).toBe(28010.25);
  });

  it('customers: matched by phone, opening udhar recorded once per customer as the user who imported it', async () => {
    const csv = [
      'Customer Name,Mobile,Email,City,State,Credit Limit,Opening Balance,Notes',
      'Ramesh Kumar,+91 70123 45601,,Bengaluru,karnataka,5000,1250,',
      'Sharma General Store,070123-45602,accounts@sharma.test,Mysuru,Karnataka,25000,-500,Advance for festival stock',
      'Gupta Traders,7012345603,,Delhi,New Delhi,,0,',
      'Wrong State,7012345604,,,Bangalore,,100,',
      'Ramesh again,7012345601,,,,,,',
    ].join('\n');
    const dry = await runImport('customers', csv, { dryRun: 'true' }, managerToken);
    expect(counts(dry)).toEqual({ total: 5, valid: 3, errors: 2, created: 3, updated: 0, unchanged: 0, skipped: 0 });
    expect((await reportOf(dry.id))[0].changes).toEqual(['new customer Ramesh Kumar', 'opening udhar 1250.00']);
    expect(await run.system(() => prisma.customer.count({ where: { shopId: A.shopId } }))).toBe(1);

    const applied = await request(httpTarget(app)).post(`/api/imports/jobs/${dry.id}/apply`).set('Authorization', `Bearer ${managerToken}`);
    expect(applied.status).toBe(201);
    const job = await finished(applied.body.jobId);
    expect(counts(job)).toEqual({ total: 5, valid: 3, errors: 2, created: 3, updated: 0, unchanged: 0, skipped: 0 });

    const ramesh = await run.system(() => prisma.customer.findFirstOrThrow({ where: { shopId: A.shopId, phone: '7012345601' } }));
    const sharma = await run.system(() => prisma.customer.findFirstOrThrow({ where: { shopId: A.shopId, phone: '7012345602' } }));
    const gupta = await run.system(() => prisma.customer.findFirstOrThrow({ where: { shopId: A.shopId, phone: '7012345603' } }));
    expect([ramesh.state, num(ramesh.creditLimit), num(ramesh.outstandingBalance)]).toEqual(['Karnataka', 5000, 1250]);
    expect([sharma.email, num(sharma.outstandingBalance)]).toEqual(['accounts@sharma.test', -500]);
    expect([gupta.state, num(gupta.outstandingBalance)]).toEqual(['Delhi', 0]);
    const opening = await run.system(() => prisma.udharTransaction.findFirstOrThrow({ where: { shopId: A.shopId, idempotencyKey: openingBalanceKey(ramesh.id) } }));
    expect([opening.type, num(opening.amount), num(opening.balanceBefore), num(opening.balanceAfter), opening.reference, opening.recordedById]).toEqual(['ADJUSTMENT', 1250, 0, 1250, 'Opening balance', manager.id]);
    expect(await run.system(() => prisma.udharTransaction.count({ where: { shopId: A.shopId, customerId: gupta.id } }))).toBe(0);
    const posting = await run.system(() => prisma.ledgerPosting.findFirstOrThrow({ where: { shopId: A.shopId, sourceType: 'OPENING_BALANCE', sourceId: opening.id }, include: { transactions: true } }));
    expect(posting.transactions.map((t) => [t.account, t.type, num(t.amount)]).sort()).toEqual([
      ['ACCOUNTS_RECEIVABLE', 'DEBIT', 1250],
      ['OPENING_BALANCE_EQUITY', 'CREDIT', 1250],
    ]);
    expect(await balance(LedgerAccount.ACCOUNTS_RECEIVABLE)).toBe(750);
    expect(await balance(LedgerAccount.OPENING_BALANCE_EQUITY)).toBe(28010.25 + 750);

    const again = await runImport('customers', csv);
    expect(counts(again)).toEqual({ total: 5, valid: 3, errors: 2, created: 0, updated: 0, unchanged: 3, skipped: 0 });

    const edit = ['name,phone,city,openingBalance', 'Ramesh Kumar,7012345601,,1300', 'Gupta Traders,7012345603,New Delhi,'].join('\n');
    const edited = await runImport('customers', edit);
    expect(counts(edited)).toEqual({ total: 2, valid: 1, errors: 1, created: 0, updated: 1, unchanged: 0, skipped: 0 });
    const editReport = await reportOf(edited.id);
    expect(editReport[0].errors?.at(-1)?.message).toBe('The opening balance is already recorded as 1250.00; record the difference as a repayment or a credit sale.');
    expect(editReport[1].changes).toEqual(['city Delhi → New Delhi']);
    expect(await balance(LedgerAccount.ACCOUNTS_RECEIVABLE)).toBe(750);
  });

  it('a customer whose udhar already moved gets no opening balance: the difference is a repayment or a credit sale', async () => {
    const pay = await owner.post(`/api/customers/${A.customerId}/payments`).send({ idempotencyKey: randomUUID(), amount: 100, tender: 'CASH', allowAdvance: true });
    expect(pay.status).toBe(201);
    const ravi = await run.system(() => prisma.customer.findUniqueOrThrow({ where: { id: A.customerId } }));
    const job = await runImport('customers', `name,phone,openingBalance\nRavi,${ravi.phone},300\n`);
    expect(counts(job)).toEqual({ total: 1, valid: 0, errors: 1, created: 0, updated: 0, unchanged: 0, skipped: 0 });
    expect((await reportOf(job.id))[0].errors?.at(-1)?.message).toBe('The customer already has udhar activity (balance -100.00); an opening balance is only recorded before the first credit sale or repayment.');
  });

  it('the day the shop was set up reconciles CLEAN', async () => {
    const recon = await owner.post('/api/reconciliation/run').send({});
    expect(recon.status).toBe(201);
    expect(recon.body).toMatchObject({ status: 'CLEAN', driftCount: 0 });
  });

  it('only management imports; a foreign shop never sees a job; unsupported modes and fields are refused', async () => {
    const cashier = await bearerToken(app, A, cashierOf(A));
    const viewerUser = await createUser(app, A, Role.VIEWER);
    const viewer = await httpAs(app, A, viewerUser);
    expect((await upload('customers', 'name,phone\nX,7012345699\n', {}, cashier)).status).toBe(403);
    expect((await upload('opening-stock', 'sku,quantity\nX,1\n', {}, await bearerToken(app, A, viewerUser))).status).toBe(403);
    const list = await viewer.get('/api/imports/jobs?take=2');
    expect([list.status, list.headers['x-total-count'], list.body.length]).toEqual([200, expect.any(String), 2]);
    expect(Number(list.headers['x-total-count'])).toBeGreaterThanOrEqual(10);

    expect((await upload('products', products(), { mode: 'MERGE' })).status).toBe(400);
    expect((await upload('products', products(), { dryRun: 'yes' })).status).toBe(400);

    const someJob = list.body[0].id as string;
    const B = await createShop(app, 'onbB', { resolveLocation: false });
    const foreign = await httpAs(app, B, ownerOf(B));
    for (const url of [`/api/imports/jobs/${someJob}`, `/api/imports/jobs/${someJob}/rows`, `/api/imports/jobs/${someJob}/errors`, `/api/imports/jobs/${someJob}/report`]) {
      expect([url, (await foreign.get(url)).status]).toEqual([url, 404]);
    }
    expect((await foreign.post(`/api/imports/jobs/${someJob}/apply`)).status).toBe(404);
    expect((await foreign.get('/api/imports/jobs')).body).toEqual([]);
  });

  it('a job whose user is no longer an active manager of the shop is refused, not run under another identity', async () => {
    const suspended = await createUser(app, A, Role.MANAGER);
    await run.system(() => prisma.user.update({ where: { id: suspended.id }, data: { isActive: false } }));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onb-')), 'customers.csv');
    fs.writeFileSync(file, 'name,phone\nGhost,7012345698\n');
    const job = await run.system(() =>
      prisma.importJob.create({ data: { shopId: A.shopId, kind: ImportKind.CUSTOMERS, fileName: 'customers.csv', fileSize: 30, fileUrl: file, format: 'CSV', createdById: suspended.id } }),
    );
    await app.get<Queue>(getQueueToken('import-job')).add('process-import', { jobId: job.id, shopId: A.shopId });
    const done = await finished(job.id);
    expect(done.status).toBe('FAILED');
    expect((await reportOf(job.id))[0].errors).toEqual([expect.objectContaining({ message: expect.stringContaining('no longer an active manager') })]);
    expect(await run.system(() => prisma.customer.count({ where: { shopId: A.shopId, phone: '7012345698' } }))).toBe(0);
  });
});
