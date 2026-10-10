import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
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

/**
 * Roadmap 9.18 "fill the storage volume": the first drill left a truncated
 * evidence file behind a failed write, so every retry of the same bill
 * answered 409 STORAGE_EVIDENCE_EXISTS for good, and an index rewritten in
 * place could be emptied. A full volume is simulated by a write that puts
 * half of its bytes down and then fails with ENOSPC.
 */
describe('StorageService on a full volume (roadmap 9.18)', () => {
  const shopId = 'shop-full';
  let root: string;
  let service: StorageService;
  // The service reads fs-extra through live getters, so the shared module object is the one to spy on.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsModule = require('fs-extra') as typeof fs;
  const realWriteFile = fsModule.writeFile.bind(fsModule) as (...args: unknown[]) => Promise<void>;
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const file = (name: string, content: string, mimetype: string) =>
    ({ fieldname: 'f', originalname: name, mimetype, buffer: Buffer.from(content), size: content.length }) as unknown as Express.Multer.File;

  /** The `nth` write matching `when` writes half its bytes, then fails ENOSPC; every other write is real. */
  function fillVolumeAt(nth: number, when: (target: string, options: unknown) => boolean) {
    let seen = 0;
    return jest.spyOn(fsModule, 'writeFile').mockImplementation((async (target: string, data: Buffer | string, options?: unknown) => {
      if (when(String(target), options) && ++seen === nth) {
        const bytes = Buffer.from(data);
        await realWriteFile(target, bytes.subarray(0, Math.max(1, bytes.length >> 1)), options);
        throw enospc();
      }
      return realWriteFile(target, data, options);
    }) as never);
  }
  const isEvidence = (_t: string, options: unknown) => (options as { flag?: string } | undefined)?.flag === 'wx';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dukaanai-full-'));
    const builder = new StoragePathBuilder(Object.assign(new StorageConfig(), { storageRoot: root }));
    const tenant = { getShopId: () => shopId, getUserId: () => 'user-1' };
    service = new StorageService(new StorageConfig(), { customer: { findFirst: jest.fn() } } as never, tenant as never, builder, { send: jest.fn() } as never);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(root);
  });

  it('a bill that fails part-way leaves no file behind, and the same bill is stored once space is back', async () => {
    const bill = () => service.storeCapturedBill(WALK_IN_CUSTOMER_ID, 'full1', file('b.jpg', 'jpeg-bytes-0123456789', 'image/jpeg'), file('b.pdf', '%PDF-0123456789', 'application/pdf'), 'ocr text', undefined);
    fillVolumeAt(3, isEvidence);
    await expect(bill()).rejects.toMatchObject({ code: 'ENOSPC' });
    const customerDir = path.join(root, shopId, 'Customers', WALK_IN_CUSTOMER_ID);
    const left = (await fs.pathExists(customerDir)) ? (await fs.readdir(customerDir, { recursive: true })).filter((p) => String(p).includes('BILL-full1')) : [];
    expect(left).toEqual([]);

    jest.restoreAllMocks();
    await bill();
    expect(await fs.readFile(path.join(customerDir, StorageCustomerDirectory.Bills, 'BILL-full1.jpg'), 'utf8')).toBe('jpeg-bytes-0123456789');
  });

  it('a failed index write keeps the previous index and leaves no temporary file', async () => {
    await service.storeInvoice(WALK_IN_CUSTOMER_ID, 'first', file('i.pdf', '%PDF-a', 'application/pdf'), { status: 'Issued' }, undefined);
    const registry = path.join(root, shopId, 'System', 'invoice_registry.json');
    const before = await fs.readFile(registry, 'utf8');
    fillVolumeAt(1, (target) => target.endsWith('.tmp'));
    await expect(service.storeInvoice(WALK_IN_CUSTOMER_ID, 'second', file('i.pdf', '%PDF-b', 'application/pdf'), { status: 'Issued' }, undefined)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await fs.readFile(registry, 'utf8')).toBe(before);
    expect((await fs.readdir(path.dirname(registry))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a full action log never turns a stored document into an error', async () => {
    jest.spyOn(fsModule, 'appendFile').mockRejectedValue(enospc() as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(service.storeCapturedBill(WALK_IN_CUSTOMER_ID, 'log1', file('b.jpg', 'img', 'image/jpeg'), undefined, undefined, undefined)).resolves.toBeUndefined();
    expect(await fs.pathExists(path.join(root, shopId, 'Customers', WALK_IN_CUSTOMER_ID, StorageCustomerDirectory.Bills, 'BILL-log1.jpg'))).toBe(true);
  });
});
