import { compactFinancialYear, GST_DOCUMENT_NUMBER_MAX_LENGTH, InvoiceNumberService, isGstDocumentNumber, posDocumentPrefix } from './invoice-number.service';

/** CGST Rule 46(b) / 53(1A): at most 16 characters of letters, digits, '-' and '/' (roadmap 9.24). */
describe('POS document numbers (GST serial number rule)', () => {
  it('compacts the financial year to four characters', () => {
    expect(compactFinancialYear('2026-27')).toBe('2627');
    expect(compactFinancialYear('2099-00')).toBe('9900');
    expect(() => compactFinancialYear('2026')).toThrow();
  });

  it('the largest number of every series fits the rule', () => {
    for (const kind of ['INV', 'RET'] as const) {
      const largest = `${posDocumentPrefix(kind, '2026-27')}999999`;
      expect(largest).toBe(`${kind}-2627-999999`);
      expect(largest.length).toBeLessThanOrEqual(GST_DOCUMENT_NUMBER_MAX_LENGTH);
      expect(isGstDocumentNumber(largest)).toBe(true);
    }
  });

  it('refuses what the rule refuses (the pre-9.24 format, other characters)', () => {
    expect(isGstDocumentNumber('INV-2026-27-000001')).toBe(false); // 18 characters
    expect(isGstDocumentNumber('INV 2627 000001')).toBe(false);
    expect(isGstDocumentNumber('INV/2627/000001')).toBe(true);
  });

  it('issues from the per-shop sequence under the compact prefix and checks the result', async () => {
    const next = jest.fn(async (_tx: unknown, _shop: string, _type: string, prefix: string, pad: number) => ({ number: `${prefix}${'1'.padStart(pad, '0')}`, sequence: 1 }));
    const service = new InvoiceNumberService({ next } as never);
    await expect(service.next({} as never, 'shop', 'POS_RETURN', '2026-27')).resolves.toEqual({ number: 'RET-2627-000001', sequence: 1 });
    expect(next).toHaveBeenCalledWith({}, 'shop', 'POS_RETURN', 'RET-2627-', 6);

    next.mockResolvedValueOnce({ number: 'INV-2627-10000000', sequence: 10_000_000 });
    await expect(service.next({} as never, 'shop', 'POS_INVOICE', '2026-27')).rejects.toThrow(/Rule 46/);
  });
});
