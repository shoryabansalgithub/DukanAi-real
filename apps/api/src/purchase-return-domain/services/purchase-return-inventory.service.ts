import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';

export interface PurchaseReturnInventoryLine {
  productId: string;
  returnQuantity: Prisma.Decimal | number | string;
  unitPrice: Prisma.Decimal | number | string;
}

export interface PurchaseReturnInventoryInput {
  id: string;
  warehouseId?: string | null;
  createdBy?: string | null;
  lines: PurchaseReturnInventoryLine[];
}

@Injectable()
export class PurchaseReturnInventoryService {
  private readonly logger = new Logger(PurchaseReturnInventoryService.name);

  constructor(
    private readonly inventoryMutationEngine: InventoryMutationEngine,
    private readonly locationService: InventoryLocationService,
    private readonly ledger: LedgerPostingService,
  ) {}

  /**
   * Goods going back to a supplier leave stock: a PURCHASE_RETURN mutation
   * (direction -1) at the default bin of the return's warehouse.
   *
   * The stock value leaving (Σ unitPrice × returnQuantity over stocked lines)
   * mirrors the GRN posting: DEBIT ACCOUNTS_PAYABLE / CREDIT INVENTORY, once
   * per return, idempotent on `Purchase return <id>`. Lines the engine
   * bypasses (SERVICE / DIGITAL products) carry no stock value.
   */
  async processInventoryReversal(tx: Prisma.TransactionClient, shopId: string, returnAggregate: PurchaseReturnInventoryInput) {
    const locationId = await this.locationService.resolveWarehouseBin(tx, shopId, returnAggregate.warehouseId ?? null);

    let inventoryValue = new Prisma.Decimal(0);

    for (const line of returnAggregate.lines) {
      const returnQty = new Prisma.Decimal(line.returnQuantity.toString());
      if (returnQty.lessThanOrEqualTo(0)) continue;

      const result = await this.inventoryMutationEngine.mutateStock(tx, {
        shopId,
        locationId,
        productId: line.productId,
        quantity: returnQty.toNumber(),
        mutationType: MutationType.PURCHASE_RETURN,
        reason: `Purchase Return: ${returnAggregate.id}`,
        referenceId: returnAggregate.id,
        performedBy: returnAggregate.createdBy || 'SYSTEM',
        occurredAt: new Date(),
        // Supplier returns are physically confirmed; do not block on a stale count.
        allowNegative: true,
        idempotencyKey: `PRET:${returnAggregate.id}:${line.productId}`,
      });

      if (result.bypassed) continue;
      inventoryValue = inventoryValue.plus(new Prisma.Decimal(line.unitPrice.toString()).times(returnQty));
    }
    this.logger.debug(`Purchase return ${returnAggregate.id} deducted from location ${locationId}`);

    await this.postInventoryReturn(tx, shopId, returnAggregate.id, inventoryValue.toDecimalPlaces(2));
  }

  private async postInventoryReturn(tx: Prisma.TransactionClient, shopId: string, returnId: string, value: Prisma.Decimal) {
    if (value.lessThanOrEqualTo(0)) return;

    const description = `Purchase return ${returnId}`;

    // Idempotent at the database level: LedgerPosting (shopId, sourceType, sourceId) is unique.
    const result = await this.ledger.post(tx, {
      shopId,
      source: { type: 'PURCHASE_RETURN', id: returnId },
      invoiceId: null,
      description,
      entries: [
        { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.DEBIT, amount: value },
        { account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: value },
      ],
    });
    if (!result.posted) this.logger.log(`Ledger posting for ${description} already exists. Skipped.`);
  }
}
