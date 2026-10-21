import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryDomainService, openingStockKey } from '../../inventory-domain/services/inventory-domain.service';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ParsedFile, parseQuantity, STOCKLESS_TYPES, validateOpeningStockRow } from '../import-rows';
import { fold, ImportActor, Importer, invalid, PlannedRow, refuse } from './import-plan';

/** Item ids per `IN (...)` list. */
const ID_CHUNK = 1000;

/**
 * Opening stock (roadmap 9.20): the counted quantity of each product on day
 * one, recorded through `InventoryDomainService.recordOpeningStock` as the
 * first movement of the product's item at the sale location
 * (`OPENING_BALANCE`, valued at cost against OPENING_BALANCE_EQUITY, keyed
 * `OPENING:<itemId>`). The product is named by SKU or barcode and must
 * already be in the shop (import the products first). The same quantity on a
 * re-run is unchanged; a different quantity, or a product whose stock
 * already moved, is refused: that difference is a stock adjustment.
 */
@Injectable()
export class OpeningStockImporter implements Importer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryDomainService,
    private readonly locations: InventoryLocationService,
  ) {}

  async plan(rows: ParsedFile['rows'], actor: ImportActor): Promise<PlannedRow[]> {
    const { shopId } = actor;
    const validated = rows.map((row) => validateOpeningStockRow(row.rowNumber, row.cells));
    const [products, extraBarcodes] = await Promise.all([
      this.prisma.product.findMany({ where: { shopId, isDeleted: false }, select: { id: true, sku: true, name: true, barcode: true, unit: true, type: true, currentStock: true } }),
      this.prisma.productBarcode.findMany({ where: { shopId, isActive: true }, select: { barcode: true, productId: true } }),
    ]);
    const bySku = new Map(products.map((p) => [fold(p.sku), p]));
    const byId = new Map(products.map((p) => [p.id, p]));
    const byBarcode = new Map<string, (typeof products)[number]>();
    for (const p of products) if (p.barcode) byBarcode.set(fold(p.barcode), p);
    for (const b of extraBarcodes) {
      const owner = byId.get(b.productId);
      if (owner) byBarcode.set(fold(b.barcode), owner);
    }

    // What the shop already holds: the product-level item at the sale location, its opening, its movements.
    const saleLocation = await this.locations.findSaleLocation(this.prisma, shopId);
    const items = saleLocation
      ? await this.prisma.inventoryItem.findMany({ where: { shopId, locationId: saleLocation, variantKey: '-' }, select: { id: true, productId: true, onHand: true } })
      : [];
    const itemByProduct = new Map(items.map((i) => [i.productId, i]));
    const openingQuantity = new Map<string, Prisma.Decimal>();
    const movementCount = new Map<string, number>();
    const itemIds = items.map((i) => i.id);
    for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
      const chunk = itemIds.slice(i, i + ID_CHUNK);
      const [openings, counts] = await Promise.all([
        this.prisma.stockLedgerEntry.findMany({ where: { shopId, inventoryItemId: { in: chunk }, correlationId: { startsWith: 'OPENING:' } }, select: { inventoryItemId: true, correlationId: true, quantity: true } }),
        this.prisma.stockLedgerEntry.groupBy({ by: ['inventoryItemId'], where: { shopId, inventoryItemId: { in: chunk } }, _count: { _all: true } }),
      ]);
      for (const o of openings) if (o.correlationId === openingStockKey(o.inventoryItemId)) openingQuantity.set(o.inventoryItemId, o.quantity);
      for (const c of counts) movementCount.set(c.inventoryItemId, c._count._all);
    }
    // Stock a product carries only in `currentStock` (from before the stock ledger) would be booked by the engine's legacy bootstrap.
    const onHandSums = await this.prisma.inventoryItem.groupBy({ by: ['productId'], where: { shopId, isDeleted: false }, _sum: { onHand: true } });
    const onHandOf = new Map(onHandSums.map((s) => [s.productId, s._sum.onHand ?? new Prisma.Decimal(0)]));

    const planned: PlannedRow[] = [];
    const firstRowOf = new Map<string, number>();
    for (const row of validated) {
      if (!row.value) {
        planned.push(invalid(row));
        continue;
      }
      const { sku, barcode } = row.value;
      const bySkuMatch = sku ? bySku.get(fold(sku)) : undefined;
      const byBarcodeMatch = barcode ? byBarcode.get(fold(barcode)) : undefined;
      if (sku && !bySkuMatch) {
        planned.push(refuse(row, `No product with SKU ${sku} in the shop; import the products first.`, 'sku'));
        continue;
      }
      if (!sku && barcode && !byBarcodeMatch) {
        planned.push(refuse(row, `No product with barcode ${barcode} in the shop; import the products first.`, 'barcode'));
        continue;
      }
      if (bySkuMatch && byBarcodeMatch && bySkuMatch.id !== byBarcodeMatch.id) {
        planned.push(refuse(row, `SKU ${sku} and barcode ${barcode} belong to two different products.`, 'barcode'));
        continue;
      }
      const product = (bySkuMatch ?? byBarcodeMatch)!;
      const earlier = firstRowOf.get(product.id);
      if (earlier !== undefined) {
        planned.push(refuse(row, `Same product as row ${earlier}; a file names each one once.`, 'sku'));
        continue;
      }
      firstRowOf.set(product.id, row.rowNumber);

      if (STOCKLESS_TYPES.has(product.type)) {
        planned.push(refuse(row, `${product.sku} is a ${product.type} product and carries no stock.`, 'sku'));
        continue;
      }
      if (/^0+(\.0+)?$/.test(row.value.quantity.replace(/[,\s]/g, ''))) {
        planned.push({ rowNumber: row.rowNumber, raw: row.raw, issues: [...row.issues, { field: 'quantity', message: 'Nothing on the shelf: no opening stock to record.', severity: 'warning' }], action: 'SKIP', changes: [] });
        continue;
      }
      const parsed = parseQuantity(row.value.quantity, product.unit);
      if (!parsed.ok) {
        planned.push(refuse(row, parsed.message, 'quantity'));
        continue;
      }
      const quantity = parsed.value;

      const item = itemByProduct.get(product.id);
      if (item) {
        const recorded = openingQuantity.get(item.id);
        if (recorded) {
          if (recorded.equals(quantity)) planned.push({ rowNumber: row.rowNumber, raw: row.raw, issues: row.issues, action: 'UNCHANGED', changes: [] });
          else planned.push(refuse(row, `The opening stock of ${product.sku} is already recorded as ${recorded.toString()}; record the difference as a stock adjustment.`, 'quantity'));
          continue;
        }
        if ((movementCount.get(item.id) ?? 0) > 0) {
          planned.push(refuse(row, `${product.sku} already has stock movements (${item.onHand.toString()} on hand); record the difference as a stock adjustment.`, 'quantity'));
          continue;
        }
      } else {
        const legacy = product.currentStock.minus(onHandOf.get(product.id) ?? 0);
        if (legacy.greaterThan(0)) {
          planned.push(refuse(row, `${product.sku} already carries ${product.currentStock.toString()} in stock from before; record the difference as a stock adjustment.`, 'quantity'));
          continue;
        }
      }

      const rowNumber = row.rowNumber;
      planned.push({
        rowNumber,
        raw: row.raw,
        issues: row.issues,
        action: 'CREATE',
        changes: [`opening stock ${quantity} ${product.unit} of ${product.sku}`],
        apply: async () => {
          const result = await this.inventory.recordOpeningStock({ productId: product.id, quantity, createdBy: actor.userId, notes: `Opening stock (import ${actor.jobId}, row ${rowNumber})` });
          return result.status === 'CREATED' ? 'CREATE' : 'UNCHANGED';
        },
      });
    }
    return planned;
  }
}
