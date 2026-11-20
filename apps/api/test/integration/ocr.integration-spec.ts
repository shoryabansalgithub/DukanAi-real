/**
 * Roadmap 4.4: `POST /ocr/scan-bill` over HTTP against the real database with
 * the Gemini call stubbed. The route must enforce roles, the image-only
 * upload filter, the size cap and the magic-byte check, send the key in a
 * header with the sniffed mimetype, and match the read lines to this shop's
 * products only, without the PostgreSQL-only `mode` filter that made every
 * lookup a 500 on MySQL.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AiConfig } from '../../src/config/domains/ai.config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bearerToken, cashierOf, ownerOf } from '../security/security-fixtures';
import { bootApp, createProduct, createShop, tenantRunner, TestShop } from './pos-fixtures';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128, 7)]);
const PDF_BYTES = Buffer.from('%PDF-1.4 pretending to be a picture');
const TEST_KEY = 'AIzaSy-integration-test-key-0000000000';

type FetchCall = { url: string; init: RequestInit };

describe('OCR scan-bill (roadmap 4.4)', () => {
  let app: INestApplication;
  let A: TestShop;
  let B: TestShop;
  let ownerAuth: string;
  let cashierAuth: string;
  let maggiA: string;
  const originalFetch = global.fetch;
  const calls: FetchCall[] = [];
  let answers: Array<{ status: number; text: string }> = [];

  const scan = (auth: string) => request(app.getHttpServer()).post('/api/ocr/scan-bill').set('Authorization', auth);
  const code = (res: { body: { code?: string; error?: { code?: string } } }) => res.body.code ?? res.body.error?.code;

  beforeAll(async () => {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith('https://generativelanguage.googleapis.com/')) return originalFetch(input as never, init);
      calls.push({ url, init: init ?? {} });
      const next = answers.shift() ?? { status: 200, text: '[]' };
      return new Response(next.status < 400 ? JSON.stringify({ candidates: [{ content: { parts: [{ text: next.text }] } }] }) : next.text, {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    app = await bootApp((b) => b.overrideProvider(AiConfig).useValue({ geminiApiKey: TEST_KEY }));
    A = await createShop(app, 'ocrA');
    B = await createShop(app, 'ocrB');
    ownerAuth = `Bearer ${await bearerToken(app, A, ownerOf(A))}`;
    cashierAuth = `Bearer ${await bearerToken(app, A, cashierOf(A))}`;
    // The fixture suffixes names for uniqueness; the catalogue names must read like a real shop's.
    const run = tenantRunner(app);
    const prisma = app.get(PrismaService);
    const named = async (shop: TestShop, key: string, name: string, sellingPrice: number) => {
      const id = await createProduct(app, shop, { key, sellingPrice });
      await run.system(() => prisma.product.update({ where: { id }, data: { name } }));
      return id;
    };
    maggiA = await named(A, 'maggi', 'Maggi Noodles', 14);
    await named(A, 'parle', 'Parle-G Biscuits Family Pack', 10);
    await named(B, 'maggi', 'Maggi Noodles', 99);
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await app?.close();
  });

  beforeEach(() => {
    calls.length = 0;
    answers = [];
  });

  it('is MANAGER+ only', async () => {
    expect((await scan(cashierAuth).attach('file', PNG, { filename: 'bill.png', contentType: 'image/png' })).status).toBe(403);
    expect((await request(app.getHttpServer()).post('/api/ocr/scan-bill').attach('file', PNG, { filename: 'bill.png', contentType: 'image/png' })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('accepts only images: declared type, extension, bytes and size are all checked', async () => {
    const missing = await scan(ownerAuth).field('documentType', 'BILL');
    expect(missing.status).toBe(400);
    expect(code(missing)).toBe('OCR_FILE_MISSING');

    const text = await scan(ownerAuth).attach('file', Buffer.from('hello'), { filename: 'bill.txt', contentType: 'text/plain' });
    expect(text.status).toBe(400);
    expect(code(text)).toBe('OCR_UNSUPPORTED_IMAGE');

    const renamed = await scan(ownerAuth).attach('file', PDF_BYTES, { filename: 'bill.png', contentType: 'image/png' });
    expect(renamed.status).toBe(400);
    expect(code(renamed)).toBe('OCR_UNSUPPORTED_IMAGE');

    const tooBig = await scan(ownerAuth).attach('file', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), { filename: 'huge.png', contentType: 'image/png' });
    expect(tooBig.status).toBe(413);

    const badType = await scan(ownerAuth).field('documentType', 'POEM').attach('file', PNG, { filename: 'bill.png', contentType: 'image/png' });
    expect(badType.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('sends the key in a header with the sniffed mimetype and matches the lines to this shop only', async () => {
    answers = [{ status: 200, text: '```json\n[{"rawName": "maggi noodles", "qty": 2, "price": 14}, {"rawName": "Parle G Biscuit", "qty": 1, "price": 10}, {"rawName": "Unknown thing", "qty": 1}]\n```' }];
    const res = await scan(ownerAuth).field('documentType', 'RECEIPT').attach('file', PNG, { filename: 'bill.png', contentType: 'image/png' });
    expect(res.status).toBe(201);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    expect(calls[0].url).not.toContain(TEST_KEY);
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe(TEST_KEY);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/png');

    expect(res.body.success).toBe(true);
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.documentType).toBe('RECEIPT');
    expect(res.body.preview.parsedData.items).toHaveLength(3);
    const [maggi, parle, unknown] = res.body.preview.matchedItems;
    expect(maggi).toMatchObject({ rawName: 'maggi noodles', qty: 2, price: 14, matchedSku: maggiA, matchedName: 'Maggi Noodles', dbPrice: 14, confidence: 1 });
    // "Parle G Biscuit" vs "Parle-G Biscuits Family Pack" is below the strict test threshold (0.85): reported, not matched.
    expect(parle.matchedSku).toBeNull();
    expect(parle.confidence).toBeGreaterThan(0);
    expect(unknown).toMatchObject({ matchedSku: null, matchedName: null, dbPrice: null, confidence: 0 });
  });

  it('survives a transient model error, and reports an unreadable answer as 502 rather than an empty success', async () => {
    answers = [{ status: 503, text: 'busy' }, { status: 200, text: '[]' }];
    const ok = await scan(ownerAuth).attach('file', PNG, { filename: 'bill.png', contentType: 'image/png' });
    expect(ok.status).toBe(201);
    expect(ok.body.preview.matchedItems).toEqual([]);
    expect(calls).toHaveLength(2);

    answers = [{ status: 200, text: 'Sorry, I cannot read this image.' }];
    const unreadable = await scan(ownerAuth).attach('file', PNG, { filename: 'bill.png', contentType: 'image/png' });
    expect(unreadable.status).toBe(502);
    expect(code(unreadable)).toBe('OCR_UNREADABLE_RESPONSE');
  });
});
