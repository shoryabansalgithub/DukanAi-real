/**
 * Expense receipts (release audit, 2026-10-12): the expense form's "Attach
 * Receipt" field stores a photo or PDF per expense under the shop's storage
 * root, and the expenses page opens it again. A receipt is never replaced in
 * place (the earlier file moves to Deleted/), the bytes must be what their
 * type says, writes are MANAGEMENT_ROLES, reads FINANCE_ROLES (a cashier or a
 * stock clerk is 403), and another shop's expense is 404.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StoragePathBuilder } from '../../src/storage/storage-path.builder';
import { bootApp, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { bearerToken, createUser, ownerOf } from '../security/security-fixtures';

jest.setTimeout(180_000);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]), Buffer.alloc(512, 0x2a)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(512, 0x11)]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

describe('Expense receipts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StoragePathBuilder;
  let A: TestShop;
  let B: TestShop;
  let owner: string;
  let foreignOwner: string;
  let viewer: string;
  let cashier: string;
  let manager: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const attach = (token: string, id: string, body: Buffer, filename: string, contentType: string) =>
    http().post(`/api/expenses/${id}/receipt`).set(as(token)).attach('file', body, { filename, contentType });

  async function createExpense(description = 'Shop electricity bill'): Promise<string> {
    const res = await http().post('/api/expenses').set(as(owner)).send({ description, category: 'Utilities', amount: 1250, paymentMode: 'UPI' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  const expenseDir = (shop: TestShop, id: string) => storage.getExpenseDirectory(shop.shopId, id);
  const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    storage = app.get(StoragePathBuilder);
    A = await createShop(app, 'rcpt');
    B = await createShop(app, 'rcptb');
    owner = await bearerToken(app, A, ownerOf(A));
    foreignOwner = await bearerToken(app, B, ownerOf(B));
    viewer = await bearerToken(app, A, await createUser(app, A, Role.VIEWER));
    cashier = await bearerToken(app, A, await createUser(app, A, Role.CASHIER));
    manager = await bearerToken(app, A, await createUser(app, A, Role.MANAGER));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('attaches a photo, serves it back byte for byte, lists the expense with it and audits the attach', async () => {
    const id = await createExpense();
    const res = await attach(owner, id, PNG, 'bill.png', 'image/png');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, hasReceipt: true, receiptType: 'image/png' });

    const stored = filesIn(expenseDir(A, id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^receipt-\d+-[0-9a-f]{8}\.png$/);
    expect(fs.readFileSync(path.join(expenseDir(A, id), stored[0]))).toEqual(PNG);
    const row = await tenantRunner(app).system(() => prisma.expense.findUniqueOrThrow({ where: { id } }));
    expect(row.receiptPath).toBe(`Expenses/${id}/${stored[0]}`);

    const served = await http().get(`/api/expenses/${id}/receipt`).set(as(owner)).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.body).toEqual(PNG);

    const list = await http().get('/api/expenses').set(as(owner));
    expect(list.body.find((e: { id: string }) => e.id === id)).toMatchObject({ hasReceipt: true, receiptType: 'image/png' });

    const audit = await tenantRunner(app).system(() => prisma.auditLog.findMany({ where: { shopId: A.shopId, entity: 'Expense', entityId: id, action: 'EXPENSE_RECEIPT_ATTACHED' } }));
    expect(audit).toHaveLength(1);
    expect(audit[0].afterData).toMatchObject({ receiptAttached: true, amount: '1250.00' });
  });

  it('a second attach replaces the receipt and keeps the first one in Deleted/', async () => {
    const id = await createExpense('Rent receipt');
    expect((await attach(owner, id, JPEG, 'first.jpg', 'image/jpeg')).status).toBe(200);
    const deletedDir = path.join(storage.getShopRoot(A.shopId), 'Deleted');
    const deletedBefore = filesIn(deletedDir).length;

    const res = await attach(owner, id, PDF, 'invoice.pdf', 'application/pdf');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasReceipt: true, receiptType: 'application/pdf' });
    const stored = filesIn(expenseDir(A, id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/\.pdf$/);
    const deleted = filesIn(deletedDir);
    expect(deleted.length).toBe(deletedBefore + 1);
    expect(deleted.some((name) => name.endsWith('.jpg') && fs.readFileSync(path.join(deletedDir, name)).equals(JPEG))).toBe(true);

    const served = await http().get(`/api/expenses/${id}/receipt`).set(as(manager));
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('application/pdf');
    expect((await http().get(`/api/expenses/${id}/receipt`).set(as(viewer))).status).toBe(403);
    expect((await http().get(`/api/expenses/${id}/receipt`).set(as(cashier))).status).toBe(403);
  });

  it('refuses a missing file, a disallowed type, bytes that are not what they claim and a file over the cap, keeping nothing', async () => {
    const id = await createExpense('Refusals');
    expect((await http().post(`/api/expenses/${id}/receipt`).set(as(owner))).status).toBe(400);
    expect((await attach(owner, id, Buffer.from('plain text'), 'notes.txt', 'text/plain')).status).toBe(400);
    expect((await attach(owner, id, Buffer.from('MZ\x90\x00'), 'tool.exe', 'application/octet-stream')).status).toBe(400);

    const mismatch = await attach(owner, id, PDF, 'photo.jpg', 'image/jpeg');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('STORAGE_CONTENT_MISMATCH');

    const huge = await attach(owner, id, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), 'huge.png', 'image/png');
    expect(huge.status).toBe(413);

    expect(filesIn(expenseDir(A, id))).toEqual([]);
    const noReceipt = await http().get(`/api/expenses/${id}/receipt`).set(as(owner));
    expect(noReceipt.status).toBe(404);
    expect(noReceipt.body.code).toBe('EXPENSE_RECEIPT_NOT_FOUND');
  });

  it('only MANAGEMENT_ROLES attach; another shop and a deleted expense are 404; a vanished file is 404, never 500', async () => {
    const id = await createExpense('Roles');
    expect((await attach(viewer, id, PNG, 'v.png', 'image/png')).status).toBe(403);
    expect((await attach(cashier, id, PNG, 'c.png', 'image/png')).status).toBe(403);
    expect(filesIn(expenseDir(A, id))).toEqual([]);

    expect((await attach(owner, id, PNG, 'ok.png', 'image/png')).status).toBe(200);
    expect((await attach(foreignOwner, id, PNG, 'x.png', 'image/png')).status).toBe(404);
    expect((await http().get(`/api/expenses/${id}/receipt`).set(as(foreignOwner))).status).toBe(404);
    expect((await http().get('/api/expenses/no-such-expense/receipt').set(as(owner))).status).toBe(404);
    expect(filesIn(expenseDir(B, id))).toEqual([]);

    for (const name of filesIn(expenseDir(A, id))) fs.unlinkSync(path.join(expenseDir(A, id), name));
    const missing = await http().get(`/api/expenses/${id}/receipt`).set(as(owner));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('EXPENSE_RECEIPT_MISSING');

    expect((await http().delete(`/api/expenses/${id}`).set(as(owner))).status).toBe(200);
    expect((await attach(owner, id, PNG, 'late.png', 'image/png')).status).toBe(404);
    expect((await http().get(`/api/expenses/${id}/receipt`).set(as(owner))).status).toBe(404);
  });
});
