import { GstRate, ImportKind, ProductType, ProductUnit } from '@prisma/client';
import {
  MAX_IMPORT_ROWS,
  normalizePhone,
  parseGstRate,
  parseMoney,
  parseQuantity,
  parseUnit,
  shapeRows,
  spreadsheetMangled,
  validateCustomerRow,
  validateOpeningStockRow,
  validateProductRow,
} from './import-rows';

const errorsOf = (row: { issues: Array<{ field?: string; severity: string }> }) => row.issues.filter((i) => i.severity === 'error').map((i) => i.field);
const warningsOf = (row: { issues: Array<{ field?: string; severity: string }> }) => row.issues.filter((i) => i.severity === 'warning').map((i) => i.field);

describe('onboarding import rows (roadmap 9.20)', () => {
  describe('the file', () => {
    it('maps headers whatever their spelling, numbers rows as the spreadsheet does and drops blank lines', () => {
      const shaped = shapeRows(ImportKind.PRODUCTS, [
        { 'Item Code': ' A1 ', 'Product Name': 'Rice', 'Selling Price (₹)': '10', Cost: '8', Colour: 'red' },
        { 'Item Code': '', 'Product Name': '', 'Selling Price (₹)': '', Cost: '', Colour: '' },
        { 'Item Code': 'A2', 'Product Name': 'Dal', 'Selling Price (₹)': '20', Cost: '15', Colour: '' },
      ], 2);
      expect(shaped.rows).toEqual([
        { rowNumber: 2, cells: { sku: 'A1', name: 'Rice', sellingPrice: '10', costPrice: '8' } },
        { rowNumber: 4, cells: { sku: 'A2', name: 'Dal', sellingPrice: '20', costPrice: '15' } },
      ]);
      expect(shaped.issues).toEqual([{ message: 'Column not read: "Colour".', severity: 'warning' }]);
    });

    it('refuses a file without a required column, an empty file and an oversized one', () => {
      const missing = shapeRows(ImportKind.CUSTOMERS, [{ name: 'Ramesh' }], 2);
      expect(missing.issues).toEqual([expect.objectContaining({ field: 'phone', severity: 'error' })]);
      expect(shapeRows(ImportKind.OPENING_STOCK, [{ sku: '', quantity: '' }], 2).issues).toEqual([{ message: 'The file has no rows to import.', severity: 'error' }]);
      const huge = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ sku: `S${i}`, quantity: '1' }));
      expect(shapeRows(ImportKind.OPENING_STOCK, huge, 2).issues).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('Split it') })]);
    });
  });

  describe('values', () => {
    it('reads rupees in Indian and Western grouping and refuses what is not money', () => {
      expect(parseMoney('₹1,25,000.50')).toEqual({ ok: true, value: 125000.5 });
      expect(parseMoney('Rs. 1250')).toEqual({ ok: true, value: 1250 });
      expect(parseMoney('-500', { allowNegative: true })).toEqual({ ok: true, value: -500 });
      expect(parseMoney('-500').ok).toBe(false);
      expect(parseMoney('12.345').ok).toBe(false);
      expect(parseMoney('abc').ok).toBe(false);
      expect(parseMoney('100000000').ok).toBe(false);
    });

    it('reads GST slabs, units and quantities by the POS rules', () => {
      expect(parseGstRate('18%')).toEqual({ ok: true, value: GstRate.EIGHTEEN });
      expect(parseGstRate('5.0')).toEqual({ ok: true, value: GstRate.FIVE });
      expect(parseGstRate('exempt')).toEqual({ ok: true, value: GstRate.ZERO });
      expect(parseGstRate('15').ok).toBe(false);
      expect(parseUnit('kgs')).toEqual({ ok: true, value: ProductUnit.KG });
      expect(parseUnit('Nos.')).toEqual({ ok: true, value: ProductUnit.PCS });
      expect(parseUnit('crate').ok).toBe(false);
      expect(parseQuantity('2.5', ProductUnit.KG)).toEqual({ ok: true, value: 2.5 });
      expect(parseQuantity('2.5', ProductUnit.PCS).ok).toBe(false);
      expect(parseQuantity('3.000', ProductUnit.PCS)).toEqual({ ok: true, value: 3 });
      expect(parseQuantity('1,200', ProductUnit.PCS)).toEqual({ ok: true, value: 1200 });
    });

    it('stores a phone as its national number: digits only, without the +91 or trunk 0 prefix', () => {
      expect(normalizePhone('+91 98450-12345')).toEqual({ ok: true, value: '9845012345' });
      expect(normalizePhone('09845012345')).toEqual({ ok: true, value: '9845012345' });
      // A landline with its STD code: +91 80 2345 6789 and 080 2345 6789 are one number.
      expect(normalizePhone('080 2345 6789')).toEqual({ ok: true, value: '8023456789' });
      expect(normalizePhone('+91 80 2345 6789')).toEqual({ ok: true, value: '8023456789' });
      expect(normalizePhone('call me').ok).toBe(false);
    });

    it('recognises a code a spreadsheet shortened to scientific notation', () => {
      expect(spreadsheetMangled('8.90123E+12')).toBe(true);
      expect(spreadsheetMangled('9.84501E9')).toBe(true);
      expect(spreadsheetMangled('8901234567890')).toBe(false);
      expect(spreadsheetMangled('SKU-E12')).toBe(false);
    });
  });

  describe('products', () => {
    const product = (cells: Record<string, string>) => validateProductRow(2, { sku: 'RICE-5', name: 'Rice 5 kg', costPrice: '560', sellingPrice: '599', gstRate: '5', ...cells });

    it('types a valid row and leaves blank cells absent (a blank never clears a stored value)', () => {
      const row = product({ unit: 'kg', mrp: '650', reorderPoint: '5', type: 'simple' });
      expect(errorsOf(row)).toEqual([]);
      expect(row.value).toEqual({ sku: 'RICE-5', name: 'Rice 5 kg', costPrice: 560, sellingPrice: 599, mrp: 650, gstRate: GstRate.FIVE, unit: ProductUnit.KG, reorderPoint: 5, type: ProductType.SIMPLE, category: undefined, barcode: undefined, hsnCode: undefined, cessRate: undefined, wholesalePrice: undefined, description: undefined });
    });

    it('refuses a selling price above the MRP, a missing price, a bad slab and a shortened barcode', () => {
      expect(errorsOf(product({ mrp: '500' }))).toEqual(['mrp']);
      expect(errorsOf(product({ costPrice: '' }))).toEqual(['costPrice']);
      expect(errorsOf(product({ gstRate: '15' }))).toEqual(['gstRate']);
      expect(errorsOf(product({ barcode: '8.90123E+12' }))).toEqual(['barcode']);
      expect(errorsOf(product({ sku: '' }))).toEqual(['sku']);
      expect(product({ sku: '' }).value).toBeUndefined();
    });

    it('warns about an odd HSN code and a zero price without refusing the row; a blank GST slab is left to the plan', () => {
      expect(warningsOf(product({ hsnCode: '1006X' }))).toEqual(['hsnCode']);
      expect(warningsOf(product({ sellingPrice: '0', costPrice: '0' }))).toEqual(['sellingPrice']);
      // Only a new product gets the 18% default (and a warning); an update keeps its stored slab.
      expect(warningsOf(product({ gstRate: '' }))).toEqual([]);
      expect(product({ gstRate: '' }).value?.gstRate).toBeUndefined();
    });
  });

  describe('customers', () => {
    const customer = (cells: Record<string, string>) => validateCustomerRow(3, { name: 'Ramesh Kumar', phone: '+91 98765 43210', ...cells });

    it('normalises the phone and the state, and keeps the signed opening balance', () => {
      const row = customer({ state: 'orissa', openingBalance: '-500', creditLimit: '5,000' });
      expect(errorsOf(row)).toEqual([]);
      expect(row.value).toEqual(expect.objectContaining({ phone: '9876543210', state: 'Odisha', openingBalance: -500, creditLimit: 5000 }));
      expect(customer({}).value?.openingBalance).toBeUndefined();
      expect(customer({ openingBalance: '0' }).value?.openingBalance).toBe(0);
    });

    it('refuses a state that is not Indian (it would decide the wrong GST), a bad email and a shortened phone', () => {
      expect(errorsOf(customer({ state: 'Bangalore' }))).toEqual(['state']);
      expect(errorsOf(customer({ email: 'not-an-email' }))).toEqual(['email']);
      expect(errorsOf(customer({ phone: '9.87654E+09' }))).toEqual(['phone']);
      expect(errorsOf(customer({ name: '' }))).toEqual(['name']);
    });
  });

  describe('opening stock', () => {
    it('needs a SKU or a barcode and a quantity; 0 is a valid shape (nothing to record)', () => {
      expect(validateOpeningStockRow(2, { sku: 'A1', quantity: '40' }).value).toEqual({ sku: 'A1', barcode: undefined, quantity: '40' });
      expect(validateOpeningStockRow(2, { barcode: '8901', quantity: '0' }).value).toEqual({ sku: undefined, barcode: '8901', quantity: '0' });
      expect(errorsOf(validateOpeningStockRow(2, { quantity: '4' }))).toEqual(['sku']);
      expect(errorsOf(validateOpeningStockRow(2, { sku: 'A1', quantity: 'many' }))).toEqual(['quantity']);
      expect(errorsOf(validateOpeningStockRow(2, { sku: 'A1', quantity: '-3' }))).toEqual(['quantity']);
      expect(errorsOf(validateOpeningStockRow(2, { barcode: '8.90123E+12', quantity: '3' }))).toEqual(['barcode']);
    });
  });
});
