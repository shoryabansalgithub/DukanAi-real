import { ConflictException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { StorageConfig } from '../config/domains/storage.config';
import { StoragePathBuilder } from './storage-path.builder';
import { StorageService, WALK_IN_CUSTOMER_ID } from './storage.service';
import { StorageCustomerDirectory } from './storage-security.constants';

/**
 * Roadmap 7.5 on a temporary root: ownership through the shop-scoped
 * lookup (404 for a foreign customer), billing evidence written once (409
 * on a repeat, nothing partially replaced), and shop-relative paths in every
 * result.
 */
describe('StorageService (roadmap 7.5)', () => {
  const shopId = 'shop-a';
  const ownCustomer = 'cust-own';
  let root: string;
  let service: StorageService;
  const file = (name: string, content: string, mimetype: string) =>
    ({ fieldname: 'f', originalname: name, mimetype, buffer: Buffer.from(content), size: content.length }) as unknown as Express.Multer.File;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dukaanai-storage-'));
    const builder = new StoragePathBuilder(Object.assign(new StorageConfig(), { storageRoot: root }));
    const prisma = {
      customer: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; shopId: string } }) =>
          where.id === ownCustomer && where.shopId === shopId ? { id: ownCustomer } : null,
        ),
      },
    };
    const tenant = { getShopId: () => shopId, getUserId: () => 'user-1' };
    service = new StorageService(new StorageConfig(), prisma as never, tenant as never, builder, { send: jest.fn() } as never);
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  it('refuses a customer of another shop with 404 and never touches the disk', async () => {
    await expect(service.createCustomerFolder('cust-foreign')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.storeCapturedBill('cust-foreign', 'b1', file('b.jpg', 'img', 'image/jpeg'), undefined, undefined, undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(await fs.pathExists(path.join(root, shopId, 'Customers'))).toBe(false);
  });

  it('files walk-in evidence without a customer row', async () => {
    await service.storeCapturedBill(WALK_IN_CUSTOMER_ID, 'w1', file('b.jpg', 'img', 'image/jpeg'), undefined, 'text', undefined);
    expect(await fs.pathExists(path.join(root, shopId, 'Customers', WALK_IN_CUSTOMER_ID, StorageCustomerDirectory.Bills, 'BILL-w1.jpg'))).toBe(true);
  });

  it('never overwrites billing evidence: a repeat is 409 STORAGE_EVIDENCE_EXISTS and the stored bytes stay', async () => {
    await service.storeCapturedBill(ownCustomer, 'b1', file('b.jpg', 'first', 'image/jpeg'), file('b.pdf', '%PDF-first', 'application/pdf'), 'ocr-first', undefined);
    const billsDir = path.join(root, shopId, 'Customers', ownCustomer, StorageCustomerDirectory.Bills);
    await expect(
      service.storeCapturedBill(ownCustomer, 'b1', file('b.jpg', 'second', 'image/jpeg'), undefined, undefined, undefined),
    ).rejects.toMatchObject({ response: { code: 'STORAGE_EVIDENCE_EXISTS' } });
    expect(await fs.readFile(path.join(billsDir, 'BILL-b1.jpg'), 'utf8')).toBe('first');
    expect(await fs.readFile(path.join(billsDir, 'BILL-b1.pdf'), 'utf8')).toBe('%PDF-first');

    await service.storeInvoice(ownCustomer, 'i1', file('i.pdf', '%PDF-inv', 'application/pdf'), { status: 'Issued' }, undefined);
    await expect(service.storeInvoice(ownCustomer, 'i1', file('i.pdf', '%PDF-other', 'application/pdf'), {}, undefined)).rejects.toBeInstanceOf(ConflictException);
    const invoicesDir = path.join(root, shopId, 'Customers', ownCustomer, StorageCustomerDirectory.Invoices);
    expect(await fs.readFile(path.join(invoicesDir, 'INV-i1.pdf'), 'utf8')).toBe('%PDF-inv');
  });

  it('a partial duplicate (only the PDF already present) writes nothing', async () => {
    const pdfDir = path.join(root, shopId, 'Customers', ownCustomer, StorageCustomerDirectory.PDFs);
    await fs.ensureDir(pdfDir);
    await fs.writeFile(path.join(pdfDir, 'BILL-b2.pdf'), 'pre-existing');
    await expect(
      service.storeCapturedBill(ownCustomer, 'b2', file('b.jpg', 'img', 'image/jpeg'), file('b.pdf', '%PDF', 'application/pdf'), undefined, undefined),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await fs.pathExists(path.join(root, shopId, 'Customers', ownCustomer, StorageCustomerDirectory.Bills, 'BILL-b2.jpg'))).toBe(false);
    expect(await fs.readFile(path.join(pdfDir, 'BILL-b2.pdf'), 'utf8')).toBe('pre-existing');
  });

  it('a statement regenerated for the same month lands beside the earlier one', async () => {
    await service.storeStatement(ownCustomer, file('s.pdf', '%PDF-1', 'application/pdf'));
    await service.storeStatement(ownCustomer, file('s.pdf', '%PDF-2', 'application/pdf'));
    const dir = path.join(root, shopId, 'Customers', ownCustomer, StorageCustomerDirectory.Statements);
    expect((await fs.readdir(dir)).filter((n) => n.startsWith('STATEMENT-')).length).toBe(2);
  });

  it('answers shop-relative paths only: folder, soft delete and backup', async () => {
    const folder = await service.createCustomerFolder(ownCustomer);
    expect(folder).toBe(`Customers/${ownCustomer}/Profile`);
    expect(path.isAbsolute(folder)).toBe(false);

    await service.storeCapturedBill(ownCustomer, 'b3', file('b.jpg', 'img', 'image/jpeg'), undefined, undefined, undefined);
    const deleted = await service.softDeleteFile(ownCustomer, { category: StorageCustomerDirectory.Bills, datePath: '2026/Oct', fileName: 'BILL-b3.jpg' });
    expect(deleted.newPath).toMatch(/^Deleted\/\d+-[0-9a-f]+\.jpg$/);
    expect(await fs.pathExists(path.join(root, shopId, deleted.newPath))).toBe(true);

    const backup = await service.createBackup('Daily');
    expect(backup.path).toMatch(/^Backups\/Daily\/backup_\d{4}_\d{2}_\d{2}\.zip$/);
    expect(backup.size).toBeGreaterThan(0);
    expect(JSON.stringify([folder, deleted, backup])).not.toContain(root);
  });
});
