import { ImportKind } from '@prisma/client';

/**
 * The columns of the three onboarding imports (roadmap 9.20): one place for
 * the header a template carries, the spellings a shop's own spreadsheet may
 * use instead, whether the column must be there, and two example values. The
 * header mapping, `GET /imports/templates/:kind` and the committed templates
 * under `docs/onboarding/` all come from here (`import-columns.spec.ts` fails
 * when a committed template differs from what this file generates).
 */
export interface ImportColumn {
  /** The field the row validator reads. */
  key: string;
  /** The header a template carries. */
  header: string;
  /** Other headers that mean the same column, compared after `headerKey`. */
  aliases: readonly string[];
  required: boolean;
  /** What a shop owner needs to know to fill it in. */
  description: string;
  /** Two example values: the template's two sample rows. */
  examples: readonly [string, string];
}

export const PRODUCT_COLUMNS: readonly ImportColumn[] = [
  { key: 'sku', header: 'sku', aliases: ['item code', 'code', 'product code'], required: true, description: "The shop's code for the item, unique in the shop; the key a re-run matches on.", examples: ['RICE-BAS-5KG', 'SOAP-LUX-100G'] },
  { key: 'name', header: 'name', aliases: ['product name', 'item name', 'product', 'item'], required: true, description: 'Name printed on the receipt.', examples: ['India Gate Basmati Rice 5 kg', 'Lux Soap 100 g'] },
  { key: 'category', header: 'category', aliases: ['category name', 'group'], required: false, description: 'Category name; created the first time it appears. One level, no paths.', examples: ['Rice & Grains', 'Personal Care'] },
  { key: 'barcode', header: 'barcode', aliases: ['ean', 'upc', 'bar code'], required: false, description: 'Printed barcode (EAN-13 on most packs); unique in the shop.', examples: ['8901234567890', '8901030712345'] },
  { key: 'hsnCode', header: 'hsnCode', aliases: ['hsn', 'hsn code', 'hsn/sac', 'sac'], required: false, description: 'HSN code for the GST invoice (4, 6 or 8 digits).', examples: ['10063020', '34011110'] },
  { key: 'unit', header: 'unit', aliases: ['uom', 'unit of measure'], required: false, description: 'PCS (default), KG, GM, LTR, ML, BOX, PACK, DOZEN or BUNDLE; KG, GM, LTR and ML sell in decimals.', examples: ['PCS', 'PCS'] },
  { key: 'gstRate', header: 'gstRate', aliases: ['gst', 'gst %', 'gst rate', 'tax rate', 'tax'], required: false, description: 'GST slab: 0, 5, 12, 18 or 28 (18 when blank, reported as a warning).', examples: ['5', '18'] },
  { key: 'cessRate', header: 'cessRate', aliases: ['cess', 'cess %'], required: false, description: 'Cess percent on the taxable value (0 when blank).', examples: ['0', '0'] },
  { key: 'costPrice', header: 'costPrice', aliases: ['cost', 'cost price', 'purchase price', 'buying price'], required: true, description: 'What the shop pays per unit, in rupees; values the opening stock.', examples: ['560', '28.50'] },
  { key: 'sellingPrice', header: 'sellingPrice', aliases: ['price', 'selling price', 'sale price', 'sp', 'rate'], required: true, description: 'Price per unit before GST, in rupees.', examples: ['599', '32'] },
  { key: 'mrp', header: 'mrp', aliases: ['maximum retail price'], required: false, description: 'Printed MRP; the selling price when blank, never below it.', examples: ['650', '35'] },
  { key: 'wholesalePrice', header: 'wholesalePrice', aliases: ['wholesale', 'wholesale price'], required: false, description: 'Wholesale price; the selling price when blank.', examples: ['580', '30'] },
  { key: 'reorderPoint', header: 'reorderPoint', aliases: ['reorder level', 'reorder point', 'min stock', 'minimum stock'], required: false, description: 'Low-stock alert level (10 when blank).', examples: ['5', '24'] },
  { key: 'type', header: 'type', aliases: ['product type'], required: false, description: 'SIMPLE (default) for stocked goods; SERVICE or DIGITAL carry no stock.', examples: ['SIMPLE', 'SIMPLE'] },
  { key: 'description', header: 'description', aliases: [], required: false, description: 'Free text.', examples: ['', ''] },
];

export const CUSTOMER_COLUMNS: readonly ImportColumn[] = [
  { key: 'name', header: 'name', aliases: ['customer name', 'customer'], required: true, description: 'Name as the shop knows the customer.', examples: ['Ramesh Kumar', 'Sharma General Store'] },
  { key: 'phone', header: 'phone', aliases: ['mobile', 'mobile number', 'phone number', 'contact'], required: true, description: 'Mobile number; spaces, dashes and a +91 or 0 prefix are removed. The key a re-run matches on.', examples: ['9876543210', '98450 12345'] },
  { key: 'email', header: 'email', aliases: ['e-mail', 'email address'], required: false, description: 'Email address.', examples: ['', 'accounts@sharmastore.in'] },
  { key: 'address', header: 'address', aliases: ['street'], required: false, description: 'Address line.', examples: ['12 MG Road', 'Shop 4, Main Bazaar'] },
  { key: 'city', header: 'city', aliases: ['town'], required: false, description: 'City.', examples: ['Bengaluru', 'Mysuru'] },
  { key: 'state', header: 'state', aliases: ['state name'], required: false, description: 'Indian state or union territory, spelled as on the GST portal; decides CGST/SGST against IGST.', examples: ['Karnataka', 'Karnataka'] },
  { key: 'creditLimit', header: 'creditLimit', aliases: ['credit limit', 'udhar limit'], required: false, description: 'Most the customer may owe, in rupees (the shop default when blank).', examples: ['5000', '25000'] },
  { key: 'openingBalance', header: 'openingBalance', aliases: ['opening balance', 'balance', 'udhar', 'outstanding', 'due'], required: false, description: 'What the customer owes today, in rupees (negative for an advance held). Recorded once as opening udhar.', examples: ['1250', '0'] },
  { key: 'notes', header: 'notes', aliases: ['note', 'remarks'], required: false, description: 'Free text.', examples: ['', 'Pays on the 1st'] },
];

export const OPENING_STOCK_COLUMNS: readonly ImportColumn[] = [
  { key: 'sku', header: 'sku', aliases: ['item code', 'code', 'product code'], required: false, description: 'SKU of a product already imported; or give its barcode.', examples: ['RICE-BAS-5KG', ''] },
  { key: 'barcode', header: 'barcode', aliases: ['ean', 'upc', 'bar code'], required: false, description: 'Barcode of the product when the SKU is blank.', examples: ['', '8901030712345'] },
  { key: 'quantity', header: 'quantity', aliases: ['qty', 'stock', 'opening stock', 'opening quantity', 'on hand'], required: true, description: 'Counted quantity on the shelf, in the product unit (whole numbers for PCS, BOX, PACK, DOZEN, BUNDLE).', examples: ['40', '144'] },
];

export const IMPORT_COLUMNS: Readonly<Record<ImportKind, readonly ImportColumn[]>> = {
  PRODUCTS: PRODUCT_COLUMNS,
  CUSTOMERS: CUSTOMER_COLUMNS,
  OPENING_STOCK: OPENING_STOCK_COLUMNS,
};

/** URL segment and template file name of each kind. */
export const IMPORT_KIND_SLUGS: Readonly<Record<ImportKind, string>> = {
  PRODUCTS: 'products',
  CUSTOMERS: 'customers',
  OPENING_STOCK: 'opening-stock',
};

export function importKindFromSlug(slug: string): ImportKind | undefined {
  return (Object.keys(IMPORT_KIND_SLUGS) as ImportKind[]).find((kind) => IMPORT_KIND_SLUGS[kind] === slug);
}

/** A header as compared: lower case, letters and digits only ("Selling Price (₹)" and "selling_price" are one column). */
export function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface HeaderMapping {
  /** File header -> column key. */
  columns: Map<string, string>;
  /** Headers no column claims (reported, not read). */
  unknown: string[];
  /** Required columns the file does not have. */
  missing: ImportColumn[];
}

export function mapHeaders(kind: ImportKind, headers: readonly string[]): HeaderMapping {
  const byKey = new Map<string, ImportColumn>();
  for (const column of IMPORT_COLUMNS[kind]) {
    for (const spelling of [column.header, column.key, ...column.aliases]) byKey.set(headerKey(spelling), column);
  }
  const columns = new Map<string, string>();
  const unknown: string[] = [];
  const claimed = new Set<string>();
  for (const header of headers) {
    const column = byKey.get(headerKey(header));
    // A second header mapping to the same column is ignored like an unknown one.
    if (!column || claimed.has(column.key)) {
      if (header.trim()) unknown.push(header);
      continue;
    }
    columns.set(header, column.key);
    claimed.add(column.key);
  }
  const missing = IMPORT_COLUMNS[kind].filter((c) => c.required && !claimed.has(c.key));
  return { columns, unknown, missing };
}

/**
 * One CSV cell. A text cell a spreadsheet would run as a formula (= + - @ at
 * the start) is prefixed with an apostrophe; a number such as -500 is not.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^[-+]?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The template a shop fills in: the header row and two sample rows. */
export function templateCsv(kind: ImportKind): string {
  const columns = IMPORT_COLUMNS[kind];
  const lines = [columns.map((c) => c.header), columns.map((c) => c.examples[0]), columns.map((c) => c.examples[1])];
  return `${lines.map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`;
}
