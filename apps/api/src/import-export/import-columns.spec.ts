import * as fs from 'fs';
import * as path from 'path';
import { ImportKind } from '@prisma/client';
import { csvCell, IMPORT_COLUMNS, IMPORT_KIND_SLUGS, importKindFromSlug, mapHeaders, templateCsv } from './import-columns';
import { shapeRows, validateCustomerRow, validateOpeningStockRow, validateProductRow } from './import-rows';

const TEMPLATES = path.resolve(__dirname, '../../../../docs/onboarding');
const VALIDATE = { PRODUCTS: validateProductRow, CUSTOMERS: validateCustomerRow, OPENING_STOCK: validateOpeningStockRow } as const;

describe('onboarding import columns and templates (roadmap 9.20)', () => {
  it.each(Object.values(ImportKind))('the committed template of %s is the one the API serves', (kind) => {
    const committed = fs.readFileSync(path.join(TEMPLATES, `${IMPORT_KIND_SLUGS[kind]}.csv`), 'utf8');
    expect(committed).toBe(templateCsv(kind));
  });

  it.each(Object.values(ImportKind))('the sample rows of the %s template pass validation with no error', (kind) => {
    const [header, ...lines] = templateCsv(kind).trim().split('\n');
    const headers = header.split(',');
    // The samples hold no quoted comma except the address, which this split-aware parse keeps whole.
    const records = lines.map((line) => {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
    });
    const shaped = shapeRows(kind, records, 2);
    expect(shaped.issues).toEqual([]);
    for (const row of shaped.rows) {
      const validated = VALIDATE[kind](row.rowNumber, row.cells);
      expect({ row: row.rowNumber, errors: validated.issues.filter((i) => i.severity === 'error') }).toEqual({ row: row.rowNumber, errors: [] });
    }
  });

  it('every column key is unique and every spelling maps to one column', () => {
    for (const kind of Object.values(ImportKind)) {
      const columns = IMPORT_COLUMNS[kind];
      expect(new Set(columns.map((c) => c.key)).size).toBe(columns.length);
      const spellings = columns.flatMap((c) => [c.header, c.key, ...c.aliases].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((s, i, all) => all.indexOf(s) === i));
      expect(new Set(spellings).size).toBe(spellings.length);
    }
  });

  it('maps the first of two headers naming one column and reports the second', () => {
    const mapping = mapHeaders(ImportKind.CUSTOMERS, ['Mobile', 'Phone Number', 'Customer Name']);
    expect([...mapping.columns]).toEqual([['Mobile', 'phone'], ['Customer Name', 'name']]);
    expect(mapping.unknown).toEqual(['Phone Number']);
    expect(mapping.missing).toEqual([]);
  });

  it('knows the template slugs', () => {
    expect(importKindFromSlug('opening-stock')).toBe(ImportKind.OPENING_STOCK);
    expect(importKindFromSlug('OPENING_STOCK')).toBeUndefined();
  });

  it('quotes CSV cells and keeps a spreadsheet from running one as a formula', () => {
    expect(csvCell('Shop 4, Main Bazaar')).toBe('"Shop 4, Main Bazaar"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-500')).toBe('-500');
    expect(csvCell('-x')).toBe("'-x");
  });
});
