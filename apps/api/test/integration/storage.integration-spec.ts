/**
 * Storage hardening over HTTP (roadmap 7.5): a customer of another shop is
 * 404 on every storage route, billing evidence is stored once (409 on a
 * repeat), and no response carries an absolute path.
 */
import { INestApplication } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { StoragePathBuilder } from '../../src/storage/storage-path.builder';
import { bootApp, createShop, TestShop } from './pos-fixtures';
import { bearerToken, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const png = Buffer.concat([PNG_HEADER, Buffer.alloc(512, 0x2a)]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x20)]);

describe('storage (roadmap 7.5)', () => {
  let app: INestApplication;
  let A: TestShop;
  let B: TestShop;
  let tokenA: string;
  let root: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootApp();
    A = await createShop(app, 'stA');
    B = await createShop(app, 'stB');
    tokenA = await bearerToken(app, A, ownerOf(A));
    root = app.get(StoragePathBuilder).root;
  });

  afterAll(async () => {
    for (const shop of [A, B]) fs.rmSync(path.join(root, shop.shopId), { recursive: true, force: true });
    await app?.close();
  });

  it("a customer of another shop is 404 on every storage route, and nothing is written for it", async () => {
    const foreign = B.customerId;
    const bill = await http().post(`/api/storage/bills/${foreign}/x1`).set('Authorization', `Bearer ${tokenA}`).attach('image', png, { filename: 'b.png', contentType: 'image/png' });
    expect(bill.status).toBe(404);
    const folder = await http().post('/api/storage/customers').set('Authorization', `Bearer ${tokenA}`).send({ customerId: foreign });
    expect(folder.status).toBe(404);
    const payment = await http().post(`/api/storage/payments/${foreign}`).set('Authorization', `Bearer ${tokenA}`).send({ paymentData: { amount: 1 } });
    expect(payment.status).toBe(404);
    const statement = await http().post(`/api/storage/statements/${foreign}`).set('Authorization', `Bearer ${tokenA}`).attach('pdf', pdf, { filename: 's.pdf', contentType: 'application/pdf' });
    expect(statement.status).toBe(404);
    expect(fs.existsSync(path.join(root, A.shopId, 'Customers', foreign))).toBe(false);
  });

  it('billing evidence is stored once: a second upload for the same bill is 409 and the first bytes stay', async () => {
    const first = await http().post(`/api/storage/bills/${A.customerId}/dup-1`).set('Authorization', `Bearer ${tokenA}`).attach('image', png, { filename: 'b.png', contentType: 'image/png' });
    expect(first.status).toBe(201);
    const stored = path.join(root, A.shopId, 'Customers', A.customerId, 'Bills', 'BILL-dup-1.jpg');
    expect(fs.readFileSync(stored).equals(png)).toBe(true);

    const other = Buffer.concat([PNG_HEADER, Buffer.alloc(512, 0x11)]);
    const second = await http().post(`/api/storage/bills/${A.customerId}/dup-1`).set('Authorization', `Bearer ${tokenA}`).attach('image', other, { filename: 'b.png', contentType: 'image/png' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('STORAGE_EVIDENCE_EXISTS');
    expect(fs.readFileSync(stored).equals(png)).toBe(true);
  });

  it('responses carry shop-relative paths, never the storage root', async () => {
    const folder = await http().post('/api/storage/customers').set('Authorization', `Bearer ${tokenA}`).send({ customerId: A.customerId });
    expect(folder.status).toBe(201);
    expect(folder.body.path).toBe(`Customers/${A.customerId}/Profile`);

    await http().post(`/api/storage/bills/${A.customerId}/del-1`).set('Authorization', `Bearer ${tokenA}`).attach('image', png, { filename: 'b.png', contentType: 'image/png' }).expect(201);
    const deleted = await http().delete(`/api/storage/files/${A.customerId}`).set('Authorization', `Bearer ${tokenA}`).send({ category: 'Bills', datePath: '2026/Oct', fileName: 'BILL-del-1.jpg' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.newPath).toMatch(/^Deleted\/\d+-[0-9a-f]+\.jpg$/);

    const backup = await http().post('/api/storage/backup').set('Authorization', `Bearer ${tokenA}`).send({ type: 'Daily' });
    expect(backup.status).toBe(201);
    expect(backup.body.path).toMatch(/^Backups\/Daily\/backup_\d{4}_\d{2}_\d{2}\.zip$/);

    for (const body of [folder.body, deleted.body, backup.body]) {
      expect(JSON.stringify(body)).not.toContain(root);
      expect(JSON.stringify(body)).not.toMatch(/"\/[^"]*"/);
    }
  });
});
