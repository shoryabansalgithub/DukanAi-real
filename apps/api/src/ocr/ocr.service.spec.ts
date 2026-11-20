import { BadGatewayException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { OcrFeatureConfig } from '../config/domains/features/ocr-feature.config';
import { diceSimilarity, keywordsOf, mapWithConcurrency, OcrService } from './ocr.service';
import { sniffImageMimeType } from './ocr-upload';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4 not an image');

function geminiAnswer(text: string, status = 200) {
  return { ok: status < 400, status, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text };
}

describe('OcrService (roadmap 4.4)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let findMany: jest.Mock;
  let config: OcrFeatureConfig;
  let service: OcrService;

  /** `null` means "no key at all" (an explicit `undefined` would re-apply the default). */
  const build = (apiKey: string | null = 'AIzaSy-real-looking-key-000000000000') => {
    config = new OcrFeatureConfig();
    config.backoffMs = 0;
    findMany = jest.fn().mockResolvedValue([]);
    service = new OcrService({ product: { findMany } } as never, { geminiApiKey: apiKey ?? undefined } as never, config);
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    build();
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('configuration and input', () => {
    it('answers 503 OCR_NOT_CONFIGURED without calling the model when the key is missing or a template placeholder', async () => {
      for (const key of [null, '', '   ', 'your_gemini_api_key', '___REPLACE_ME_IN_PRODUCTION___']) {
        build(key);
        await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ constructor: ServiceUnavailableException, response: { code: 'OCR_NOT_CONFIGURED' } });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses bytes that are not a JPEG, PNG or WebP image whatever the client declared', async () => {
      await expect(service.processDocument('shop-1', PDF, 'BILL')).rejects.toMatchObject({ constructor: BadRequestException, response: { code: 'OCR_UNSUPPORTED_IMAGE' } });
      await expect(service.processDocument('shop-1', Buffer.alloc(0), 'BILL')).rejects.toMatchObject({ response: { code: 'OCR_UNSUPPORTED_IMAGE' } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sniffImageMimeType(PNG)).toBe('image/png');
      expect(sniffImageMimeType(JPEG)).toBe('image/jpeg');
      expect(sniffImageMimeType(WEBP)).toBe('image/webp');
      expect(sniffImageMimeType(PDF)).toBeNull();
    });

    it('refuses an image over the configured size before calling the model', async () => {
      config.maxImageBytes = 64 * 1024;
      await expect(service.processDocument('shop-1', Buffer.concat([JPEG, Buffer.alloc(64 * 1024)]), 'BILL')).rejects.toMatchObject({ response: { code: 'OCR_IMAGE_TOO_LARGE' } });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('the Gemini call', () => {
    it('sends the key in x-goog-api-key (never the URL), the sniffed mimetype and a JSON response request', async () => {
      fetchMock.mockResolvedValue(geminiAnswer('```json\n[{"rawName": "Maggi Noodles", "qty": 2, "price": "14.50"}]\n```'));
      const result = await service.processDocument('shop-1', JPEG, 'RECEIPT');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
      expect(url).not.toContain('key=');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaSy-real-looking-key-000000000000');
      const body = JSON.parse(init.body as string);
      expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
      expect(body.contents[0].parts[1].inlineData.data).toBe(JPEG.toString('base64'));
      expect(body.contents[0].parts[0].text).toContain('receipt');
      expect(body.generationConfig.responseMimeType).toBe('application/json');

      expect(result.mimeType).toBe('image/jpeg');
      expect(result.preview.parsedData.items).toEqual([{ rawName: 'Maggi Noodles', qty: 2, price: 14.5 }]);
    });

    it('uses the configured model name', async () => {
      config.model = 'gemini-2.5-flash';
      fetchMock.mockResolvedValue(geminiAnswer('[]'));
      await service.processDocument('shop-1', PNG, 'BILL');
      expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/models/gemini-2.5-flash:generateContent');
    });

    it('retries a transient status and then succeeds; a client error is a 502 without retry', async () => {
      fetchMock.mockResolvedValueOnce(geminiAnswer('busy', 503)).mockResolvedValueOnce(geminiAnswer('[]'));
      const ok = await service.processDocument('shop-1', PNG, 'BILL');
      expect(ok.preview.parsedData.items).toEqual([]);
      expect(ok.message).toMatch(/No line items/);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(geminiAnswer('bad key', 400));
      await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ constructor: BadGatewayException, response: { code: 'OCR_MODEL_ERROR', details: { status: 400 } } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after three unreachable attempts with 502 OCR_UNREACHABLE (timeouts are OCR_TIMEOUT)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ response: { code: 'OCR_UNREACHABLE' } });
      expect(fetchMock).toHaveBeenCalledTimes(3);

      fetchMock.mockReset();
      fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ response: { code: 'OCR_TIMEOUT' } });
    });

    it('the whole call ends within OCR_TOTAL_TIMEOUT_MS: the budget cuts an attempt, and no retry starts that cannot fit (roadmap 9.19)', async () => {
      // A model that never answers: the per-attempt timeout (30 s) is longer than the whole budget.
      config.timeoutMs = 30_000;
      config.totalTimeoutMs = 300;
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      );
      const started = Date.now();
      await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ constructor: BadGatewayException, response: { code: 'OCR_TIMEOUT' } });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A busy model (503) with a backoff that would outlast the budget: answered at once, not after the wait.
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(geminiAnswer('overloaded', 503));
      config.backoffMs = 10_000;
      config.totalTimeoutMs = 5_000;
      const busy = Date.now();
      await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ response: { code: 'OCR_MODEL_ERROR', details: { status: 503 } } });
      expect(Date.now() - busy).toBeLessThan(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an unreadable answer is a 502, never a successful empty scan', async () => {
      for (const text of ['not json at all', '{"foo": 1}', '']) {
        fetchMock.mockResolvedValue(geminiAnswer(text));
        await expect(service.processDocument('shop-1', PNG, 'BILL')).rejects.toMatchObject({ constructor: BadGatewayException, response: { code: 'OCR_UNREADABLE_RESPONSE' } });
      }
    });
  });

  describe('parseItems', () => {
    it('normalises names, quantities and prices, drops nameless entries and caps the list', () => {
      config.maxItems = 2;
      const items = service.parseItems(
        JSON.stringify([
          { rawName: '  Maggi   Noodles ', qty: '2', price: '₹14.50' },
          { name: 'Parle-G', quantity: -1, price: null },
          { qty: 3, price: 10 },
          { rawName: 'Third item', qty: 1, price: 1 },
        ]),
      );
      expect(items).toEqual([
        { rawName: 'Maggi Noodles', qty: 2, price: 14.5 },
        { rawName: 'Parle-G', qty: 1, price: null },
      ]);
      expect(service.parseItems('{"items": [{"rawName": "Wrapped", "qty": 1}]}')).toEqual([{ rawName: 'Wrapped', qty: 1, price: null }]);
      expect(service.parseItems('x'.repeat(0) + JSON.stringify([{ rawName: 'a'.repeat(500) }]))[0].rawName).toHaveLength(200);
    });
  });

  describe('matchProducts', () => {
    it('narrows by keywords without the PostgreSQL-only mode option, bounded per line, and picks the best similarity above the threshold', async () => {
      findMany.mockResolvedValue([
        { id: 'p-1', name: 'Maggi Masala Noodles 70g', sku: 'MAG-70', sellingPrice: 14 },
        { id: 'p-2', name: 'Maggi Noodles', sku: 'MAG-1', sellingPrice: 12 },
      ]);
      const [match] = await service.matchProducts('shop-1', [{ rawName: 'maggi noodles', qty: 1, price: 14 }]);

      expect(findMany).toHaveBeenCalledTimes(1);
      const args = findMany.mock.calls[0][0];
      expect(args.take).toBe(5);
      expect(args.where.shopId).toBe('shop-1');
      expect(args.where.AND).toEqual([{ name: { contains: 'noodles' } }, { name: { contains: 'maggi' } }]);
      expect(JSON.stringify(args)).not.toContain('insensitive');
      expect(match).toMatchObject({ matchedSku: 'p-2', matchedName: 'Maggi Noodles', matchedProductSku: 'MAG-1', dbPrice: 12, confidence: 1 });
    });

    it('leaves a line unmatched below the threshold, reporting the best similarity, and 0 with no candidate', async () => {
      config.fuzzyMatchThreshold = 0.9;
      findMany.mockResolvedValueOnce([{ id: 'p-1', name: 'Maggi Masala Noodles 70g', sku: 'MAG-70', sellingPrice: 14 }]).mockResolvedValueOnce([]);
      const [weak, none] = await service.matchProducts('shop-1', [
        { rawName: 'Maggi', qty: 1, price: null },
        { rawName: 'Unknown thing', qty: 1, price: null },
      ]);
      expect(weak.matchedSku).toBeNull();
      expect(weak.confidence).toBeGreaterThan(0);
      expect(weak.confidence).toBeLessThan(0.9);
      expect(none).toMatchObject({ matchedSku: null, matchedName: null, dbPrice: null, confidence: 0 });
    });

    it('falls back to the whole name when no word is three letters long, and runs lookups a few at a time in order', async () => {
      await service.matchProducts('shop-1', [{ rawName: 'a b', qty: 1, price: null }]);
      expect(findMany.mock.calls[0][0].where).toMatchObject({ name: { contains: 'a b' } });

      let inFlight = 0;
      let peak = 0;
      const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return n * 2;
      });
      expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
      expect(peak).toBeLessThanOrEqual(4);
    });
  });

  describe('helpers', () => {
    it('keywordsOf keeps at most four distinct words of three letters or more, longest first', () => {
      expect(keywordsOf('Maggi 2-minute Masala Noodles noodles 70g x')).toEqual(['noodles', 'minute', 'masala', 'maggi']);
      expect(keywordsOf('ab c')).toEqual([]);
    });

    it('diceSimilarity is 1 for equal names ignoring case and spacing, 0 for nothing in common', () => {
      expect(diceSimilarity('Maggi Noodles', 'maggi   noodles')).toBe(1);
      expect(diceSimilarity('abc', 'xyz')).toBe(0);
      expect(diceSimilarity('Maggi Noodle', 'Maggi Noodles')).toBeGreaterThan(0.9);
      expect(diceSimilarity('', '')).toBe(1);
    });
  });
});
