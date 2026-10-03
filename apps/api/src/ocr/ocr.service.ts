import { BadGatewayException, BadRequestException, Injectable, Logger, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiConfig } from '../config/domains/ai.config';
import { OcrFeatureConfig } from '../config/domains/features/ocr-feature.config';
import { isPlaceholderValue } from '../config/validation/env-rules';
import { sniffImageMimeType } from './ocr-upload';

/** One line the model read off the bill, normalised. */
export interface OcrLineItem {
  rawName: string;
  qty: number;
  price: number | null;
}

/** A line item with the shop product it was matched to, if any. */
export interface OcrMatchedItem extends OcrLineItem {
  matchedSku: string | null;
  matchedName: string | null;
  matchedProductSku: string | null;
  dbPrice: number | null;
  /** Dice similarity (0..1) between the read name and the matched product name; 0 when nothing was found. */
  confidence: number;
}

export interface OcrScanResult {
  success: true;
  message: string;
  documentType: string;
  mimeType: string;
  preview: {
    parsedData: { items: OcrLineItem[] };
    matchedItems: OcrMatchedItem[];
  };
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_KEYWORDS = 4;
const CANDIDATES_PER_ITEM = 5;
const LOOKUP_CONCURRENCY = 4;
const MAX_NAME_LENGTH = 200;

/**
 * Bill OCR (roadmap 4.4, audit F9): the image goes to Gemini with its real
 * mimetype and the API key in a header, the answer is parsed strictly (an
 * unreadable answer is a 502, not an empty success), and each line is
 * matched against the shop's catalogue with bounded, case-insensitive
 * lookups (MySQL's collation already ignores case; Prisma's `mode` is a
 * PostgreSQL-only option that made every lookup a 500 here).
 */
@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfig,
    private readonly ocrConfig: OcrFeatureConfig,
  ) {}

  /** True when a real Gemini key is configured (a template placeholder does not count). */
  get isConfigured(): boolean {
    const key = this.aiConfig.geminiApiKey;
    return typeof key === 'string' && key.trim() !== '' && !isPlaceholderValue(key);
  }

  async processDocument(shopId: string, fileBuffer: Buffer, documentType: string): Promise<OcrScanResult> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException({ message: 'Bill scanning is not configured on this server (GEMINI_API_KEY).', code: 'OCR_NOT_CONFIGURED' });
    }
    if (fileBuffer.length > this.ocrConfig.maxImageBytes) {
      throw new PayloadTooLargeException({ message: `Image exceeds the ${this.ocrConfig.maxImageBytes} byte limit.`, code: 'OCR_IMAGE_TOO_LARGE' });
    }
    const mimeType = sniffImageMimeType(fileBuffer);
    if (!mimeType) {
      throw new BadRequestException({ message: 'The file is not a JPEG, PNG or WebP image.', code: 'OCR_UNSUPPORTED_IMAGE' });
    }

    this.logger.log(`OCR ${documentType} (${mimeType}, ${fileBuffer.length} bytes) for shop ${shopId}`);
    const items = await this.parseWithGemini(fileBuffer, mimeType, documentType);
    const matchedItems = await this.matchProducts(shopId, items);

    return {
      success: true,
      message: items.length === 0 ? 'No line items were found on the document' : 'Document parsed and matched against the catalogue',
      documentType,
      mimeType,
      preview: { parsedData: { items }, matchedItems },
    };
  }

  private buildPrompt(documentType: string): string {
    return `Analyze this ${documentType.toLowerCase()} (handwritten or printed).
Extract every line item. Return ONLY a JSON array of objects with exactly these keys:
- rawName: string (the item name as written)
- qty: number (quantity; 1 when not written)
- price: number (price per unit; null when not written)
Example: [{"rawName": "Maggi Noodles", "qty": 2, "price": 14.50}]`;
  }

  /** One Gemini call with retries on transient failures; returns the normalised line items. */
  private async parseWithGemini(image: Buffer, mimeType: string, documentType: string): Promise<OcrLineItem[]> {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: this.buildPrompt(documentType) }, { inlineData: { mimeType, data: image.toString('base64') } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(this.ocrConfig.model)}:generateContent`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.ocrConfig.timeoutMs);
      let response: Response;
      try {
        // The key travels in a header (never in the URL, where proxies and logs keep it).
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.aiConfig.geminiApiKey as string },
          body: payload,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        const timedOut = (error as { name?: string })?.name === 'AbortError';
        if (attempt < MAX_RETRIES) {
          this.logger.warn(`Gemini ${timedOut ? 'timed out' : 'unreachable'}; retrying (attempt ${attempt}/${MAX_RETRIES})`);
          await this.backoff(attempt);
          continue;
        }
        this.logger.error(`Gemini ${timedOut ? 'timed out' : 'unreachable'} after ${MAX_RETRIES} attempts`);
        throw new BadGatewayException({ message: 'The OCR model could not be reached.', code: timedOut ? 'OCR_TIMEOUT' : 'OCR_UNREACHABLE' });
      }
      clearTimeout(timeout);

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          this.logger.warn(`Gemini answered ${response.status}; retrying (attempt ${attempt}/${MAX_RETRIES})`);
          await this.backoff(attempt);
          continue;
        }
        this.logger.error(`Gemini answered ${response.status}: ${detail}`);
        throw new BadGatewayException({ message: 'The OCR model rejected the request.', code: 'OCR_MODEL_ERROR', details: { status: response.status } });
      }

      const body = (await response.json().catch(() => null)) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return this.parseItems(text);
    }
    throw new BadGatewayException({ message: 'The OCR model could not be reached.', code: 'OCR_UNREACHABLE' });
  }

  private backoff(attempt: number): Promise<void> {
    const delay = Math.pow(2, attempt) * (this.ocrConfig.backoffMs / 2);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** Strict parse of the model's answer: a JSON array of items, at most `maxItems`, each with a usable name. */
  parseItems(text: string): OcrLineItem[] {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned || 'null');
    } catch {
      this.logger.error(`Unreadable OCR answer: ${cleaned.slice(0, 200)}`);
      throw new BadGatewayException({ message: 'The OCR model returned an unreadable answer; try again.', code: 'OCR_UNREADABLE_RESPONSE' });
    }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : null;
    if (!list) {
      throw new BadGatewayException({ message: 'The OCR model returned an unreadable answer; try again.', code: 'OCR_UNREADABLE_RESPONSE' });
    }
    const items: OcrLineItem[] = [];
    for (const entry of list) {
      if (items.length >= this.ocrConfig.maxItems) break;
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as { rawName?: unknown; name?: unknown; qty?: unknown; quantity?: unknown; price?: unknown };
      const name = String(raw.rawName ?? raw.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
      if (!name) continue;
      const qty = toNonNegativeNumber(raw.qty ?? raw.quantity);
      const price = toNonNegativeNumber(raw.price);
      items.push({ rawName: name, qty: qty ?? 1, price });
    }
    return items;
  }

  /**
   * Matches each line to the shop's live catalogue: up to four keywords of the
   * read name narrow the candidates (case-insensitive by collation, five per
   * line), and the best Dice similarity decides, against `OCR_FUZZY_MATCH_THRESHOLD`.
   * Lookups run a few at a time, never one query per item all at once.
   */
  async matchProducts(shopId: string, items: OcrLineItem[]): Promise<OcrMatchedItem[]> {
    return mapWithConcurrency(items, LOOKUP_CONCURRENCY, async (item) => {
      const keywords = keywordsOf(item.rawName);
      const candidates = await this.prisma.product.findMany({
        where: {
          shopId,
          isDeleted: false,
          isActive: true,
          ...(keywords.length > 0 ? { AND: keywords.map((kw) => ({ name: { contains: kw } })) } : { name: { contains: item.rawName } }),
        },
        select: { id: true, name: true, sku: true, sellingPrice: true },
        orderBy: { name: 'asc' },
        take: CANDIDATES_PER_ITEM,
      });

      let best: { product: (typeof candidates)[number]; score: number } | null = null;
      for (const product of candidates) {
        const score = diceSimilarity(item.rawName, product.name);
        if (!best || score > best.score) best = { product, score };
      }
      if (best && best.score >= this.ocrConfig.fuzzyMatchThreshold) {
        return {
          ...item,
          matchedSku: best.product.id,
          matchedName: best.product.name,
          matchedProductSku: best.product.sku,
          dbPrice: Number(best.product.sellingPrice),
          confidence: round2(best.score),
        };
      }
      return { ...item, matchedSku: null, matchedName: null, matchedProductSku: null, dbPrice: null, confidence: best ? round2(best.score) : 0 };
    });
  }
}

function toNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Words of three letters or more, lower-cased, at most `MAX_KEYWORDS`, longest first. */
export function keywordsOf(name: string): string[] {
  return [...new Set(name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS);
}

/** Sørensen–Dice coefficient over character bigrams of the lower-cased, whitespace-normalised strings. */
export function diceSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const [gram, count] of x) shared += Math.min(count, y.get(gram) ?? 0);
  const total = [...x.values()].reduce((s, c) => s + c, 0) + [...y.values()].reduce((s, c) => s + c, 0);
  return (2 * shared) / total;
}

function bigrams(s: string): Map<string, number> {
  const normalised = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const map = new Map<string, number>();
  for (let i = 0; i + 1 < normalised.length; i++) {
    const g = normalised.slice(i, i + 2);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return map;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
