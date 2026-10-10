import { Injectable } from '@nestjs/common';
import { Prisma, ProductUnit } from '@prisma/client';
import { CategoriesService } from '../../categories/categories.service';
import { CreateProductDto, UpdateProductDto } from '../../products/dto/create-product.dto';
import { normalizeBarcode, ProductsService } from '../../products/products.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ParsedFile, ProductImportValue, STOCKLESS_TYPES, validateProductRow } from '../import-rows';
import { fold, ImportActor, Importer, invalid, PlannedRow, refuse, refuseRepeats } from './import-plan';

const PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  barcode: true,
  hsnCode: true,
  unit: true,
  gstRate: true,
  cessRate: true,
  costPrice: true,
  sellingPrice: true,
  mrp: true,
  wholesalePrice: true,
  reorderPoint: true,
  type: true,
  description: true,
  categoryId: true,
  isActive: true,
} satisfies Prisma.ProductSelect;

type StoredProduct = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

/** A category named in the file: an existing one, or created on the first row that applies. */
interface CategoryTarget {
  name: string;
  id?: string;
}

const MONEY_FIELDS = ['costPrice', 'sellingPrice', 'mrp', 'wholesalePrice'] as const;

/**
 * Products (roadmap 9.20): matched by SKU (case does not matter, as in the
 * database's unique key), created through `ProductsService.create` and
 * updated through `ProductsService.update`, so an import writes exactly what
 * the products page would: the same DTO rules, the barcode uniqueness check,
 * the price-change audit row, the ProductCreated event. A blank cell never
 * clears a stored value. A category is matched by name and created once,
 * at the root, the first time a row that applies names it.
 */
@Injectable()
export class ProductImporter implements Importer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
  ) {}

  async plan(rows: ParsedFile['rows'], actor: ImportActor): Promise<PlannedRow[]> {
    const { shopId } = actor;
    const validated = rows.map((row) => validateProductRow(row.rowNumber, row.cells));
    const bySku = refuseRepeats(validated, (v) => fold(v.sku), 'SKU', 'sku');
    const byBarcode = refuseRepeats(bySku.kept, (v) => (v.barcode ? fold(v.barcode) : undefined), 'barcode', 'barcode');
    const planned: PlannedRow[] = [...bySku.repeats, ...byBarcode.repeats];

    const [stored, categories, extraBarcodes, variantBarcodes] = await Promise.all([
      this.prisma.product.findMany({ where: { shopId, isDeleted: false }, select: PRODUCT_SELECT }),
      this.prisma.category.findMany({ where: { shopId, isDeleted: false }, select: { id: true, name: true } }),
      this.prisma.productBarcode.findMany({ where: { shopId, isActive: true }, select: { barcode: true, productId: true } }),
      this.prisma.productVariant.findMany({ where: { shopId, isDeleted: false, isActive: true, barcode: { not: null } }, select: { barcode: true, productId: true } }),
    ]);
    const productBySku = new Map(stored.map((p) => [fold(p.sku), p]));
    const skuById = new Map(stored.map((p) => [p.id, p.sku]));
    // Every barcode the shop already uses and the product it belongs to (the products page enforces the same uniqueness).
    const barcodeOwner = new Map<string, string>();
    for (const p of stored) if (p.barcode) barcodeOwner.set(fold(p.barcode), p.id);
    for (const b of extraBarcodes) barcodeOwner.set(fold(b.barcode), b.productId);
    for (const v of variantBarcodes) if (v.barcode) barcodeOwner.set(fold(v.barcode), v.productId);
    // Created categories are remembered for the rest of the run.
    const categoryIds = new Map(categories.map((c) => [fold(c.name), c.id]));
    const ensureCategory = async (target: CategoryTarget): Promise<string> => {
      const known = target.id ?? categoryIds.get(fold(target.name));
      if (known) return known;
      const id = await this.createCategory(shopId, target.name);
      categoryIds.set(fold(target.name), id);
      return id;
    };

    for (const row of byBarcode.kept) {
      if (!row.value) {
        planned.push(invalid(row));
        continue;
      }
      const value = row.value;
      const existing = productBySku.get(fold(value.sku));
      const barcode = normalizeBarcode(value.barcode);
      if (barcode) {
        const owner = barcodeOwner.get(fold(barcode));
        if (owner && owner !== existing?.id) {
          planned.push(refuse(row, `Barcode ${barcode} already belongs to product ${skuById.get(owner) ?? owner}.`, 'barcode'));
          continue;
        }
      }
      const category: CategoryTarget | undefined = value.category ? { name: value.category, id: categoryIds.get(fold(value.category)) } : undefined;
      planned.push(existing ? this.planUpdate(row.rowNumber, row.raw, [...row.issues], value, existing, barcode, category, ensureCategory) : this.planCreate(row.rowNumber, row.raw, [...row.issues], value, barcode, category, ensureCategory));
    }
    return planned;
  }

  private planCreate(
    rowNumber: number,
    raw: Record<string, string>,
    issues: PlannedRow['issues'],
    value: ProductImportValue,
    barcode: string | null,
    category: CategoryTarget | undefined,
    ensureCategory: (target: CategoryTarget) => Promise<string>,
  ): PlannedRow {
    const changes = [`new product ${value.sku}`];
    if (category) changes.push(category.id ? `category "${category.name}"` : `category "${category.name}" (new)`);
    if (!value.gstRate) issues.push({ field: 'gstRate', message: 'No GST slab given: 18% applies. Check it before billing.', severity: 'warning' });
    const dto: CreateProductDto = {
      name: value.name,
      sku: value.sku,
      barcode: barcode ?? undefined,
      description: value.description,
      type: value.type,
      costPrice: value.costPrice,
      sellingPrice: value.sellingPrice,
      // The products page rules (roadmap 6.2): MRP and wholesale default to the selling price.
      mrp: value.mrp ?? value.sellingPrice,
      wholesalePrice: value.wholesalePrice ?? value.sellingPrice,
      gstRate: value.gstRate,
      cessRate: value.cessRate,
      hsnCode: value.hsnCode,
      unit: value.unit ?? ProductUnit.PCS,
      reorderPoint: value.reorderPoint,
    };
    return {
      rowNumber,
      raw,
      issues,
      action: 'CREATE',
      changes,
      apply: async () => {
        await this.products.create({ ...dto, categoryId: category ? await ensureCategory(category) : undefined });
        return 'CREATE';
      },
    };
  }

  private planUpdate(
    rowNumber: number,
    raw: Record<string, string>,
    issues: PlannedRow['issues'],
    value: ProductImportValue,
    existing: StoredProduct,
    barcode: string | null,
    category: CategoryTarget | undefined,
    ensureCategory: (target: CategoryTarget) => Promise<string>,
  ): PlannedRow {
    const dto: UpdateProductDto = {};
    const changes: string[] = [];
    const set = <K extends keyof UpdateProductDto>(field: K, next: UpdateProductDto[K], before: string | null, after: string) => {
      dto[field] = next;
      changes.push(`${String(field)} ${before ?? '(none)'} → ${after}`);
    };

    if (value.name !== existing.name) set('name', value.name, existing.name, value.name);
    if (barcode && barcode !== existing.barcode) set('barcode', barcode, existing.barcode, barcode);
    if (value.hsnCode && value.hsnCode !== existing.hsnCode) set('hsnCode', value.hsnCode, existing.hsnCode, value.hsnCode);
    if (value.unit && value.unit !== existing.unit) {
      set('unit', value.unit, existing.unit, value.unit);
      issues.push({ field: 'unit', message: `The unit changes from ${existing.unit} to ${value.unit}; stock already counted keeps its numbers.`, severity: 'warning' });
    }
    if (value.gstRate && value.gstRate !== existing.gstRate) set('gstRate', value.gstRate, existing.gstRate, value.gstRate);
    if (value.cessRate !== undefined && !existing.cessRate.equals(value.cessRate)) set('cessRate', value.cessRate, existing.cessRate.toFixed(2), value.cessRate.toFixed(2));
    for (const field of MONEY_FIELDS) {
      const next = value[field];
      if (next !== undefined && !existing[field].equals(next)) set(field, next, existing[field].toFixed(2), next.toFixed(2));
    }
    if (value.reorderPoint !== undefined && !existing.reorderPoint.equals(value.reorderPoint)) set('reorderPoint', value.reorderPoint, existing.reorderPoint.toString(), String(value.reorderPoint));
    if (value.type && value.type !== existing.type) {
      set('type', value.type, existing.type, value.type);
      if (STOCKLESS_TYPES.has(value.type) !== STOCKLESS_TYPES.has(existing.type)) {
        issues.push({ field: 'type', message: `${existing.type} → ${value.type}: the product ${STOCKLESS_TYPES.has(value.type) ? 'stops' : 'starts'} carrying stock.`, severity: 'warning' });
      }
    }
    if (value.description && value.description !== existing.description) {
      dto.description = value.description;
      changes.push('description');
    }
    const categoryChanges = category && (!category.id || category.id !== existing.categoryId);
    if (category && categoryChanges) changes.push(`category → "${category.name}"${category.id ? '' : ' (new)'}`);

    // Nothing sells above its MRP (roadmap 6.2), whichever of the two the file leaves blank.
    const mrp = value.mrp !== undefined ? new Prisma.Decimal(value.mrp) : existing.mrp;
    if (new Prisma.Decimal(value.sellingPrice).greaterThan(mrp)) {
      return {
        rowNumber,
        raw,
        issues: [...issues, { field: 'mrp', message: `The selling price ${value.sellingPrice.toFixed(2)} is above the product's MRP ${mrp.toFixed(2)}; give the MRP in the file.`, severity: 'error' }],
        changes: [],
      };
    }
    if (!existing.isActive) issues.push({ message: 'The product is inactive in the shop; the import updates it and leaves it inactive.', severity: 'warning' });

    if (changes.length === 0) return { rowNumber, raw, issues, action: 'UNCHANGED', changes: [] };
    return {
      rowNumber,
      raw,
      issues,
      action: 'UPDATE',
      changes,
      apply: async () => {
        await this.products.update(existing.id, { ...dto, ...(category && categoryChanges ? { categoryId: await ensureCategory(category) } : {}) });
        return 'UPDATE';
      },
    };
  }

  /** A root category; a concurrent create of the same name (the unique key) is read back instead. */
  private async createCategory(shopId: string, name: string): Promise<string> {
    try {
      return (await this.categories.create({ name })).id;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const existing = await this.prisma.category.findFirst({ where: { shopId, name, isDeleted: false }, select: { id: true } });
      if (!existing) throw error;
      return existing.id;
    }
  }
}
