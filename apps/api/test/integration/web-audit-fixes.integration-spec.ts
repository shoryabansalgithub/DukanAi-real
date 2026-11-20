/**
 * The API side of the web findings of the 2026-10-11 release audit.
 *
 * W3: a new shop has no email, and the settings page sends every profile
 * field; `PATCH /shops/me` refused the blank email (`@IsEmail` on ''), so the
 * owner could not save the GSTIN or the state without inventing an address.
 * A blank (or null) email now clears the column; a malformed one is still 400.
 *
 * W4: the contract the customer form relies on: a cashier may edit a
 * customer as long as the body carries no credit limit, which only a manager
 * may set (403 `CREDIT_LIMIT_REQUIRES_MANAGER`).
 */
import { INestApplication } from '@nestjs/common';
import { bootApp, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { PrismaService } from '../../src/prisma/prisma.service';
import { cashierOf, httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

describe('web audit fixes over HTTP (W3, W4)', () => {
  let app: INestApplication;
  let A: TestShop;

  beforeAll(async () => {
    app = await bootApp();
    A = await createShop(app, 'webfix');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('W3: the shop profile saves with a blank email', () => {
    it('saves the whole profile with email "" and stores no address', async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      // What the settings page sends for a shop that never had an email.
      const profile = { name: `Shop ${A.suffix}`, address: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210', email: '', gstin: '29ABCDE1234F1Z5' };
      const saved = await owner.patch('/api/shops/me').send(profile);
      expect([saved.status, saved.body.code]).toEqual([200, undefined]);
      expect(saved.body).toMatchObject({ state: 'Karnataka', email: null, settings: expect.objectContaining({ gstin: '29ABCDE1234F1Z5' }) });
      expect((await owner.get('/api/shops/me')).body).toMatchObject({ email: null, state: 'Karnataka', pincode: '560001' });
    });

    it('sets, then clears, the email; null clears it too; a malformed one is refused', async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      const email = `shop-${A.suffix}@example.com`;
      expect((await owner.patch('/api/shops/me').send({ email })).body.email).toBe(email);

      const cleared = await owner.patch('/api/shops/me').send({ email: '' });
      expect([cleared.status, cleared.body.email]).toEqual([200, null]);
      expect((await owner.get('/api/shops/me')).body.email).toBeNull();

      expect((await owner.patch('/api/shops/me').send({ email })).body.email).toBe(email);
      const nulled = await owner.patch('/api/shops/me').send({ email: null });
      expect([nulled.status, nulled.body.email]).toEqual([200, null]);

      const malformed = await owner.patch('/api/shops/me').send({ email: 'not-an-email' });
      expect(malformed.status).toBe(400);
      expect(JSON.stringify(malformed.body)).toContain('email must be an email');
      expect((await owner.get('/api/shops/me')).body.email).toBeNull();
    });
  });

  describe('W4: a cashier edits a customer without touching the credit limit', () => {
    it('accepts the edit without creditLimit and refuses one that carries it', async () => {
      const cashier = await httpAs(app, A, cashierOf(A));
      const edit = await cashier.patch(`/api/customers/${A.customerId}`).send({ name: 'Ravi Kumar', city: 'Mysuru', email: '', notes: 'Edited by the cashier' });
      expect([edit.status, edit.body.code]).toEqual([200, undefined]);
      expect(edit.body).toMatchObject({ name: 'Ravi Kumar', city: 'Mysuru' });
      expect(Number(edit.body.creditLimit)).toBe(500);

      const withLimit = await cashier.patch(`/api/customers/${A.customerId}`).send({ name: 'Ravi Kumar', creditLimit: 500 });
      expect([withLimit.status, withLimit.body.code]).toEqual([403, 'CREDIT_LIMIT_REQUIRES_MANAGER']);

      const owner = await httpAs(app, A, ownerOf(A));
      const raised = await owner.patch(`/api/customers/${A.customerId}`).send({ creditLimit: 750.5 });
      expect([raised.status, Number(raised.body.creditLimit)]).toEqual([200, 750.5]);
    });
  });

  describe('notifications: the unread count covers more than one page', () => {
    it('GET /notifications/unread-count counts every unread notification of the shop, past the default page', async () => {
      const prisma = app.get(PrismaService);
      const before = (await (await httpAs(app, A, cashierOf(A))).get('/api/notifications/unread-count')).body.count as number;
      await tenantRunner(app).system(() =>
        prisma.notification.createMany({
          data: Array.from({ length: 105 }, (_, i) => ({ shopId: A.shopId, type: 'PAYMENT_RECEIVED' as const, title: `unread ${i}`, message: 'm', isRead: false })),
        }),
      );
      const cashier = await httpAs(app, A, cashierOf(A));
      const counted = await cashier.get('/api/notifications/unread-count');
      expect([counted.status, counted.body.count]).toEqual([200, before + 105]);
      expect((await cashier.get('/api/notifications')).body).toHaveLength(100);
    });
  });
});
