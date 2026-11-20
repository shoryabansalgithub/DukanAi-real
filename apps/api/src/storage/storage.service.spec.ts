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
      invoice: {
        // inv-own was sold to the own customer, inv-walk to nobody; anything else is not this shop's.
        findFirst: jest.fn(async ({ where }: { where: { id: string; shopId: string } }) =>
          where.shopId !== shopId ? null : ['inv-own', 'i1'].includes(where.id) ? { customerId: ownCustomer } : where.id === 'inv-walk' ? { customerId: null } : null,
        ),
      },
    };
    const tenant = { getShopId: () => shopId, getUserId: () => 'user-1' };
    service = new StorageService(Object.assign(new StorageConfig(), { backupKeep: 2 }), prisma as never, tenant as never, builder, { send: jest.fn() } as never);
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
    expect(backup.path).toMatch(/^Backups\/Daily\/backup_\d{8}_\d{6}_[0-9a-f]{6}\.zip$/);
    expect(backup.size).toBeGreaterThan(0);
    expect(JSON.stringify([folder, deleted, backup])).not.toContain(root);
  });

  it('every backup run writes its own zip, and only the newest STORAGE_BACKUP_KEEP stay (audit P3)', async () => {
    await service.createCustomerFolder(ownCustomer);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await service.createBackup('Daily'));
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(new Set(runs.map((r) => r.path)).size).toBe(3);
    const dir = path.join(root, shopId, 'Backups', 'Daily');
    const left = (await fs.readdir(dir)).sort();
    expect(left).toHaveLength(2); // backupKeep = 2
    expect(left).toEqual(expect.arrayContaining([path.basename(runs[1].path), path.basename(runs[2].path)]));
    expect(left.some((n) => n.endsWith('.partial'))).toBe(false);
  });

  it('a backup that fails reports the failure and leaves no zip (audit P3)', async () => {
    await service.createCustomerFolder(ownCustomer);
    // The archive cannot read what it is asked to zip.
    const unreadable = path.join(root, shopId, 'Logs');
    await fs.ensureDir(unreadable);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const archiverModule = require('archiver/lib/core.js') as { prototype: { finalize: () => Promise<void> } };
    const finalize = jest.spyOn(archiverModule.prototype, 'finalize').mockImplementation(function (this: { emit: (e: string, err: Error) => void }) {
      this.emit('error', new Error('simulated archive failure'));
      return Promise.resolve();
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(service.createBackup('Daily')).rejects.toThrow('simulated archive failure');
    } finally {
      finalize.mockRestore();
    }
    const dir = path.join(root, shopId, 'Backups', 'Daily');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('an invoice document needs one of the shop invoices, sold to that customer (T6d)', async () => {
    const pdf = () => file('i.pdf', '%PDF-x', 'application/pdf');
    await expect(service.storeInvoice(ownCustomer, 'inv-foreign', pdf(), {}, undefined)).rejects.toMatchObject({ response: { code: 'STORAGE_INVOICE_NOT_FOUND' } });
    await expect(service.storeInvoice(WALK_IN_CUSTOMER_ID, 'inv-own', pdf(), {}, undefined)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.storeInvoice(ownCustomer, 'inv-walk', pdf(), {}, undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(await fs.pathExists(path.join(root, shopId, 'Customers'))).toBe(false);
    await service.storeInvoice(ownCustomer, 'inv-own', pdf(), {}, undefined);
    await service.storeInvoice(WALK_IN_CUSTOMER_ID, 'inv-walk', pdf(), {}, undefined);
  });

  it('concurrent index updates of one shop all land; a damaged index is refused, never reset (audit P3)', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => service.updateCustomerIndex({ customerId: `c${i}`, name: `C${i}` })));
    const indexPath = path.join(root, shopId, 'System', 'customer_index.json');
    expect(((await fs.readJson(indexPath)) as unknown[]).length).toBe(12);

    await fs.writeFile(indexPath, '{"not": "an array"');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(service.updateCustomerIndex({ customerId: 'c99' })).rejects.toMatchObject({ response: { code: 'STORAGE_INDEX_CORRUPT' } });
    expect(await fs.readFile(indexPath, 'utf8')).toBe('{"not": "an array"');
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
    service = new StorageService(new StorageConfig(), { customer: { findFirst: jest.fn() }, invoice: { findFirst: jest.fn(async () => ({ customerId: null })) } } as never, tenant as never, builder, { send: jest.fn() } as never);
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
  describe('cloud upload', () => {
    const cloud = (settings: Partial<StorageConfig>, send: jest.Mock) => {
      const tenant = { getShopId: () => shopId, getUserId: () => 'user-1' };
      const builder = new StoragePathBuilder(Object.assign(new StorageConfig(), { storageRoot: root }));
      return new StorageService(Object.assign(new StorageConfig(), settings), {} as never, tenant as never, builder, { send } as never);
    };
    const pdf = () => file('c.pdf', '%PDF-1.7', 'application/pdf');

    it('a missing or template bucket or key is 503 CLOUD_STORAGE_NOT_CONFIGURED and nothing leaves the server', async () => {
      const send = jest.fn();
      for (const settings of [{}, { s3Bucket: 'your_bucket', s3AccessKey: 'AKIA1', s3SecretKey: 'secret' }, { s3Bucket: 'real-bucket', s3AccessKey: 'your_access_key', s3SecretKey: 'secret' }]) {
        await expect(cloud(settings, send).uploadFileToCloud(pdf())).rejects.toMatchObject({ status: 503, response: { code: 'CLOUD_STORAGE_NOT_CONFIGURED' } });
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('a refusal of the store is 502 CLOUD_UPLOAD_FAILED, not an unhandled 500; a success answers the object URL under the shop', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const settings = { s3Bucket: 'real-bucket', s3AccessKey: 'AKIA1', s3SecretKey: 'secret', s3PublicUrl: 'https://cdn.test' };
      const refused = jest.fn(async () => Promise.reject(Object.assign(new Error('The AWS Access Key Id you provided does not exist'), { name: 'InvalidAccessKeyId' })));
      await expect(cloud(settings, refused).uploadFileToCloud(pdf())).rejects.toMatchObject({ status: 502, response: { code: 'CLOUD_UPLOAD_FAILED' } });
      const url = await cloud(settings, jest.fn(async () => ({}))).uploadFileToCloud(pdf(), 'general');
      expect(url).toMatch(new RegExp(`^https://cdn\\.test/${shopId}/general/c-[0-9a-f]{16}\\.pdf$`));
    });
  });
});
