import { GstRate, ImportKind, ProductType, ProductUnit } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { canonicalState } from '../common/india/states';
import { CreateCustomerDto } from '../customers/dto/create-customer.dto';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { mapHeaders } from './import-columns';

/**
 * Row validation of the onboarding imports (roadmap 9.20). Pure: a file's
 * rows in, typed values and per-column problems out, so every rule is a unit
 * test. What a row means for the shop's data (create, update, unchanged, a
 * conflict with what is already there) is decided afterwards by the
 * importers, which read the database.
 *
 * Each typed value is also run through the API's own create DTO
 * (`CreateProductDto`, `CreateCustomerDto`), so an import never writes what
 * `POST /products` or `POST /customers` would refuse.
 */

export interface RowIssue {
  /** The column (its key) the problem is about; absent for the row as a whole. */
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidatedRow<T> {
  /** The line of the file a spreadsheet shows (header = 1) or the array position + 1 (JSON). */
  rowNumber: number;
  raw: Record<string, string>;
  /** Present when the row has no errors. */
  value?: T;
  issues: RowIssue[];
}

export interface ParsedFile {
  rows: Array<{ rowNumber: number; cells: Record<string, string> }>;
  /** File-level problems: a missing required column is an error that stops the import. */
  issues: RowIssue[];
}

/** Largest import a single job accepts (a shop's catalogue fits many times over). */
export const MAX_IMPORT_ROWS = 50_000;
/** `Decimal(10, 2)` columns (prices, credit limit, balance). */
export const MAX_MONEY = 99_999_999.99;
/** `Decimal(12, 3)` stock columns. */
export const MAX_QUANTITY = 999_999_999.999;

/** Units sold by weight or volume: decimals allowed (the POS's own rule, `apps/web/src/store/pos.ts`). */
export const DECIMAL_UNITS: ReadonlySet<ProductUnit> = new Set<ProductUnit>([ProductUnit.KG, ProductUnit.GM, ProductUnit.LTR, ProductUnit.ML]);
/** Products that carry no stock (the inventory engine bypasses them). */
export const STOCKLESS_TYPES: ReadonlySet<ProductType> = new Set<ProductType>([ProductType.SERVICE, ProductType.DIGITAL]);

// -----------------------------------------------------------------------------
// The file
// -----------------------------------------------------------------------------

/**
 * Maps a parsed file's columns to the kind's keys: every cell becomes a
 * trimmed string under its column key, a row of blank cells is dropped, and
 * a column the kind does not know is reported once and not read.
 */
export function shapeRows(kind: ImportKind, records: Array<Record<string, unknown>>, firstRowNumber: number): ParsedFile {
  const issues: RowIssue[] = [];
  const headers = Array.from(new Set(records.flatMap((r) => Object.keys(r))));
  const mapping = mapHeaders(kind, headers);
  for (const column of mapping.missing) issues.push({ field: column.key, message: `The file has no "${column.header}" column, which this import needs.`, severity: 'error' });
  if (mapping.unknown.length > 0) {
    issues.push({ message: `Column${mapping.unknown.length === 1 ? '' : 's'} not read: ${mapping.unknown.map((h) => `"${h}"`).join(', ')}.`, severity: 'warning' });
  }
  if (records.length > MAX_IMPORT_ROWS) {
    issues.push({ message: `The file has ${records.length} rows; one import takes at most ${MAX_IMPORT_ROWS}. Split it.`, severity: 'error' });
  }
  const rows: ParsedFile['rows'] = [];
  records.forEach((record, index) => {
    const cells: Record<string, string> = {};
    for (const [header, key] of mapping.columns) {
      const value = record[header];
      cells[key] = value === undefined || value === null ? '' : String(value).trim();
    }
    if (Object.values(cells).every((v) => v === '')) return;
    rows.push({ rowNumber: index + firstRowNumber, cells });
  });
  if (rows.length === 0 && !issues.some((i) => i.severity === 'error')) issues.push({ message: 'The file has no rows to import.', severity: 'error' });
  return { rows, issues };
}

// -----------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Rupees: "₹1,250.50", "1250.5", "Rs. 1250" (Indian or Western grouping). */
export function parseMoney(input: string, { allowNegative = false } = {}): Parsed<number> {
  const cleaned = input.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false, message: `"${input}" is not an amount in rupees.` };
  const value = Number(cleaned);
  if (!allowNegative && value < 0) return { ok: false, message: 'Must not be negative.' };
  if ((cleaned.split('.')[1] ?? '').length > 2) return { ok: false, message: `"${input}" has more than 2 decimal places (paise).` };
  if (Math.abs(value) > MAX_MONEY) return { ok: false, message: `Must not exceed ${MAX_MONEY.toLocaleString('en-IN')}.` };
  return { ok: true, value };
}

export function parseQuantity(input: string, unit: ProductUnit): Parsed<number> {
  const cleaned = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { ok: false, message: `"${input}" is not a quantity.` };
  const value = Number(cleaned);
  if (!(value > 0)) return { ok: false, message: 'Must be more than 0.' };
  const decimals = (cleaned.split('.')[1] ?? '').replace(/0+$/, '').length;
  if (!DECIMAL_UNITS.has(unit) && decimals > 0) return { ok: false, message: `Whole numbers only for ${unit}.` };
  if (decimals > 3) return { ok: false, message: 'At most 3 decimal places.' };
  if (value > MAX_QUANTITY) return { ok: false, message: 'Quantity is too large.' };
  return { ok: true, value };
}

const GST_BY_PERCENT: Readonly<Record<string, GstRate>> = { '0': GstRate.ZERO, '5': GstRate.FIVE, '12': GstRate.TWELVE, '18': GstRate.EIGHTEEN, '28': GstRate.TWENTYEIGHT };

/** "18", "18%", "18.0", "EIGHTEEN", "nil", "exempt". */
export function parseGstRate(input: string): Parsed<GstRate> {
  const upper = input.trim().toUpperCase();
  if ((Object.values(GstRate) as string[]).includes(upper)) return { ok: true, value: upper as GstRate };
  if (['NIL', 'EXEMPT', 'EXEMPTED', 'NONE'].includes(upper)) return { ok: true, value: GstRate.ZERO };
  const percent = upper.replace(/%$/, '').trim();
  if (/^\d+(\.0+)?$/.test(percent)) {
    const rate = GST_BY_PERCENT[String(Number(percent))];
    if (rate) return { ok: true, value: rate };
  }
  return { ok: false, message: `"${input}" is not a GST slab (0, 5, 12, 18 or 28).` };
}

const UNIT_ALIASES: Readonly<Record<string, ProductUnit>> = {
  PC: ProductUnit.PCS, PCS: ProductUnit.PCS, PIECE: ProductUnit.PCS, PIECES: ProductUnit.PCS, NOS: ProductUnit.PCS, NO: ProductUnit.PCS, UNIT: ProductUnit.PCS, UNITS: ProductUnit.PCS, EA: ProductUnit.PCS, EACH: ProductUnit.PCS,
  KG: ProductUnit.KG, KGS: ProductUnit.KG, KILO: ProductUnit.KG, KILOGRAM: ProductUnit.KG, KILOGRAMS: ProductUnit.KG,
  G: ProductUnit.GM, GM: ProductUnit.GM, GMS: ProductUnit.GM, GRAM: ProductUnit.GM, GRAMS: ProductUnit.GM,
  L: ProductUnit.LTR, LT: ProductUnit.LTR, LTR: ProductUnit.LTR, LTRS: ProductUnit.LTR, LITRE: ProductUnit.LTR, LITRES: ProductUnit.LTR, LITER: ProductUnit.LTR, LITERS: ProductUnit.LTR,
  ML: ProductUnit.ML, MILLILITRE: ProductUnit.ML, MILLILITER: ProductUnit.ML,
  BOX: ProductUnit.BOX, BOXES: ProductUnit.BOX,
  PACK: ProductUnit.PACK, PACKS: ProductUnit.PACK, PKT: ProductUnit.PACK, PACKET: ProductUnit.PACK, PACKETS: ProductUnit.PACK,
  DOZEN: ProductUnit.DOZEN, DOZ: ProductUnit.DOZEN, DZ: ProductUnit.DOZEN,
  BUNDLE: ProductUnit.BUNDLE, BUNDLES: ProductUnit.BUNDLE,
};

export function parseUnit(input: string): Parsed<ProductUnit> {
  const unit = UNIT_ALIASES[input.trim().toUpperCase().replace(/\.$/, '')];
  return unit ? { ok: true, value: unit } : { ok: false, message: `"${input}" is not a unit (${Object.values(ProductUnit).join(', ')}).` };
}

export function parseProductType(input: string): Parsed<ProductType> {
  const upper = input.trim().toUpperCase();
  return (Object.values(ProductType) as string[]).includes(upper) ? { ok: true, value: upper as ProductType } : { ok: false, message: `"${input}" is not a product type (SIMPLE, SERVICE, DIGITAL, ...).` };
}

/**
 * A phone as the import stores and matches it: the Indian national number,
 * digits only, without the +91 / 91 country code or the trunk 0 (a mobile
 * and a landline with its STD code alike). Two spellings of one number are
 * one customer.
 */
export function normalizePhone(input: string): Parsed<string> {
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return { ok: false, message: `"${input}" is not a phone number.` };
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 6 || digits.length > 15) return { ok: false, message: `"${input}" is not a phone number (6 to 15 digits).` };
  return { ok: true, value: digits };
}

/**
 * A long number a spreadsheet turned into scientific notation ("8.90123E+12"
 * for a 13-digit barcode): the digits are gone, so the cell is refused
 * instead of storing a code no scanner will ever read.
 */
export function spreadsheetMangled(value: string): boolean {
  return /^\d+(\.\d+)?E\+?\d+$/i.test(value.trim());
}

function mangledMessage(value: string): string {
  return `"${value}" is a number the spreadsheet shortened; format the column as text and type the code again.`;
}

function dtoIssues(errors: ValidationError[], fieldOf: (property: string) => string): RowIssue[] {
  return errors.flatMap((e) => Object.values(e.constraints ?? {}).map((message) => ({ field: fieldOf(e.property), message, severity: 'error' as const })));
}

// -----------------------------------------------------------------------------
// Products
// -----------------------------------------------------------------------------

export interface ProductImportValue {
  sku: string;
  name: string;
  /** Present only when the cell was filled in: a blank cell never clears a stored value. */
  category?: string;
  barcode?: string;
  hsnCode?: string;
  unit?: ProductUnit;
  gstRate?: GstRate;
  cessRate?: number;
  costPrice: number;
  sellingPrice: number;
  mrp?: number;
  wholesalePrice?: number;
  reorderPoint?: number;
  type?: ProductType;
  description?: string;
}

export function validateProductRow(rowNumber: number, raw: Record<string, string>): ValidatedRow<ProductImportValue> {
  const issues: RowIssue[] = [];
  const error = (field: string | undefined, message: string) => issues.push({ field, message, severity: 'error' });
  const cell = (key: string) => raw[key] ?? '';

  const sku = cell('sku');
  const name = cell('name');
  if (!sku) error('sku', 'SKU is required.');
  else if (sku.length > 64) error('sku', 'At most 64 characters.');
  else if (spreadsheetMangled(sku)) error('sku', mangledMessage(sku));
  if (!name) error('name', 'Name is required.');
  else if (name.length > 191) error('name', 'At most 191 characters.');

  const money = (key: string, required: boolean): number | undefined => {
    if (!cell(key)) {
      if (required) error(key, `${key} is required.`);
      return undefined;
    }
    const parsed = parseMoney(cell(key));
    if (!parsed.ok) {
      error(key, parsed.message);
      return undefined;
    }
    return parsed.value;
  };
  const costPrice = money('costPrice', true);
  const sellingPrice = money('sellingPrice', true);
  const mrp = money('mrp', false);
  const wholesalePrice = money('wholesalePrice', false);
  if (sellingPrice !== undefined && mrp !== undefined && sellingPrice > mrp) {
    // Legal Metrology: nothing is sold above its printed MRP (the products page rule, roadmap 6.2).
    error('mrp', `MRP ${mrp} is below the selling price ${sellingPrice}.`);
  }
  if (sellingPrice === 0) issues.push({ field: 'sellingPrice', message: 'The selling price is 0: the POS will sell it free.', severity: 'warning' });

  let unit: ProductUnit | undefined;
  if (cell('unit')) {
    const parsed = parseUnit(cell('unit'));
    if (parsed.ok) unit = parsed.value;
    else error('unit', parsed.message);
  }
  let gstRate: GstRate | undefined;
  if (cell('gstRate')) {
    const parsed = parseGstRate(cell('gstRate'));
    if (parsed.ok) gstRate = parsed.value;
    else error('gstRate', parsed.message);
  }
  let cessRate: number | undefined;
  if (cell('cessRate')) {
    const value = Number(cell('cessRate').replace(/%$/, ''));
    if (!Number.isFinite(value) || value < 0 || value > 100) error('cessRate', `"${cell('cessRate')}" is not a cess percent (0 to 100).`);
    else cessRate = value;
  }
  let type: ProductType | undefined;
  if (cell('type')) {
    const parsed = parseProductType(cell('type'));
    if (parsed.ok) type = parsed.value;
    else error('type', parsed.message);
  }
  let reorderPoint: number | undefined;
  if (cell('reorderPoint')) {
    const value = Number(cell('reorderPoint').replace(/,/g, ''));
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) error('reorderPoint', `"${cell('reorderPoint')}" is not a stock level.`);
    else reorderPoint = value;
  }
  const hsnCode = cell('hsnCode') || undefined;
  if (hsnCode && !/^\d{4}(\d{2}){0,2}$/.test(hsnCode)) issues.push({ field: 'hsnCode', message: `"${hsnCode}" is not a 4, 6 or 8 digit HSN code; it is stored as given.`, severity: 'warning' });
  const barcode = cell('barcode') || undefined;
  if (barcode && barcode.length > 64) error('barcode', 'At most 64 characters.');
  else if (barcode && spreadsheetMangled(barcode)) error('barcode', mangledMessage(barcode));
  const category = cell('category') || undefined;
  if (category && category.length > 191) error('category', 'At most 191 characters.');

  if (!issues.some((i) => i.severity === 'error')) {
    // The API's own create rules on exactly what would be written.
    const dto = plainToInstance(CreateProductDto, {
      name,
      sku,
      barcode,
      description: cell('description') || undefined,
      type,
      costPrice,
      sellingPrice,
      mrp: mrp ?? sellingPrice,
      wholesalePrice: wholesalePrice ?? sellingPrice,
      gstRate,
      cessRate,
      hsnCode,
      unit: unit ?? ProductUnit.PCS,
      reorderPoint,
    });
    issues.push(...dtoIssues(validateSync(dto, { skipMissingProperties: false }), (p) => p));
  }
  if (issues.some((i) => i.severity === 'error')) return { rowNumber, raw, issues };
  return {
    rowNumber,
    raw,
    issues,
    value: {
      sku,
      name,
      category,
      barcode,
      hsnCode,
      unit,
      gstRate,
      cessRate,
      costPrice: costPrice!,
      sellingPrice: sellingPrice!,
      mrp,
      wholesalePrice,
      reorderPoint,
      type,
      description: cell('description') || undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// Customers
// -----------------------------------------------------------------------------

export interface CustomerImportValue {
  name: string;
  /** Normalised (`normalizePhone`). */
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  /** The stored spelling (`canonicalState`). */
  state?: string;
  creditLimit?: number;
  /** Signed rupees: what the customer owes (negative: an advance the shop holds); absent when the cell is blank. */
  openingBalance?: number;
  notes?: string;
}

export function validateCustomerRow(rowNumber: number, raw: Record<string, string>): ValidatedRow<CustomerImportValue> {
  const issues: RowIssue[] = [];
  const error = (field: string | undefined, message: string) => issues.push({ field, message, severity: 'error' });
  const cell = (key: string) => raw[key] ?? '';

  const name = cell('name');
  if (!name) error('name', 'Name is required.');
  let phone = '';
  if (!cell('phone')) error('phone', 'Phone is required.');
  else if (spreadsheetMangled(cell('phone'))) error('phone', mangledMessage(cell('phone')));
  else {
    const parsed = normalizePhone(cell('phone'));
    if (parsed.ok) phone = parsed.value;
    else error('phone', parsed.message);
  }
  let state: string | undefined;
  if (cell('state')) {
    state = canonicalState(cell('state'));
    if (!state) error('state', `"${cell('state')}" is not an Indian state or union territory; spell it as on the GST portal (it decides CGST/SGST against IGST).`);
  }
  let creditLimit: number | undefined;
  if (cell('creditLimit')) {
    const parsed = parseMoney(cell('creditLimit'));
    if (parsed.ok) creditLimit = parsed.value;
    else error('creditLimit', parsed.message);
  }
  let openingBalance: number | undefined;
  if (cell('openingBalance')) {
    const parsed = parseMoney(cell('openingBalance'), { allowNegative: true });
    if (parsed.ok) openingBalance = parsed.value;
    else error('openingBalance', parsed.message);
  }

  const value: CustomerImportValue = {
    name,
    phone,
    email: cell('email') || undefined,
    address: cell('address') || undefined,
    city: cell('city') || undefined,
    state,
    creditLimit,
    openingBalance,
    notes: cell('notes') || undefined,
  };
  if (!issues.some((i) => i.severity === 'error')) {
    const dto = plainToInstance(CreateCustomerDto, { name: value.name, phone: value.phone, email: value.email, address: value.address, city: value.city, state: value.state, creditLimit: value.creditLimit, notes: value.notes });
    issues.push(...dtoIssues(validateSync(dto), (p) => p));
  }
  if (issues.some((i) => i.severity === 'error')) return { rowNumber, raw, issues };
  return { rowNumber, raw, issues, value };
}

// -----------------------------------------------------------------------------
// Opening stock
// -----------------------------------------------------------------------------

export interface OpeningStockImportValue {
  sku?: string;
  barcode?: string;
  /** As written (0 allowed: nothing to record); checked against the product's unit once the product is known. */
  quantity: string;
}

export function validateOpeningStockRow(rowNumber: number, raw: Record<string, string>): ValidatedRow<OpeningStockImportValue> {
  const issues: RowIssue[] = [];
  const sku = raw.sku ?? '';
  const barcode = raw.barcode ?? '';
  const quantity = raw.quantity ?? '';
  if (!sku && !barcode) issues.push({ field: 'sku', message: 'Give the SKU or the barcode of the product.', severity: 'error' });
  if (sku.length > 64) issues.push({ field: 'sku', message: 'At most 64 characters.', severity: 'error' });
  for (const [field, value] of [['sku', sku], ['barcode', barcode]] as const) {
    if (value && spreadsheetMangled(value)) issues.push({ field, message: mangledMessage(value), severity: 'error' });
  }
  if (!quantity) issues.push({ field: 'quantity', message: 'Quantity is required.', severity: 'error' });
  // Here only the shape; the unit's rule (whole numbers for PCS) once the product is known.
  else if (!/^\d+(\.\d+)?$/.test(quantity.replace(/[,\s]/g, ''))) issues.push({ field: 'quantity', message: `"${quantity}" is not a quantity.`, severity: 'error' });
  if (issues.length > 0) return { rowNumber, raw, issues };
  return { rowNumber, raw, issues, value: { sku: sku || undefined, barcode: barcode || undefined, quantity } };
}
