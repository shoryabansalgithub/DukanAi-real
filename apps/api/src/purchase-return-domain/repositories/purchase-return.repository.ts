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
import { Prisma, PurchaseReturnStatus } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';
import { CreatePurchaseReturnDto, DispatchShipmentDto } from '../dto/purchase-return.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { InventoryMutationEngine } from '../../inventory-domain/services/inventory-mutation.engine';
import { Clock } from '../../common/time/clock';
import { lockDocument, shopFinancialYear } from '../../purchase-domain/procurement-support';

const CANCELLABLE: PurchaseReturnStatus[] = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL'];

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
    private readonly clock: Clock,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig
  ) {}

  async createPurchaseReturn(shopId: string, payload: CreatePurchaseReturnDto, actorId: string, ipAddress?: string) {
    const { supplierId, purchaseOrderId, goodsReceiptId, warehouseId, lines, ...metadata } = payload;

    return procurementTransaction(this.prisma, async (tx) => {
      // A deleted supplier takes no new documents (release audit S21).
      await assertOwned(tx, 'supplier', supplierId, shopId, { isDeleted: false });
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

      // Quantities, prices, variants and the warehouse are decided by the receipt lines before any row exists.
      const validated = await this.validation.validateReturnLines(tx, shopId, lines, { goodsReceiptId, supplierId, warehouseId });
      const warehouses = new Set([...validated.values()].map((v) => v.warehouseId));
      if (warehouses.size > 1) {
        throw new BadRequestException({ message: 'The lines of one return must come from receipts of one warehouse.', code: 'PURCHASE_RETURN_LINE_MISMATCH', details: { warehouses: [...warehouses] } });
      }
      const returnWarehouseId = warehouseId ?? [...warehouses][0] ?? null;
      const priced = lines.map((line) => {
        const ref = validated.get(line.grnLineId as string)!;
        const quantity = new Prisma.Decimal(line.returnQuantity).toDecimalPlaces(3);
        const unitPrice = ref.unitPrice;
        const base = quantity.mul(unitPrice);
        const taxPercentage = new Prisma.Decimal(line.taxPercentage ?? 0);
        const taxAmount = base.mul(taxPercentage).div(100).toDecimalPlaces(2);
        return { line, ref, quantity, unitPrice, taxPercentage, taxAmount, totalAmount: base.plus(taxAmount).toDecimalPlaces(2) };
      });
      const totalAmount = priced.reduce((sum, p) => sum.plus(p.totalAmount), new Prisma.Decimal(0)).toDecimalPlaces(2);
      const taxAmount = priced.reduce((sum, p) => sum.plus(p.taxAmount), new Prisma.Decimal(0)).toDecimalPlaces(2);

      const now = this.clock.now();
      const financialYear = await shopFinancialYear(tx, shopId, now);
      const { number: returnNumber } = await this.sequences.next(tx, shopId, 'PURCHASE_RETURN', `PR-${financialYear}-`);

      const pr = await tx.purchaseReturn.create({
        data: {
          shopId,
          supplierId,
          purchaseOrderId,
          goodsReceiptId,
          warehouseId: returnWarehouseId,
          returnNumber,
          status: 'DRAFT',
          returnType: metadata.returnType || 'CREDIT',
          priority: metadata.priority || 'NORMAL',
          reasonCode: metadata.reasonCode,
          expectedReturnDate: metadata.expectedReturnDate ? new Date(metadata.expectedReturnDate) : null,
          totalAmount,
          taxAmount,
          createdBy: actorId,
          createdAt: now,
          lines: {
            create: priced.map(({ line, ref, quantity, unitPrice, taxPercentage, taxAmount: lineTax, totalAmount: lineTotal }) => ({
              shopId,
              productId: line.productId,
              // The receipt line's variant: the stock row the goods leave (release audit S7).
              variantId: ref.variantId,
              purchaseOrderLineId: line.purchaseOrderLineId,
              grnLineId: line.grnLineId,
              returnQuantity: quantity,
              unitPrice,
              taxPercentage,
              taxAmount: lineTax,
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
    if (!pr) throw new NotFoundException({ message: `Purchase Return ${id} not found.`, code: 'PURCHASE_RETURN_NOT_FOUND' });

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

  /** The return row under lock (`FOR UPDATE`) with its lines: every state change reads the state it changes here. */
  private async lockReturn(tx: Prisma.TransactionClient, shopId: string, id: string) {
    await lockDocument(tx, 'PurchaseReturn', id, shopId, 'PURCHASE_RETURN_NOT_FOUND');
    return tx.purchaseReturn.findFirstOrThrow({ where: { id, shopId }, include: { lines: { where: { isDeleted: false } } } });
  }

  private async invalidate(shopId: string, id: string): Promise<void> {
    await this.cacheManager.del(`pr:${shopId}:${id}`);
  }

  /** DRAFT -> SUBMITTED -> PENDING_APPROVAL with one open approval step; quantities re-checked against other live returns. */
  async submitPurchaseReturn(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const pr = await this.lockReturn(tx, shopId, id);
      this.lifecycle.validateTransition(pr.status, 'SUBMITTED');

      await this.validation.validateReturnLines(tx, shopId, pr.lines, { excludeReturnId: pr.id, goodsReceiptId: pr.goodsReceiptId, supplierId: pr.supplierId, warehouseId: pr.warehouseId });

      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'SUBMITTED', actorId, 'Submitted for return processing');
      await this.lifecycle.transitionStatus(tx, id, shopId, 'SUBMITTED', 'PENDING_APPROVAL', actorId, 'Awaiting approval');
      await this.approval.openApproval(tx, shopId, id);
      await tx.purchaseReturnAudit.create({ data: { purchaseReturnId: id, shopId, actorId, action: 'SUBMITTED', newPayload: { status: 'PENDING_APPROVAL' } } });

      const updatedPr = await tx.purchaseReturn.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnSubmitted', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id, totalAmount: pr.totalAmount.toFixed(2), supplierId: pr.supplierId }, actorId });
      return updatedPr;
    });
    await this.invalidate(shopId, id);
    return result;
  }

  async approvePurchaseReturn(shopId: string, id: string, actorId: string, _ipAddress?: string, comments?: string, signature?: string) {
    return this.decide(shopId, id, actorId, 'APPROVE', comments, signature);
  }

  /** PENDING_APPROVAL -> REJECTED by a manager other than the creator or submitter (release audit S24). */
  async rejectPurchaseReturn(shopId: string, id: string, actorId: string, comments?: string) {
    return this.decide(shopId, id, actorId, 'REJECT', comments);
  }

  private async decide(shopId: string, id: string, actorId: string, action: 'APPROVE' | 'REJECT', comments?: string, signature?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const pr = await this.lockReturn(tx, shopId, id);
      if (pr.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException({ message: `A ${pr.status} purchase return is not waiting for a decision.`, code: 'PURCHASE_RETURN_NOT_PENDING', details: { status: pr.status } });
      }
      const status = await this.approval.processApproval(tx, shopId, id, actorId, action, comments, signature);
      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, status, actorId, comments ?? (status === 'APPROVED' ? 'Approved' : 'Rejected'));

      await this.eventPublisher.publish(tx, shopId, { eventType: status === 'APPROVED' ? 'PurchaseReturnApproved' : 'PurchaseReturnRejected', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id, approvalStatus: status }, actorId });
      return tx.purchaseReturn.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /** Withdraws a return before it is decided: DRAFT / SUBMITTED / PENDING_APPROVAL -> CANCELLED; the open approval step closes with it. */
  async cancelPurchaseReturn(shopId: string, id: string, actorId: string, comments?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const pr = await this.lockReturn(tx, shopId, id);
      if (!CANCELLABLE.includes(pr.status)) {
        throw new BadRequestException({ message: `A ${pr.status} purchase return cannot be cancelled.`, code: 'PURCHASE_RETURN_NOT_CANCELLABLE', details: { status: pr.status } });
      }
      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'CANCELLED', actorId, comments ?? 'Cancelled');
      await tx.purchaseReturnApproval.updateMany({ where: { purchaseReturnId: id, shopId, status: 'PENDING' }, data: { status: 'CANCELLED', approverId: actorId, comments } });
      await tx.purchaseReturnAudit.create({ data: { purchaseReturnId: id, shopId, actorId, action: 'CANCELLED', newPayload: { comments: comments ?? null } } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnCancelled', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id }, actorId });
      return tx.purchaseReturn.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  async dispatchShipment(shopId: string, id: string, payload: DispatchShipmentDto, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const pr = await this.lockReturn(tx, shopId, id);
      this.lifecycle.validateTransition(pr.status, 'SHIPPED');

      await this.shipment.createShipment(tx, shopId, id, payload);
      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'SHIPPED', actorId, 'Dispatched to Supplier');

      const updatedPr = await tx.purchaseReturn.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnShipmentCreated', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id }, actorId });
      return updatedPr;
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * Goods leave stock and the supplier is owed less; only an APPROVED or
   * SHIPPED return completes. Lock order: the return, product rows
   * ascending, the supplier, the ledger balances. Each line leaves the
   * warehouse its receipt put the goods in.
   */
  async completePurchaseReturn(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const pr = await this.lockReturn(tx, shopId, id);
      this.lifecycle.validateTransition(pr.status, 'COMPLETED');

      const grnLineIds = pr.lines.map((l) => l.grnLineId).filter((x): x is string => !!x);
      const receiptLines = await tx.goodsReceiptLine.findMany({ where: { id: { in: grnLineIds }, shopId }, select: { id: true, goodsReceipt: { select: { warehouseId: true } } } });
      const warehouseByGrnLine = new Map(receiptLines.map((l) => [l.id, l.goodsReceipt.warehouseId]));

      // Canonical lock order before any stock moves.
      await this.engine.lockProducts(tx, shopId, pr.lines.map((l) => l.productId));
      await this.inventory.processInventoryReversal(tx, shopId, {
        id: pr.id,
        warehouseId: pr.warehouseId,
        createdBy: pr.createdBy,
        supplierId: pr.supplierId,
        lines: pr.lines.map((line) => ({ ...line, warehouseId: line.grnLineId ? warehouseByGrnLine.get(line.grnLineId) ?? null : null })),
      });
      await this.finance.processFinancialReversal(tx, shopId, pr);

      await this.lifecycle.transitionStatus(tx, id, shopId, pr.status, 'COMPLETED', actorId, 'Return processing completed fully');

      const updatedPr = await tx.purchaseReturn.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'PurchaseReturnCompleted', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id, totalAmount: pr.totalAmount.toFixed(2) }, actorId });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'InventoryReversed', aggregateId: id, aggregateType: 'PurchaseReturn', payload: { id }, actorId });
      return updatedPr;
    });
    await this.invalidate(shopId, id);
    return result;
  }
}
