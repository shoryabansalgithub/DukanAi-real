import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';
import { SupplierPayablesService } from '../../ledger/supplier-payables.service';

export interface GrnIntegrationLine {
  /** GoodsReceiptLine id: the stock idempotency key is per line, not per product. */
  id?: string;
  productId: string;
  variantId?: string | null;
  acceptedQuantity: Prisma.Decimal | number | string;
  unitPrice: Prisma.Decimal | number | string;
  batchId?: string | null;
}

export interface GrnIntegrationInput {
  id: string;
  warehouseId?: string | null;
  createdBy?: string | null;
  /** The supplier owed for this receipt; its pendingPayables grows with the posted value. */
  supplierId?: string | null;
  lines: GrnIntegrationLine[];
}

@Injectable()
export class GrnIntegrationService {
  private readonly logger = new Logger(GrnIntegrationService.name);

  constructor(
    private readonly inventoryMutationEngine: InventoryMutationEngine,
    private readonly locationService: InventoryLocationService,
    private readonly ledger: LedgerPostingService,
    private readonly payables: SupplierPayablesService,
  ) {}

  /**
   * Translates GRN acceptance into inventory mutations through the single
   * mutation authority. Goods are received into the default bin of the GRN's
   * warehouse (or the shop's sale location when the GRN has no warehouse), so
   * received stock is exactly what the POS sells from.
   *
   * The stock value received (Σ unitPrice × acceptedQuantity over stocked
   * lines) is then posted once per GRN through `LedgerPostingService`:
   * DEBIT INVENTORY / CREDIT ACCOUNTS_PAYABLE. Lines the engine bypasses
   * (SERVICE / DIGITAL products) carry no stock value. The posting is
   * idempotent on `GRN <id>` so a retried acceptance never double-books.
   */
  async updateInventoryFromGrn(tx: Prisma.TransactionClient, shopId: string, grn: GrnIntegrationInput) {
    this.logger.debug(`Integrating GRN ${grn.id} with Inventory & Stock Ledger`);
    const locationId = await this.locationService.resolveWarehouseBin(tx, shopId, grn.warehouseId ?? null);

    let inventoryValue = new Prisma.Decimal(0);

    for (const line of grn.lines) {
      const accepted = new Prisma.Decimal(line.acceptedQuantity.toString());
      if (accepted.lessThanOrEqualTo(0)) continue;

      const result = await this.inventoryMutationEngine.mutateStock(tx, {
        shopId,
        locationId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantity: accepted.toNumber(),
        mutationType: MutationType.PURCHASE,
        reason: `GRN Acceptance: ${grn.id}`,
        referenceId: grn.id,
        performedBy: grn.createdBy || 'SYSTEM',
        occurredAt: new Date(),
        allowNegative: true,
        // One key per receipt line (roadmap 3.7, audit P2-25): two lines of the
        // same product are two receipts, a replayed line is skipped and never valued.
        idempotencyKey: `GRN:${grn.id}:${line.id ?? line.productId}`,
      });

      if (line.batchId) {
        this.logger.debug(`Batch ${line.batchId} received on GRN ${grn.id}`);
      }

      if (result.bypassed || result.idempotent) continue;
      inventoryValue = inventoryValue.plus(new Prisma.Decimal(line.unitPrice.toString()).times(accepted));
    }

    await this.postInventoryReceipt(tx, shopId, grn.id, inventoryValue.toDecimalPlaces(2), grn.supplierId);
  }

  private async postInventoryReceipt(tx: Prisma.TransactionClient, shopId: string, grnId: string, value: Prisma.Decimal, supplierId?: string | null) {
    if (value.lessThanOrEqualTo(0)) return;

    const description = `GRN ${grnId}`;

    // Idempotent at the database level: LedgerPosting (shopId, sourceType, sourceId) is unique.
    const result = await this.ledger.post(tx, {
      shopId,
      source: { type: 'GRN', id: grnId },
      invoiceId: null,
      description,
      entries: [
        { account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: value },
        { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.CREDIT, amount: value },
      ],
    });
    if (!result.posted) {
      this.logger.log(`Ledger posting for ${description} already exists. Skipped.`);
      return;
    }
    await this.payables.addPayable(tx, shopId, supplierId, value);
  }
}
