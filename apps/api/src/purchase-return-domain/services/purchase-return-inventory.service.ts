import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { SupplierPayablesService } from '../../ledger/supplier-payables.service';

export interface PurchaseReturnInventoryLine {
  /** PurchaseReturnLine id: the stock idempotency key is per line, not per product. */
  id?: string;
  productId: string;
  variantId?: string | null;
  returnQuantity: Prisma.Decimal | number | string;
  unitPrice: Prisma.Decimal | number | string;
  /** The warehouse the goods were received into (the receipt's); falls back to the return's. */
  warehouseId?: string | null;
}

export interface PurchaseReturnInventoryInput {
  id: string;
  warehouseId?: string | null;
  createdBy?: string | null;
  /** The supplier the goods go back to; its pendingPayables shrinks with the posted value. */
  supplierId?: string | null;
  lines: PurchaseReturnInventoryLine[];
}

@Injectable()
export class PurchaseReturnInventoryService {
  private readonly logger = new Logger(PurchaseReturnInventoryService.name);

  constructor(
    private readonly inventoryMutationEngine: InventoryMutationEngine,
    private readonly locationService: InventoryLocationService,
    private readonly payables: SupplierPayablesService,
  ) {}

  /**
   * Goods going back to a supplier leave stock: a PURCHASE_RETURN mutation
   * (direction -1) at the default bin of the warehouse the receipt put them
   * in (release audit S7: the line's receipt decides, not the client).
   *
   * The stock value leaving (Σ unitPrice × returnQuantity over stocked lines)
   * mirrors the GRN posting: DEBIT ACCOUNTS_PAYABLE / CREDIT INVENTORY, once
   * per return, idempotent on `Purchase return <id>`, with the supplier row
   * locked before the ledger (release audit S15). Lines the engine bypasses
   * (SERVICE / DIGITAL products) carry no stock value.
   */
  async processInventoryReversal(tx: Prisma.TransactionClient, shopId: string, returnAggregate: PurchaseReturnInventoryInput) {
    const locations = new Map<string, string>();
    const locationFor = async (warehouseId: string | null) => {
      const key = warehouseId ?? '';
      if (!locations.has(key)) locations.set(key, await this.locationService.resolveWarehouseBin(tx, shopId, warehouseId));
      return locations.get(key)!;
    };

    let inventoryValue = new Prisma.Decimal(0);

    for (const line of returnAggregate.lines) {
      const returnQty = new Prisma.Decimal(line.returnQuantity.toString());
      if (returnQty.lessThanOrEqualTo(0)) continue;
      const locationId = await locationFor(line.warehouseId || returnAggregate.warehouseId || null);

      const result = await this.inventoryMutationEngine.mutateStock(tx, {
        shopId,
        locationId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantity: returnQty.toNumber(),
        mutationType: MutationType.PURCHASE_RETURN,
        reason: `Purchase Return: ${returnAggregate.id}`,
        referenceId: returnAggregate.id,
        performedBy: returnAggregate.createdBy || 'SYSTEM',
        occurredAt: new Date(),
        // Supplier returns are physically confirmed; do not block on a stale count.
        allowNegative: true,
        // One key per return line (roadmap 3.7, audit P2-25).
        idempotencyKey: `PRET:${returnAggregate.id}:${line.id ?? line.productId}`,
      });

      if (result.bypassed || result.idempotent) continue;
      inventoryValue = inventoryValue.plus(new Prisma.Decimal(line.unitPrice.toString()).times(returnQty));
    }
    this.logger.debug(`Purchase return ${returnAggregate.id} deducted from ${[...locations.values()].join(', ')}`);

    await this.postInventoryReturn(tx, shopId, returnAggregate.id, inventoryValue.toDecimalPlaces(2), returnAggregate.supplierId);
  }

  private async postInventoryReturn(tx: Prisma.TransactionClient, shopId: string, returnId: string, value: Prisma.Decimal, supplierId?: string | null) {
    if (value.lessThanOrEqualTo(0)) return;

    const description = `Purchase return ${returnId}`;

    // Idempotent at the database level: LedgerPosting (shopId, sourceType, sourceId) is unique.
    // A balance below zero afterwards is an advance the supplier holds (release audit S17), never floored.
    const result = await this.payables.postWithPayable(
      tx,
      supplierId,
      {
        shopId,
        source: { type: 'PURCHASE_RETURN', id: returnId },
        invoiceId: null,
        description,
        entries: [
          { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.DEBIT, amount: value },
          { account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: value },
        ],
      },
      value.negated(),
    );
    if (!result.posted) this.logger.log(`Ledger posting for ${description} already exists. Skipped.`);
  }
}
