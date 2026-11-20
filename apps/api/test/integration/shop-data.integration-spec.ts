/**
 * Roadmap 9.24: a shop's data export and its deletion request, and a
 * customer's erasure request, on the real schema.
 *
 *  - The export holds every row of the shop (the Shop row included), no
 *    credential, the books as CSV, the shop's documents, and checksums that
 *    verify.
 *  - An ACTIVE shop is never erased; `suspend` stops it and ends its sessions.
 *  - After `erase`, a marker planted in every personal field the shop's
 *    people could type (customer name, phone, email, address, notes, invoice
 *    note, repayment note, supplier contact, expense description, the
 *    owner's name) appears in no text column of any table, while the ledger,
 *    the invoices and their amounts are exactly as before.
 *  - A customer's erasure is refused while a balance is open, keeps name and
 *    address under the GST legal hold (a sale of 50,000 or more in its
 *    retention period, with its invoices folder), and erases everything else.
 */
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { promises as fs, existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { eraseCustomer, eraseShop, exportShop, ShopDataError, suspendShop } from '../../src/privacy/shop-data';
import { tenantModels, inventory } from '../../src/privacy/personal-data';
import { PrismaService } from '../../src/prisma/prisma.service';
import request from 'supertest';
import { bootApp, createProduct, createShop, httpTarget, receiveStock, tenantRunner, TestShop } from './pos-fixtures';
import { bearerToken, httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(180_000);

describe('shop data requests (roadmap 9.24)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let tmp: string;
  const now = () => new Date();

  beforeAll(async () => {
    app = await bootApp();
    db = new PrismaClient();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-data-'));
  });

  afterAll(async () => {
    await db?.$disconnect();
    await app?.close();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  const paths = () => ({ storageRoot: path.join(tmp, 'storage'), uploadsRoot: path.join(tmp, 'uploads'), workingDirectory: tmp });

  /** A shop with a cash sale, a credit sale repaid in cash, a supplier, an expense, a stored document; every free field carries `marker`. */
  async function populatedShop(label: string, marker: string): Promise<{ shop: TestShop; productId: string; saleId: string }> {
    const shop = await createShop(app, label, { creditLimit: 100000 });
    const prisma = app.get(PrismaService);
    const run = tenantRunner(app);
    await run.system(async () => {
      await prisma.customer.update({ where: { id: shop.customerId }, data: { name: `Cust ${marker}`, email: `${marker.toLowerCase()}@mail.test`, address: `12 ${marker} Road`, city: `${marker}pur`, notes: `likes ${marker}` } });
      await prisma.user.update({ where: { id: shop.ownerId }, data: { name: `Owner ${marker}`, phone: '9000000001' } });
      await prisma.supplier.create({ data: { shopId: shop.shopId, name: `Supplier ${marker}`, contactPerson: `Contact ${marker}`, phone: '9000000002', email: `s.${marker.toLowerCase()}@mail.test` } });
    });
    const productId = await createProduct(app, shop, { key: `${label}p`, sellingPrice: 100, gstRate: 'ZERO' });
    await receiveStock(app, shop, productId, 50);
    const owner = await httpAs(app, shop, ownerOf(shop));
    expect((await owner.post('/api/shifts/open').send({ openingCash: 500 })).status).toBe(201);
    const sale = await owner.post('/api/billing/invoice').send({ idempotencyKey: randomUUID(), customerId: shop.customerId, notes: `for ${marker}`, items: [{ productId, quantity: 1 }], payments: [{ tender: 'CASH', amount: 100 }] });
    expect(sale.status).toBe(201);
    const credit = await owner.post('/api/billing/invoice').send({ idempotencyKey: randomUUID(), customerId: shop.customerId, items: [{ productId, quantity: 1 }], payments: [], udharAmount: 100 });
    expect(credit.status).toBe(201);
    const repay = await owner.post(`/api/customers/${shop.customerId}/payments`).send({ idempotencyKey: randomUUID(), amount: 100, tender: 'CASH', notes: `paid by ${marker}` });
    expect(repay.status).toBe(201);
    const expense = await owner.post('/api/expenses').send({ category: 'OTHER', amount: 50, description: `tea for ${marker}` });
    expect([200, 201]).toContain(expense.status);
    const docs = path.join(paths().storageRoot, shop.shopId, 'Customers', shop.customerId, 'Profile');
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'kyc.txt'), `id card of ${marker}`);
    return { shop, productId, saleId: sale.body.invoice.id };
  }

  /** Every text column of every table where `marker` still appears (the proof of the erasure). */
  async function whereMarkerRemains(marker: string): Promise<string[]> {
    const hits: string[] = [];
    const tables = new Map(tenantModels().map((m) => [m.name, m.table]));
    tables.set('Shop', 'Shop');
    for (const row of inventory()) {
      const table = tables.get(row.model) ?? (row.model === 'User' ? 'User' : null);
      if (!table) continue;
      const found = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE CAST(\`${row.dbName}\` AS CHAR) LIKE ?`, `%${marker}%`);
      if (Number(found[0].n) > 0) hits.push(`${row.model}.${row.field}`);
    }
    return hits;
  }

  const ledgerTotals = async (shopId: string) =>
    (await db.$queryRawUnsafe<Array<{ account: string; total: Prisma.Decimal }>>('SELECT `account`, SUM(`amount`) AS total FROM `LedgerTransaction` WHERE `shopId` = ? GROUP BY `account` ORDER BY `account`', shopId)).map((r) => `${r.account}=${r.total.toString()}`);

  it('the ledger never carries the customer name (migration 20261011090000 and the writers)', async () => {
    const marker = `Ledg${Date.now()}`;
    const { shop } = await populatedShop('ledg', marker);
    const rows = await db.$queryRawUnsafe<Array<{ description: string }>>('SELECT `description` FROM `LedgerTransaction` WHERE `shopId` = ? AND `description` LIKE ?', shop.shopId, 'Customer payment%');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.description).toBe('Customer payment (CASH)');
  });

  it('export, suspend and erase a shop: nothing personal remains, the books are unchanged', async () => {
    const marker = `Zq${Date.now()}`;
    const { shop, saleId } = await populatedShop('erase', marker);

    // --- export (directory form, to inspect)
    const exported = await exportShop(db, { ...paths(), shopId: shop.shopId, outDir: path.join(tmp, 'out'), now: now(), archive: false });
    expect(exported.tables.Shop).toBe(1);
    expect(exported.tables.Invoice).toBe(2);
    expect(exported.tables.Customer).toBe(1);
    expect(exported.files.documents).toBe(1);
    const users = readFileSync(path.join(exported.directory, 'data', 'User.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(users.length).toBe(2);
    for (const u of users) expect(Object.keys(u)).not.toContain('password');
    expect(readFileSync(path.join(exported.directory, 'data', 'Customer.jsonl'), 'utf8')).toContain(marker);
    expect(readFileSync(path.join(exported.directory, 'csv', 'invoices.csv'), 'utf8')).toContain(saleId);
    expect(readFileSync(path.join(exported.directory, 'documents', 'Customers', shop.customerId, 'Profile', 'kyc.txt'), 'utf8')).toContain(marker);
    for (const line of readFileSync(path.join(exported.directory, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [sum, rel] = line.split('  ');
      expect(createHash('sha256').update(readFileSync(path.join(exported.directory, rel))).digest('hex')).toBe(sum);
    }
    const manifest = JSON.parse(readFileSync(path.join(exported.directory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 'dukaanai-shop-export/1', shop: { id: shop.shopId } });

    // --- the archive form the erasure needs
    const packed = await exportShop(db, { ...paths(), shopId: shop.shopId, outDir: path.join(tmp, 'packed'), now: new Date(Date.now() + 1000) });
    expect(packed.archive && existsSync(packed.archive) && existsSync(`${packed.archive}.sha256`)).toBe(true);

    // --- an ACTIVE shop is never erased
    await expect(eraseShop(db, { ...paths(), shopId: shop.shopId, now: now(), dryRun: false })).rejects.toBeInstanceOf(ShopDataError);

    // --- suspend: the shop stops and its sessions end
    const owner = await httpAs(app, shop, ownerOf(shop));
    expect((await owner.get('/api/shops/me')).status).toBeLessThan(400);
    const suspended = await suspendShop(db, shop.shopId, now());
    expect(suspended).toMatchObject({ previousStatus: 'ACTIVE', usersSignedOut: 2 });
    expect([401, 403]).toContain((await owner.get('/api/billing/invoices')).status);

    // --- dry run: counts, nothing changes
    const before = await ledgerTotals(shop.shopId);
    const plan = await eraseShop(db, { ...paths(), shopId: shop.shopId, now: now(), dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.rows).toMatchObject({ Shop: 1, Customer: 1, User: 2 });
    expect((await whereMarkerRemains(marker)).length).toBeGreaterThan(0);

    // --- erase
    const receipt = await eraseShop(db, { ...paths(), shopId: shop.shopId, now: now(), dryRun: false });
    expect(receipt.rows).toMatchObject({ Shop: 1, Customer: 1, User: 2 });
    expect(await whereMarkerRemains(marker)).toEqual([]);
    expect(existsSync(path.join(paths().storageRoot, shop.shopId))).toBe(false);

    const [shopRow] = await db.$queryRawUnsafe<Array<{ name: string; status: string; phone: string | null }>>('SELECT `name`, `status`, `phone` FROM `Shop` WHERE `id` = ?', shop.shopId);
    expect(shopRow).toEqual({ name: '[erased]', status: 'DELETED', phone: null });
    const [customer] = await db.$queryRawUnsafe<Array<{ name: string; phone: string; isDeleted: number | boolean }>>('SELECT `name`, `phone`, `isDeleted` FROM `Customer` WHERE `id` = ?', shop.customerId);
    expect(customer.name).toBe('[erased]');
    expect(customer.phone).toBe(`erased-${shop.customerId}`);
    expect(Boolean(customer.isDeleted)).toBe(true);
    const people = await db.$queryRawUnsafe<Array<{ email: string; isActive: number | boolean; password: string | null }>>('SELECT `email`, `isActive`, `password` FROM `User` WHERE `shopId` = ?', shop.shopId);
    for (const p of people) expect({ email: p.email.endsWith('@erased.invalid'), active: Boolean(p.isActive), password: p.password }).toEqual({ email: true, active: false, password: null });
    const tokens = await db.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT COUNT(*) AS n FROM `RefreshToken` WHERE `userId` IN (SELECT `id` FROM `User` WHERE `shopId` = ?)', shop.shopId);
    expect(Number(tokens[0].n)).toBe(0);

    // the books: every ledger total, the invoices and their amounts are as before
    expect(await ledgerTotals(shop.shopId)).toEqual(before);
    const invoices = await db.$queryRawUnsafe<Array<{ totalAmount: Prisma.Decimal }>>('SELECT `totalAmount` FROM `Invoice` WHERE `shopId` = ? ORDER BY `createdAt`', shop.shopId);
    expect(invoices.map((i) => i.totalAmount.toString())).toEqual(['100', '100']);
    const audit = await db.$queryRawUnsafe<Array<{ action: string }>>("SELECT `action` FROM `AuditLog` WHERE `shopId` = ? AND `action` = 'SHOP_ERASED'", shop.shopId);
    expect(audit).toHaveLength(1);

    // a second run finds nothing personal to do and still succeeds
    await expect(eraseShop(db, { ...paths(), shopId: shop.shopId, now: now(), dryRun: false })).resolves.toMatchObject({ dryRun: false });
  });

  it("a customer's erasure: refused with a balance, a GST legal hold keeps name and address, otherwise everything goes", async () => {
    const marker = `Cx${Date.now()}`;
    const shop = await createShop(app, 'cust', { creditLimit: 100000 });
    const big = await createProduct(app, shop, { key: 'big', sellingPrice: 60000, gstRate: 'ZERO' });
    const small = await createProduct(app, shop, { key: 'small', sellingPrice: 100, gstRate: 'ZERO' });
    await receiveStock(app, shop, big, 5);
    await receiveStock(app, shop, small, 5);
    const prisma = app.get(PrismaService);
    const run = tenantRunner(app);
    const [held, plain, owing] = await run.system(() =>
      Promise.all(
        ['held', 'plain', 'owing'].map((k, i) =>
          prisma.customer.create({ data: { shopId: shop.shopId, name: `${k} ${marker}`, phone: `98${String(Date.now()).slice(-7)}${i}`, address: `${k} street ${marker}`, email: `${k}.${marker.toLowerCase()}@mail.test`, notes: `${k} ${marker}`, creditLimit: 100000 } }),
        ),
      ),
    );
    const owner = await httpAs(app, shop, ownerOf(shop));
    expect((await owner.post('/api/shifts/open').send({ openingCash: 500 })).status).toBe(201);
    const sell = (customerId: string, productId: string, amount: number, udhar = false) =>
      owner.post('/api/billing/invoice').send({ idempotencyKey: randomUUID(), customerId, items: [{ productId, quantity: 1 }], ...(udhar ? { payments: [], udharAmount: amount } : { payments: [{ tender: 'CASH', amount }] }) });
    expect((await sell(held.id, big, 60000)).status).toBe(201);
    expect((await sell(plain.id, small, 100)).status).toBe(201);
    expect((await sell(owing.id, small, 100, true)).status).toBe(201);
    for (const c of [held, plain]) {
      for (const sub of ['Invoices', 'Profile']) {
        await fs.mkdir(path.join(paths().storageRoot, shop.shopId, 'Customers', c.id, sub), { recursive: true });
        await fs.writeFile(path.join(paths().storageRoot, shop.shopId, 'Customers', c.id, sub, 'f.txt'), 'x');
      }
    }

    await expect(eraseCustomer(db, { storageRoot: paths().storageRoot, shopId: shop.shopId, customerId: owing.id, now: now(), dryRun: false })).rejects.toThrow(/outstanding balance of 100.00/);

    const heldReceipt = await eraseCustomer(db, { storageRoot: paths().storageRoot, shopId: shop.shopId, customerId: held.id, now: now(), dryRun: false });
    expect(heldReceipt.legalHold).toHaveLength(1);
    const [h] = await db.$queryRawUnsafe<Array<{ name: string; address: string; email: string | null; notes: string | null; phone: string }>>('SELECT `name`, `address`, `email`, `notes`, `phone` FROM `Customer` WHERE `id` = ?', held.id);
    expect(h).toEqual({ name: `held ${marker}`, address: `held street ${marker}`, email: null, notes: null, phone: `erased-${held.id}` });
    expect(existsSync(path.join(paths().storageRoot, shop.shopId, 'Customers', held.id, 'Invoices', 'f.txt'))).toBe(true);
    expect(existsSync(path.join(paths().storageRoot, shop.shopId, 'Customers', held.id, 'Profile'))).toBe(false);

    const plainReceipt = await eraseCustomer(db, { storageRoot: paths().storageRoot, shopId: shop.shopId, customerId: plain.id, now: now(), dryRun: false });
    expect(plainReceipt.legalHold).toEqual([]);
    const [p] = await db.$queryRawUnsafe<Array<{ name: string; address: string | null }>>('SELECT `name`, `address` FROM `Customer` WHERE `id` = ?', plain.id);
    expect(p).toEqual({ name: '[erased]', address: null });
    expect(existsSync(path.join(paths().storageRoot, shop.shopId, 'Customers', plain.id))).toBe(false);

    // the owing customer and the shop are untouched
    const [o] = await db.$queryRawUnsafe<Array<{ name: string }>>('SELECT `name` FROM `Customer` WHERE `id` = ?', owing.id);
    expect(o.name).toBe(`owing ${marker}`);
    expect((await owner.get('/api/billing/invoices')).status).toBe(200);
    expect(Role.OWNER).toBe('OWNER');
  });

  // -------------------------------------------------------------------------
  // Audit F2 / F3: the child tables (no shopId) are exported and erased through their parents.
  // -------------------------------------------------------------------------

  /** Every text column of EVERY table (information_schema, not the inventory) where `marker` still appears. */
  async function anywhere(marker: string): Promise<string[]> {
    const columns = await db.$queryRawUnsafe<Array<{ t: string; c: string }>>(
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json')",
    );
    const hits: string[] = [];
    for (const { t, c } of columns) {
      const found = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE CAST(\`${c}\` AS CHAR) LIKE ?`, `%${marker}%`);
      if (Number(found[0].n) > 0) hits.push(`${t}.${c}`);
    }
    return hits.sort();
  }

  const realUploads = path.resolve('uploads');
  const filesOf = async (shopId: string) => (existsSync(path.join(realUploads, 'imports')) ? (await fs.readdir(path.join(realUploads, 'imports'))).filter((n) => n.startsWith(`${shopId}-`)) : []);

  /** Customers created and edited over HTTP (so CustomerAudit rows exist) and a customer import (so ImportJobRow rows and an import file exist). */
  async function customersThroughTheApi(shop: TestShop, marker: string, phone: string) {
    const owner = await httpAs(app, shop, ownerOf(shop));
    const created = await owner.post('/api/customers').send({ name: `Api ${marker}`, phone, email: `api.${marker.toLowerCase()}@mail.test`, address: `${marker} lane`, notes: `vip ${marker}` });
    expect(created.status).toBe(201);
    expect((await owner.patch(`/api/customers/${created.body.id}`).send({ notes: `edited ${marker}` })).status).toBe(200);
    const token = await bearerToken(app, shop, ownerOf(shop));
    // The imported customer has its own number (written with a space, as spreadsheets do); the other row is someone else.
    const importPhone = `9${phone.slice(1)}`;
    const csv = ['name,phone,email,notes', `Imp ${marker},${importPhone.slice(0, 5)} ${importPhone.slice(5)},imp.${marker.toLowerCase()}@mail.test,imported ${marker}`, `Other Person,6${phone.slice(1)},,plain`].join('\n');
    const upload = await request(httpTarget(app)).post('/api/imports/customers/upload').set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(csv), { filename: 'customers.csv', contentType: 'text/csv' });
    expect(upload.status).toBe(201);
    for (let i = 0; i < 300; i++) {
      const job = await owner.get(`/api/imports/jobs/${upload.body.jobId}`);
      if (!['PENDING', 'PROCESSING'].includes(job.body.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const audits = await db.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT COUNT(*) AS n FROM `CustomerAudit` WHERE `customerId` = ?', created.body.id);
    expect(Number(audits[0].n)).toBeGreaterThanOrEqual(2); // created + updated
    return { customerId: created.body.id as string, jobId: upload.body.jobId as string };
  }

  /** Rows of the child tables nothing in the API writes yet: a photo's EXIF, a webhook's delivery log, a revision's review. */
  async function childRowsWith(shop: TestShop, marker: string, productId: string) {
    await run().system(async () => {
      const prisma = app.get(PrismaService);
      const asset = await prisma.mediaAsset.create({ data: { shopId: shop.shopId, hash: randomUUID(), mimeType: 'image/jpeg', extension: 'jpg', sizeBytes: 1, originalName: 'shelf.jpg' } });
      await prisma.mediaMetadata.create({ data: { assetId: asset.id, exifData: { gps: `taken at ${marker}` } } });
      const endpoint = await prisma.webhookEndpoint.create({ data: { shopId: shop.shopId, url: 'https://hooks.example.com/x', secret: randomUUID(), events: ['*'] } });
      await prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, eventId: randomUUID(), eventType: 'CustomerCreated', payload: { name: marker }, status: 'FAILED', errorMessage: `refused ${marker}` } });
      const branch = await prisma.revisionBranch.create({ data: { productId, name: `main-${randomUUID().slice(0, 6)}`, baseRevId: 'base' } });
      const revision = await prisma.productRevision.create({ data: { productId, branchId: branch.id, shopId: shop.shopId, versionNumber: 1, isSnapshot: true, data: {}, contentHash: 'h', authorId: shop.ownerId } });
      await prisma.revisionApproval.create({ data: { revisionId: revision.id, reviewerId: shop.ownerId, status: 'APPROVED', comments: `ok ${marker}`, digitalSignature: `signed ${marker}` } });
    });
  }
  const run = () => tenantRunner(app);

  it('the export carries the child tables: the lines of every invoice as data and CSV (audit F2)', async () => {
    const marker = `Fx${Date.now()}`;
    const { shop } = await populatedShop('expchild', marker);
    const out = await exportShop(db, { ...paths(), shopId: shop.shopId, outDir: path.join(tmp, 'children'), now: now(), archive: false });
    expect(out.tables.InvoiceItem).toBe(2);
    const lines = readFileSync(path.join(out.directory, 'data', 'InvoiceItem.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    const csv = readFileSync(path.join(out.directory, 'csv', 'invoice-items.csv'), 'utf8').trim().split('\r\n');
    expect(csv).toHaveLength(3); // header + two lines
    expect(out.tables.CustomerAudit ?? 0).toBeGreaterThanOrEqual(0);
    expect(Object.keys(out.tables)).toEqual(expect.arrayContaining(['ImportJobRow', 'WebhookDelivery', 'MediaMetadata', 'RevisionApproval', 'StockTransfer']));
  });

  it('a shop erasure leaves the marker in no text column of any table: audit trails, import rows, EXIF, webhook log, reviews and import files go too (audit F3)', async () => {
    const marker = `Ex${Date.now()}`;
    const { shop, productId } = await populatedShop('erasechild', marker);
    const phone = `7${String(Date.now()).slice(-9)}`;
    await customersThroughTheApi(shop, marker, phone);
    await childRowsWith(shop, marker, productId);
    expect(await filesOf(shop.shopId)).toHaveLength(1);
    const before = await anywhere(marker);
    expect(before).toEqual(expect.arrayContaining(['CustomerAudit.newPayload', 'ImportJobRow.rawData', 'MediaMetadata.exifData', 'WebhookDelivery.payload', 'RevisionApproval.comments']));

    await suspendShop(db, shop.shopId, now());
    const receipt = await eraseShop(db, { storageRoot: paths().storageRoot, uploadsRoot: realUploads, workingDirectory: process.cwd(), shopId: shop.shopId, now: now(), dryRun: false });
    expect(receipt.rows).toMatchObject({ CustomerAudit: expect.any(Number), ImportJobRow: expect.any(Number), MediaMetadata: 1, WebhookDelivery: 1, RevisionApproval: 1 });
    expect(await anywhere(marker)).toEqual([]);
    expect(await filesOf(shop.shopId)).toEqual([]);
  });

  it("a customer's erasure reaches their audit trail, the import rows and the import file that hold them, and no one else's (audit F3)", async () => {
    const marker = `Cy${Date.now()}`;
    const other = `Ot${Date.now()}`;
    const shop = await createShop(app, 'custchild', { creditLimit: 100000 });
    const phone = `8${String(Date.now()).slice(-9)}`;
    const { jobId } = await customersThroughTheApi(shop, marker, phone);
    const owner = await httpAs(app, shop, ownerOf(shop));
    const keep = await owner.post('/api/customers').send({ name: `Keep ${other}`, phone: `7${String(Date.now()).slice(-9).split('').reverse().join('')}`, notes: `stays ${other}` });
    expect(keep.status).toBe(201);
    const [imported] = await db.$queryRawUnsafe<Array<{ id: string }>>('SELECT `id` FROM `Customer` WHERE `shopId` = ? AND `name` = ?', shop.shopId, `Imp ${marker}`);
    expect(imported).toBeDefined();

    // The API-made customer: its own row, its CustomerAudit rows.
    const apiCustomer = (await db.$queryRawUnsafe<Array<{ id: string }>>('SELECT `id` FROM `Customer` WHERE `shopId` = ? AND `name` = ?', shop.shopId, `Api ${marker}`))[0];
    await eraseCustomer(db, { storageRoot: paths().storageRoot, uploadsRoot: realUploads, shopId: shop.shopId, customerId: apiCustomer.id, now: now(), dryRun: false });
    const auditLeft = await db.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT COUNT(*) AS n FROM `CustomerAudit` WHERE `customerId` = ? AND (`previousPayload` IS NOT NULL OR `newPayload` IS NOT NULL OR `ipAddress` IS NOT NULL)', apiCustomer.id);
    expect(Number(auditLeft[0].n)).toBe(0);

    // The imported customer (same phone in the file, spelled with a space): row, audit trail, report rows and the file.
    const receipt = await eraseCustomer(db, { storageRoot: paths().storageRoot, uploadsRoot: realUploads, shopId: shop.shopId, customerId: imported.id, now: now(), dryRun: false });
    expect(receipt.rows.ImportJobRow).toBeGreaterThanOrEqual(1);
    expect(receipt.files.removed).toBeGreaterThanOrEqual(1);
    expect(await anywhere(marker)).toEqual([]);
    expect(await filesOf(shop.shopId)).toEqual([]);
    // The other row of the same import, and the other customer, are untouched.
    const rows = await db.$queryRawUnsafe<Array<{ rawData: unknown }>>('SELECT `rawData` FROM `ImportJobRow` WHERE `importJobId` = ? AND `rowNumber` > 0 ORDER BY `rowNumber`', jobId);
    expect(rows.map((r) => JSON.stringify(r.rawData))).toEqual([expect.not.stringContaining('Imp '), expect.stringContaining('Other Person')]);
    expect((await anywhere(other)).length).toBeGreaterThan(0);
  });
});
