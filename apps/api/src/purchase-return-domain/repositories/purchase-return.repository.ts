import { Injectable, NotFoundException, Inject, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { PurchaseReturnLifecycleService } from '../services/purchase-return-lifecycle.service';
import { PurchaseReturnValidationService } from '../services/purchase-return-validation.service';
import { PurchaseReturnInventoryService } from '../services/purchase-return-inventory.service';
import { PurchaseReturnFinancialService } from '../services/purchase-return-financial.service';
import { PurchaseReturnShipmentService } from '../services/purchase-return-shipment.service';
import { PurchaseReturnApprovalService } from '../services/purchase-return-approval.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';
import { CreatePurchaseReturnDto, DispatchShipmentDto } from '../dto/purchase-return.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { InventoryMutationEngine } from '../../inventory-domain/services/inventory-mutation.engine';
import { financialYearLabel } from '../../common/time/business-day';

/**
 * Purchase returns (roadmap 4.2). Quantities are validated against the
 * goods-receipt lines before anything is written and again at submission
 * (excluding the return's own rows), prices come from the receipt line, the
 * return waits for an approver other than its creator (PENDING_APPROVAL on
 * submit), and completion moves the goods out of stock with the product rows
 * locked first. READ COMMITTED with a serialization retry throughout.
 */
@Injectable()
export class PurchaseReturnRepository {
  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: PurchaseReturnLifecycleService,
    private readonly validation: PurchaseReturnValidationService,
    private readonly inventory: PurchaseReturnInventoryService,
    private readonly finance: PurchaseReturnFinancialService,
    private readonly shipment: PurchaseReturnShipmentService,
    private readonly approval: PurchaseReturnApprovalService,
    private readonly eventPublisher: SalesEventPublisher,
    private readonly sequences: NumberSequenceService,
    private readonly engine: InventoryMutationEngine,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig
  ) {}

  async createPurchaseReturn(shopId: string, payload: CreatePurchaseReturnDto, actorId: string, ipAddress?: string) {
    const { supplierId, purchaseOrderId, goodsReceiptId, warehouseId, lines, ...metadata } = payload;

    return procurementTransaction(this.prisma, async (tx) => {
      await assertOwned(tx, 'supplier', supplierId, shopId);
      await assertOwned(tx, 'purchaseOrder', purchaseOrderId, shopId);
      await assertOwned(tx, 'goodsReceipt', goodsReceiptId, shopId);
      await assertOwned(tx, 'warehouse', warehouseId, shopId);
      await assertOwnedMany(tx, 'product', lines.map((l) => l.productId), shopId);
      await assertOwnedMany(tx, 'productVariant', lines.map((l) => l.variantId), shopId);
      await assertOwnedMany(tx, 'purchaseOrderItem', lines.map((l) => l.purchaseOrderLineId), shopId);
      await assertOwnedMany(tx, 'goodsReceiptLine', lines.map((l) => l.grnLineId), shopId);
      if (goodsReceiptId) {
        const grn = await tx.goodsReceipt.findFirst({ where: { id: goodsReceiptId, shopId }, select: { supplierId: true } });
        if (grn && grn.supplierId !== supplierId) throw new BadRequestException({ message: 'The return names a different supplier than the goods receipt.', code: 'PURCHASE_RETURN_SUPPLIER_MISMATCH' });
      }

      // Quantities and prices are decided against the receipt lines before any row exists.
      const validated = await this.validation.validateReturnLines(tx, shopId, lines, { goodsReceiptId });
      const priced = lines.map((line) => {
        const ref = validated.get(line.grnLineId as string)!;
        const quantity = new Prisma.Decimal(line.returnQuantity).toDecimalPlaces(3);
        const unitPrice = ref.unitPrice;
        const base = quantity.mul(unitPrice);
        const taxPercentage = new Prisma.Decimal(line.taxPercentage ?? 0);
        const taxAmount = base.mul(taxPercentage).div(100).toDecimalPlaces(2);
        return { line, quantity, unitPrice, taxPercentage, taxAmount, totalAmount: base.plus(taxAmount).toDecimalPlaces(2) };
      });
      const totalAmount = priced.reduce((sum, p) => sum.plus(p.totalAmount), new Prisma.Decimal(0)).toDecimalPlaces(2);

      const financialYear = financialYearLabel(new Date(), 'Asia/Kolkata');
      const { number: returnNumber } = await this.sequences.next(tx, shopId, 'PURCHASE_RETURN', `PR-${financialYear}-`);

      const pr = await tx.purchaseReturn.create({
        data: {
          shopId,
          supplierId,
          purchaseOrderId,
          goodsReceiptId,
          warehouseId,
          returnNumber,
          status: 'DRAFT',
          returnType: metadata.returnType || 'CREDIT',
          priority: metadata.priority || 'NORMAL',
          reasonCode: metadata.reasonCode,
          expectedReturnDate: metadata.expectedReturnDate ? new Date(metadata.expectedReturnDate) : null,
          totalAmount,
          createdBy: actorId,
          lines: {
            create: priced.map(({ line, quantity, unitPrice, taxPercentage, taxAmount, totalAmount: lineTotal }) => ({
              shopId,
              productId: line.productId,
              variantId: line.variantId,
              purchaseOrderLineId: line.purchaseOrderLineId,
              grnLineId: line.grnLineId,
              returnQuantity: quantity,
              unitPrice,
              taxPercentage,
              taxAmount,
              totalAmount: lineTotal,
              reason: line.reason,
              condition: line.condition || 'DAMAGED'
            }))
          }
        },
        include: { lines: true }
      });

      await tx.purchaseReturnAudit.create({ data: { purchaseReturnId: pr.id, shopId, actorId, action: 'CREATED', newPayload: pr as never, ipAddress } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnCreated', aggregateId: pr.id, aggregateType: 'PurchaseReturn', payload: { id: pr.id, returnNumber }, actorId });

      return pr;
    });
  }

  async getPurchaseReturn(shopId: string, id: string) {
    const cacheKey = `pr:${shopId}:${id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const pr = await this.prisma.purchaseReturn.findFirst({
      where: { id, shopId, isDeleted: false },
      include: {
        lines: true,
        attachments: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
        shipments: true,
        approvals: true,
        replacements: true
      }
    });
    if (!pr) throw new NotFoundException(`Purchase Return ${id} not found.`);

    await this.cacheManager.set(cacheKey, pr, this.cacheConfig.purchaseReturnTtlMs);
    return pr;
  }

  async listPurchaseReturns(shopId: string, limit: number = 50, offset: number = 0) {
    return this.prisma.purchaseReturn.findMany({
      where: { shopId, isDeleted: false },
      include: { supplier: true, warehouse: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset
    });
  }

  /** DRAFT -> SUBMITTED -> PENDING_APPROVAL with one open approval step; quantities re-checked against other live returns. */
  async submitPurchaseReturn(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const pr = await tx.purchaseReturn.findFirst({ where: { id, shopId, isDeleted: false }, include: { lines: true } });
      if (!pr) throw new NotFoundException({ message: 'Purchase return not found', code: 'PURCHASE_RETURN_NOT_FOUND' });

      await this.validation.validateReturnLines(tx, shopId, pr.lines, { excludeReturnId: pr.id, goodsReceiptId: pr.goodsReceiptId });

      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'SUBMITTED', actorId, 'Submitted for return processing');
      await this.lifecycle.transitionStatus(tx, id, shopId, 'SUBMITTED', 'PENDING_APPROVAL', actorId, 'Awaiting approval');
      await this.approval.openApproval(tx, shopId, id);
      await tx.purchaseReturnAudit.create({ data: { purchaseReturnId: id, shopId, actorId, action: 'SUBMITTED', newPayload: { status: 'PENDING_APPROVAL' } } });

      const updatedPr = await tx.purchaseReturn.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnSubmitted', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id, totalAmount: pr.totalAmount.toFixed(2), supplierId: pr.supplierId }, actorId });

      await this.cacheManager.del(`pr:${shopId}:${id}`);
      return updatedPr;
    });
  }

  async approvePurchaseReturn(shopId: string, id: string, actorId: string, _ipAddress?: string, comments?: string, signature?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const pr = await tx.purchaseReturn.findFirst({ where: { id, shopId, isDeleted: false } });
      if (!pr) throw new NotFoundException({ message: 'Purchase return not found', code: 'PURCHASE_RETURN_NOT_FOUND' });
      const status = await this.approval.processApproval(tx, shopId, id, actorId, 'APPROVE', comments, signature);
      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, status, actorId, comments ?? 'Approved');

      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnApproved', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id, approvalStatus: status }, actorId });

      await this.cacheManager.del(`pr:${shopId}:${id}`);
      return tx.purchaseReturn.findFirst({ where: { id, shopId } });
    });
  }

  async dispatchShipment(shopId: string, id: string, payload: DispatchShipmentDto, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const pr = await tx.purchaseReturn.findFirst({ where: { id, shopId, isDeleted: false } });
      if (!pr) throw new NotFoundException({ message: 'Purchase return not found', code: 'PURCHASE_RETURN_NOT_FOUND' });

      await this.shipment.createShipment(tx, shopId, id, payload);
      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'SHIPPED', actorId, 'Dispatched to Supplier');

      const updatedPr = await tx.purchaseReturn.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnShipmentCreated', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id }, actorId });

      await this.cacheManager.del(`pr:${shopId}:${id}`);
      return updatedPr;
    });
  }

  /** Goods leave stock and the supplier is owed less; only an APPROVED or SHIPPED return completes. */
  async completePurchaseReturn(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const pr = await tx.purchaseReturn.findFirst({ where: { id, shopId, isDeleted: false }, include: { lines: true } });
      if (!pr) throw new NotFoundException({ message: 'Purchase return not found', code: 'PURCHASE_RETURN_NOT_FOUND' });
      this.lifecycle.validateTransition(pr.status, 'COMPLETED');

      // Canonical lock order before any stock moves.
      await this.engine.lockProducts(tx, shopId, pr.lines.map((l) => l.productId));
      await this.inventory.processInventoryReversal(tx, shopId, pr);
      await this.finance.processFinancialReversal(tx, shopId, pr);

      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'COMPLETED', actorId, 'Return processing completed fully');

      const updatedPr = await tx.purchaseReturn.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnCompleted', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id, totalAmount: pr.totalAmount.toFixed(2) }, actorId });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'InventoryReversed', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id }, actorId });

      await this.cacheManager.del(`pr:${shopId}:${id}`);
      return updatedPr;
    });
  }
}
