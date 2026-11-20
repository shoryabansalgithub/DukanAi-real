/**
 * Roadmap 5.1 / 5.2: every multipart route has a hard size cap (413), a
 * declared-type filter (400 before a byte is stored), a magic-byte check on
 * the stored bytes (400, the temp file discarded), and roles; a variant
 * matrix is bounded before it is expanded.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UploadConfig } from '../../src/config/domains/upload.config';
import { ProductVariantsService } from '../../src/product-variants/product-variants.service';
import { bootApp, createProduct, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { bearerToken, createUser, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PDF_HEADER = Buffer.from('%PDF-1.7\n%âãÏÓ\n');
const png = (bytes: number) => Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, bytes - PNG_HEADER.length), 0x2a)]);
const pdf = (bytes: number) => Buffer.concat([PDF_HEADER, Buffer.alloc(Math.max(0, bytes - PDF_HEADER.length), 0x20)]);
const csv = (rows: number) => Buffer.from(['sku,name,sellingPrice,costPrice', ...Array.from({ length: rows }, (_, i) => `IMP-${i},Item ${i},100,60`)].join('\n'));

const MEDIA_CAP = 64 * 1024;
const IMPORT_CAP = 8 * 1024;

describe('Upload limits and variant matrix (roadmap 5.1 / 5.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let ownerToken: string;
  let productId: string;
  const tempDir = path.resolve(process.cwd(), 'uploads', 'tmp-upload-spec');
  const tempFiles = () => (fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : []);

  const upload = (url: string, field: string, body: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) => {
    let req = request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${ownerToken}`);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach(field, body, { filename, contentType });
  };

  beforeAll(async () => {
    const uploadConfig = Object.assign(new UploadConfig(), { maxMediaBytes: MEDIA_CAP, maxImportBytes: IMPORT_CAP, tempDir: 'uploads/tmp-upload-spec' });
    app = await bootApp((b) => b.overrideProvider(UploadConfig).useValue(uploadConfig));
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'upl');
    ownerToken = await bearerToken(app, A, ownerOf(A));
    productId = await createProduct(app, A, { key: 'UPL' });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('product media', () => {
    it('a file over the cap is refused with 413 and nothing stays in the temp directory', async () => {
      const res = await upload(`/api/media/upload/product/${productId}`, 'file', png(MEDIA_CAP + 1), 'big.png', 'image/png');
      expect(res.status).toBe(413);
      expect(tempFiles()).toEqual([]);
      expect(await run.system(() => prisma.mediaAsset.count({ where: { shopId: A.shopId } }))).toBe(0);
    });

    it('a declared type or extension outside the allow-list is refused before any byte is stored', async () => {
      const exe = await upload(`/api/media/upload/product/${productId}`, 'file', Buffer.from('MZ\u0090\u0000'), 'setup.exe', 'application/x-msdownload');
      expect(exe.status).toBe(400);
      expect(exe.body.code).toBe('MEDIA_UNSUPPORTED_FILE');
      const svg = await upload(`/api/media/upload/product/${productId}`, 'file', Buffer.from('<svg onload="alert(1)"/>'), 'logo.svg', 'image/svg+xml');
      expect(svg.status).toBe(400);
      const badExt = await upload(`/api/media/upload/product/${productId}`, 'file', png(1024), 'photo.png.exe', 'image/png');
      expect(badExt.status).toBe(400);
      expect(tempFiles()).toEqual([]);
    });

    it('bytes that do not match the declared type are refused and the stored temp file is discarded', async () => {
      const res = await upload(`/api/media/upload/product/${productId}`, 'file', pdf(2048), 'renamed.png', 'image/png');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MEDIA_UNSUPPORTED_FILE');
      expect(res.body.message).toContain('application/pdf');
      expect(tempFiles()).toEqual([]);
      expect(await run.system(() => prisma.mediaAsset.count({ where: { shopId: A.shopId } }))).toBe(0);
    });

    it('a genuine image within the cap streams through the temp directory and is stored once', async () => {
      const res = await upload(`/api/media/upload/product/${productId}`, 'file', png(MEDIA_CAP - 100), 'photo.png', 'image/png', { isPrimary: 'true' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ mimeType: 'image/png', sizeBytes: MEDIA_CAP - 100 });
      expect(tempFiles()).toEqual([]);
      const again = await upload(`/api/media/upload/product/${productId}`, 'file', png(MEDIA_CAP - 100), 'photo-copy.png', 'image/png');
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(res.body.id); // deduplicated by content hash
      expect(tempFiles()).toEqual([]);
      expect(await run.system(() => prisma.mediaAsset.count({ where: { shopId: A.shopId } }))).toBe(1);
    });

    it('a temp file never outlives a request that fails outside the handler: foreign product (404) and a bad body field (400)', async () => {
      const foreign = await request(app.getHttpServer())
        .post('/api/media/upload/product/does-not-exist')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', png(4096), { filename: 'x.png', contentType: 'image/png' });
      expect(foreign.status).toBe(404);
      const badField = await upload(`/api/media/upload/product/${productId}`, 'file', png(4096), 'x.png', 'image/png', { unknownField: 'yes' });
      expect(badField.status).toBe(400);
      await new Promise((r) => setTimeout(r, 50));
      expect(tempFiles()).toEqual([]);
    });

    it('a VIEWER cannot upload', async () => {
      const viewer = await bearerToken(app, A, await createUser(app, A, Role.VIEWER));
      const res = await request(app.getHttpServer()).post(`/api/media/upload/product/${productId}`).set('Authorization', `Bearer ${viewer}`).attach('file', png(1024), { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(403);
      expect(tempFiles()).toEqual([]);
    });
  });

  describe('product imports', () => {
    it('a file over the cap is refused with 413', async () => {
      const res = await upload('/api/imports/products/upload', 'file', csv(2000), 'products.csv', 'text/csv', { mode: 'UPSERT' });
      expect(res.status).toBe(413);
      expect(tempFiles()).toEqual([]);
    });

    it('only CSV and JSON pass the filter; binary content named .csv is refused and discarded', async () => {
      const xlsx = await upload('/api/imports/products/upload', 'file', Buffer.from('PK\u0003\u0004'), 'products.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { mode: 'UPSERT' });
      expect(xlsx.status).toBe(400);
      expect(xlsx.body.code).toBe('IMPORT_UNSUPPORTED_FILE');
      const binary = await upload('/api/imports/products/upload', 'file', png(512), 'products.csv', 'text/csv', { mode: 'UPSERT' });
      expect(binary.status).toBe(400);
      expect(binary.body.code).toBe('IMPORT_UNSUPPORTED_FILE');
      const notJson = await upload('/api/imports/products/upload', 'file', Buffer.from('sku,name\nA,B\n'), 'products.json', 'application/json', { mode: 'UPSERT' });
      expect(notJson.status).toBe(400);
      expect(tempFiles()).toEqual([]);
      expect(await run.system(() => prisma.importJob.count({ where: { shopId: A.shopId } }))).toBe(0);
    });

    it('an import whose body fails validation is refused with 400 and its temp file discarded', async () => {
      const res = await upload('/api/imports/products/upload', 'file', csv(3), 'ok.csv', 'text/csv', { mode: 'BOGUS' });
      expect(res.status).toBe(400);
      await new Promise((r) => setTimeout(r, 50));
      expect(tempFiles()).toEqual([]);
    });

    it('a readable CSV (with a byte-order mark) and a JSON array are accepted and moved out of the temp directory', async () => {
      const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv(3)]);
      const res = await upload('/api/imports/products/upload', 'file', withBom, 'products.csv', 'application/vnd.ms-excel', { mode: 'UPSERT' });
      expect(res.status).toBe(201);
      const job = await run.system(() => prisma.importJob.findUniqueOrThrow({ where: { id: res.body.jobId } }));
      expect(job.format).toBe('CSV');
      expect(fs.existsSync(job.fileUrl)).toBe(true);
      expect(path.basename(job.fileUrl)).toMatch(new RegExp(`^${A.shopId}-[0-9a-f-]{36}\\.csv$`));
      const json = await upload('/api/imports/products/upload', 'file', Buffer.from('[{"sku":"J1","name":"Json item","sellingPrice":10,"costPrice":5}]'), 'products.json', 'application/json', { mode: 'UPSERT' });
      expect(json.status).toBe(201);
      expect(tempFiles()).toEqual([]);
    });
  });

  describe('storage documents', () => {
    it('a bill image whose bytes are a PDF is refused before anything is written', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/storage/bills/${A.customerId}/bill-1`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('image', pdf(1024), { filename: 'bill.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STORAGE_CONTENT_MISMATCH');
    });

    it('a document over the storage cap is refused with 413', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/storage/statements/${A.customerId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('pdf', pdf(10 * 1024 * 1024 + 1), { filename: 'statement.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(413);
    });
  });

  describe('variant matrix', () => {
    const values = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

    it('a matrix past 1,000 combinations is refused at the DTO in constant time', async () => {
      const started = Date.now();
      const res = await request(app.getHttpServer())
        .post(`/api/products/${productId}/variants/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attributes: Object.fromEntries(values(8, 'attr').map((name) => [name, values(100, 'v')])) });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain('at most 1000');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await run.system(() => prisma.productVariant.count({ where: { productId } }))).toBe(0);
    });

    it('malformed matrices are refused with 400, never 500', async () => {
      for (const attributes of [{}, [], 'x', { Colour: [] }, { Colour: ['Red', 1] }, { Colour: ['Red', 'red'] }]) {
        const res = await request(app.getHttpServer()).post(`/api/products/${productId}/variants/generate`).set('Authorization', `Bearer ${ownerToken}`).send({ attributes });
        expect(res.status).toBe(400);
      }
    });

    it('the service refuses an oversized matrix even when called directly', async () => {
      const service = app.get(ProductVariantsService);
      const attributes = Object.fromEntries(values(4, 'a').map((name) => [name, values(10, 'v')])); // 10,000
      await expect(run.as(A.shopId, A.ownerId, Role.OWNER, () => service.generateVariants(productId, attributes))).rejects.toMatchObject({ response: { code: 'VARIANT_MATRIX_TOO_LARGE' } });
    });

    it('a bounded matrix is generated', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/products/${productId}/variants/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ attributes: { Colour: ['Red', 'Blue'], Size: ['Small', 'Medium', 'Large'] } });
      expect(res.status).toBe(201);
      expect(await run.system(() => prisma.productVariant.count({ where: { productId, isDeleted: false } }))).toBe(6);
    });
  });
});
