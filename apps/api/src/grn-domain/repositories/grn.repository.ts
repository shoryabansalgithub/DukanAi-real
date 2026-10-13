import { Injectable, NotFoundException, Inject, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { GrnLifecycleService } from '../services/grn-lifecycle.service';
import { GrnApprovalService } from '../services/grn-approval.service';
import { GrnInspectionService } from '../services/grn-inspection.service';
import { GrnIntegrationService } from '../services/grn-integration.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { GoodsReceiptStatus, Prisma } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';
import { CreateGoodsReceiptDto, InspectGoodsDto, ReceiveGoodsDto } from '../dto/goods-receipt.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { PurchaseReceiptService } from '../../purchase-domain/services/purchase-receipt.service';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { Clock } from '../../common/time/clock';
import { lockDocument, netUnitCost, shopFinancialYear } from '../../purchase-domain/procurement-support';

const D = (v: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(v?.toString() ?? 0);

/** Receipt states before acceptance: nothing is in stock yet, so the receipt can still be refused or withdrawn (release audit S24). */
const REJECTABLE: GoodsReceiptStatus[] = ['RECEIVING', 'PARTIALLY_RECEIVED', 'QUALITY_INSPECTION'];
const CANCELLABLE: GoodsReceiptStatus[] = ['DRAFT', 'RECEIVING', 'PARTIALLY_RECEIVED', 'QUALITY_INSPECTION'];

/**
 * Goods receipts (roadmap 4.2). The purchase order is the authority: a
 * receipt is created against a receivable order, every line fulfils one
 * order line (ordered quantity and the net unit cost come from it), received
 * and accepted quantities are capped at what is still outstanding on that
 * line across every receipt of the order, inspection results decide what is
 * accepted, and acceptance moves the goods into stock (product rows locked
 * in ascending id first) and the order to PARTIALLY_RECEIVED / RECEIVED.
 * Every state change locks the receipt row and moves its status with a
 * compare-and-set; cache entries are dropped after the commit.
 * Every transaction is READ COMMITTED with a serialization retry.
 */
@Injectable()
export class GrnRepository {
  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: GrnLifecycleService,
    private readonly approval: GrnApprovalService,
    private readonly inspection: GrnInspectionService,
    private readonly integration: GrnIntegrationService,
    private readonly eventPublisher: SalesEventPublisher,
    private readonly sequences: NumberSequenceService,
    private readonly orders: PurchaseReceiptService,
    private readonly locations: InventoryLocationService,
    private readonly clock: Clock,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig
  ) {}

  /**
   * The warehouse a receipt lands in. An explicit warehouse is honoured
   * (it must be the shop's). Without one, the goods go to the warehouse of
   * the POS sale location, so they can be sold at once; a shop that runs
   * more than that one warehouse must say which (400 GRN_WAREHOUSE_REQUIRED).
   */
  private async resolveReceiptWarehouse(tx: Prisma.TransactionClient, shopId: string, warehouseId: string | undefined): Promise<string> {
    if (warehouseId) {
      await assertOwned(tx, 'warehouse', warehouseId, shopId, { isDeleted: false });
      return warehouseId;
    }
    const saleLocationId = await this.locations.resolveSaleLocation(tx, shopId);
    const saleLocation = await tx.location.findFirstOrThrow({ where: { id: saleLocationId, shopId }, select: { warehouseId: true } });
    const others = await tx.warehouse.count({ where: { shopId, isDeleted: false, id: { not: saleLocation.warehouseId } } });
    if (others > 0) {
      throw new BadRequestException({ message: 'This shop has more than one warehouse: name the warehouse the goods are received into.', code: 'GRN_WAREHOUSE_REQUIRED' });
    }
    return saleLocation.warehouseId;
  }

  async createGoodsReceipt(shopId: string, payload: CreateGoodsReceiptDto, actorId: string, ipAddress?: string) {
    const { purchaseOrderId, supplierId, warehouseId: requestedWarehouseId, lines, ...metadata } = payload;

    return procurementTransaction(this.prisma, async (tx) => {
      const order = await this.orders.lockReceivableOrder(tx, shopId, purchaseOrderId);
      // A deleted supplier takes no new documents (release audit S21).
      await assertOwned(tx, 'supplier', supplierId, shopId, { isDeleted: false });
      if (order.supplierId !== supplierId) {
        throw new BadRequestException({ message: 'The receipt names a different supplier than the purchase order.', code: 'GRN_SUPPLIER_MISMATCH' });
      }
      const warehouseId = await this.resolveReceiptWarehouse(tx, shopId, requestedWarehouseId);
      await assertOwnedMany(tx, 'product', lines.map((l) => l.productId), shopId);
      await assertOwnedMany(tx, 'productVariant', lines.map((l) => l.variantId), shopId);

      // Each receipt line fulfils one order line; a line may appear once per receipt.
      const seen = new Set<string>();
      const resolved = lines.map((line) => {
        const orderLine = this.orders.resolveOrderLine(order.lines, line);
        if (seen.has(orderLine.id)) throw new BadRequestException({ message: 'An order line appears twice on the receipt.', code: 'GRN_LINE_DUPLICATE', details: { purchaseOrderItemId: orderLine.id } });
        seen.add(orderLine.id);
        const outstanding = Prisma.Decimal.max(orderLine.quantity.minus(orderLine.acceptedElsewhere), 0);
        const received = D(line.receivedQuantity ?? 0).toDecimalPlaces(3);
        if (received.greaterThan(outstanding)) {
          throw new BadRequestException({
            message: `Received quantity exceeds what is still outstanding on the order line (${outstanding.toString()}).`,
            code: 'GRN_OVER_RECEIPT',
            details: { purchaseOrderItemId: orderLine.id, ordered: orderLine.quantity.toString(), acceptedElsewhere: orderLine.acceptedElsewhere.toString(), received: received.toString() },
          });
        }
        return { line, orderLine, outstanding, received };
      });

      const now = this.clock.now();
      const financialYear = await shopFinancialYear(tx, shopId, now);
      const { number: grnNumber } = await this.sequences.next(tx, shopId, 'GOODS_RECEIPT', `GRN-${financialYear}-`);

      const grn = await tx.goodsReceipt.create({
        data: {
          shopId,
          purchaseOrderId,
          supplierId,
          warehouseId,
          grnNumber,
          status: 'DRAFT',
          expectedDate: metadata.expectedDate ? new Date(metadata.expectedDate) : null,
          vehicleNumber: metadata.vehicleNumber,
          transporter: metadata.transporter,
          trackingNumber: metadata.trackingNumber,
          notes: metadata.notes,
          createdBy: actorId,
          createdAt: now,
          lines: {
            create: resolved.map(({ line, orderLine, outstanding, received }) => ({
              shopId,
              purchaseOrderItemId: orderLine.id,
              productId: line.productId,
              variantId: orderLine.variantId,
              orderedQuantity: outstanding,
              receivedQuantity: received,
              pendingQuantity: outstanding.minus(received),
              unit: line.unit ?? orderLine.unit ?? undefined,
              // The stock is valued at what it costs the shop: the order line's
              // price after its discount, GST excluded (release audit S3).
              unitPrice: netUnitCost(orderLine),
              remarks: line.remarks
            }))
          }
        },
        include: { lines: true }
      });

      await tx.goodsReceiptAudit.create({ data: { goodsReceiptId: grn.id, shopId, actorId, action: 'CREATED', newPayload: grn as never, ipAddress } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'GRNCreated', aggregateId: grn.id, aggregateType: 'GoodsReceipt', payload: { id: grn.id, grnNumber, purchaseOrderId }, actorId });

      return grn;
    });
  }

  async getGoodsReceipt(shopId: string, id: string) {
    const cacheKey = `grn:${shopId}:${id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id, shopId, isDeleted: false },
      include: {
        lines: true,
        attachments: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
        inspections: true,
        approvals: true,
        comments: true
      }
    });
    if (!grn) throw new NotFoundException({ message: `Goods Receipt ${id} not found.`, code: 'GRN_NOT_FOUND' });

    await this.cacheManager.set(cacheKey, grn, this.cacheConfig.grnTtlMs);
    return grn;
  }

  async listGoodsReceipts(shopId: string, limit: number = 50, offset: number = 0) {
    return this.prisma.goodsReceipt.findMany({
      where: { shopId, isDeleted: false },
      include: { supplier: true, warehouse: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset
    });
  }

  /** Drops the cached copies after the transaction committed (a reader between the delete and the commit would re-cache the old state). */
  private async invalidate(shopId: string, id: string, purchaseOrderId?: string): Promise<void> {
    await this.cacheManager.del(`grn:${shopId}:${id}`);
    if (purchaseOrderId) await this.cacheManager.del(`po:${shopId}:${purchaseOrderId}`);
  }

  /** The receipt row under lock with its lines: every state change reads the state it changes here. */
  private async lockReceipt(tx: Prisma.TransactionClient, shopId: string, id: string) {
    await lockDocument(tx, 'GoodsReceipt', id, shopId, 'GRN_NOT_FOUND');
    return tx.goodsReceipt.findFirstOrThrow({ where: { id, shopId }, include: { lines: true, inspections: { select: { id: true }, take: 1 } } });
  }

  /** Records what physically arrived, per line, capped at the line's outstanding order quantity. */
  async receiveGoods(shopId: string, id: string, payload: ReceiveGoodsDto, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const grn = await this.lockReceipt(tx, shopId, id);

      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'RECEIVING', actorId, 'Goods received');

      await assertOwnedMany(tx, 'batch', payload.lines.map((l) => l.batchId), shopId);
      await assertOwnedMany(tx, 'location', payload.lines.map((l) => l.binId), shopId);
      const byId = new Map(grn.lines.map((l) => [l.id, l]));
      for (const lineUpdate of payload.lines) {
        const line = byId.get(lineUpdate.id);
        if (!line) throw new NotFoundException({ message: `Receipt line ${lineUpdate.id} not found`, code: 'GRN_LINE_NOT_FOUND' });
        const received = D(lineUpdate.receivedQuantity).toDecimalPlaces(3);
        if (received.greaterThan(line.orderedQuantity)) {
          throw new BadRequestException({ message: `Received quantity exceeds the outstanding order quantity (${line.orderedQuantity.toString()}).`, code: 'GRN_OVER_RECEIPT', details: { lineId: line.id } });
        }
        await tx.goodsReceiptLine.update({
          where: { id: lineUpdate.id },
          data: { receivedQuantity: received, pendingQuantity: line.orderedQuantity.minus(received), batchId: lineUpdate.batchId, serialId: lineUpdate.serialId, binId: lineUpdate.binId }
        });
      }
      await tx.goodsReceipt.update({ where: { id }, data: { receivedDate: this.clock.now() } });

      const updatedGrn = await tx.goodsReceipt.findFirst({ where: { id, shopId }, include: { lines: true } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'GRNReceived', aggregateId: id, aggregateType: 'GoodsReceipt', payload: { id }, actorId });
      return updatedGrn;
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * Records the inspection and applies it to the lines: explicit per-line
   * accepted / rejected / damaged quantities, or, without lines, everything
   * received is accepted (PASS, CONDITIONAL_PASS, HOLD) or rejected (FAIL,
   * REJECT). A REJECT closes the receipt as REJECTED.
   */
  async inspectGoods(shopId: string, id: string, payload: InspectGoodsDto, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const grn = await this.lockReceipt(tx, shopId, id);

      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'QUALITY_INSPECTION', actorId, `Inspection: ${payload.status}`);
      await this.inspection.processInspection(tx, shopId, id, payload, actorId);

      const byId = new Map(grn.lines.map((l) => [l.id, l]));
      const rejectAll = payload.status === 'FAIL' || payload.status === 'REJECT';
      const outcomes = payload.lines
        ? payload.lines.map((l) => {
            const line = byId.get(l.id);
            if (!line) throw new NotFoundException({ message: `Receipt line ${l.id} not found`, code: 'GRN_LINE_NOT_FOUND' });
            const accepted = D(l.acceptedQuantity).toDecimalPlaces(3);
            const rejected = D(l.rejectedQuantity ?? 0).toDecimalPlaces(3);
            const damaged = D(l.damagedQuantity ?? 0).toDecimalPlaces(3);
            if (accepted.plus(rejected).plus(damaged).greaterThan(line.receivedQuantity)) {
              throw new BadRequestException({ message: 'Accepted, rejected and damaged quantities exceed what was received.', code: 'GRN_INSPECTION_EXCEEDS_RECEIVED', details: { lineId: line.id, received: line.receivedQuantity.toString() } });
            }
            return { line, accepted, rejected, damaged };
          })
        : grn.lines.map((line) => ({ line, accepted: rejectAll ? new Prisma.Decimal(0) : line.receivedQuantity, rejected: rejectAll ? line.receivedQuantity : new Prisma.Decimal(0), damaged: new Prisma.Decimal(0) }));
      for (const { line, accepted, rejected, damaged } of outcomes) {
        await tx.goodsReceiptLine.update({ where: { id: line.id }, data: { acceptedQuantity: accepted, rejectedQuantity: rejected, damagedQuantity: damaged, pendingQuantity: line.orderedQuantity.minus(accepted) } });
      }
      if (payload.status === 'REJECT') await this.lifecycle.transitionStatus(tx, id, shopId, 'QUALITY_INSPECTION', 'REJECTED', actorId, 'Rejected at inspection');

      await this.eventPublisher.publish(tx, shopId, { eventType: 'InspectionCompleted', aggregateId: id, aggregateType: 'GoodsReceipt', payload: { id, status: payload.status }, actorId });
      return { success: true, status: payload.status === 'REJECT' ? 'REJECTED' : 'QUALITY_INSPECTION' };
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * Accepts the goods into stock. Without an inspection everything received
   * is accepted; with one, the inspected quantities stand. The order's lines
   * are re-checked under the order lock so that the accepted total over all
   * receipts never exceeds what was ordered. Lock order: order header, the
   * receipt, product rows ascending, the supplier, the ledger balances.
   */
  async acceptGoods(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    const { response, purchaseOrderId } = await procurementTransaction(this.prisma, async (tx) => {
      const header = await tx.goodsReceipt.findFirst({ where: { id, shopId, isDeleted: false }, select: { purchaseOrderId: true } });
      if (!header) throw new NotFoundException({ message: 'Goods receipt not found', code: 'GRN_NOT_FOUND' });

      // Canonical lock order: order header, then the receipt, then product rows ascending, before any stock moves.
      const order = await this.orders.lockReceivableOrder(tx, shopId, header.purchaseOrderId, id);
      const grn = await this.lockReceipt(tx, shopId, id);
      this.lifecycle.validateTransition(grn.status, 'ACCEPTED');
      if (grn.lines.every((l) => l.receivedQuantity.isZero())) {
        throw new BadRequestException({ message: 'Nothing has been received on this goods receipt.', code: 'GRN_NOTHING_RECEIVED' });
      }

      const inspected = grn.inspections.length > 0;
      for (const line of grn.lines) {
        const accepted = inspected ? line.acceptedQuantity : line.receivedQuantity;
        const orderLine = line.purchaseOrderItemId ? order.lines.find((l) => l.id === line.purchaseOrderItemId) : undefined;
        if (orderLine) {
          const outstanding = Prisma.Decimal.max(orderLine.quantity.minus(orderLine.acceptedElsewhere), 0);
          if (accepted.greaterThan(outstanding)) {
            throw new BadRequestException({ message: `Accepting ${accepted.toString()} would exceed the order line (${outstanding.toString()} outstanding).`, code: 'GRN_OVER_RECEIPT', details: { purchaseOrderItemId: orderLine.id } });
          }
        }
        await tx.goodsReceiptLine.update({
          where: { id: line.id },
          data: { acceptedQuantity: accepted, pendingQuantity: Prisma.Decimal.max(line.orderedQuantity.minus(accepted), 0) },
        });
      }

      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'ACCEPTED', actorId, 'Goods accepted into stock');

      const updatedGrn = await tx.goodsReceipt.findFirst({ where: { id, shopId }, include: { lines: true } });
      if (!updatedGrn) throw new NotFoundException({ message: 'Goods receipt not found', code: 'GRN_NOT_FOUND' });
      const totals = updatedGrn.lines.reduce(
        (acc, l) => ({ quantity: acc.quantity.plus(l.acceptedQuantity), value: acc.value.plus(l.acceptedQuantity.mul(l.unitPrice)) }),
        { quantity: new Prisma.Decimal(0), value: new Prisma.Decimal(0) },
      );
      await tx.goodsReceipt.update({ where: { id }, data: { totalQuantity: totals.quantity, totalValue: totals.value.toDecimalPlaces(2), receivedDate: updatedGrn.receivedDate ?? this.clock.now() } });

      // Stock, cost and ledger through the inventory and payables authorities, then the order's received state.
      await this.integration.updateInventoryFromGrn(tx, shopId, updatedGrn);
      const orderStatus = await this.orders.recordAcceptance(tx, shopId, header.purchaseOrderId, actorId, updatedGrn.grnNumber);
      await this.approval.openApproval(tx, shopId, id);

      await this.eventPublisher.publish(tx, shopId, { eventType: 'GoodsAccepted', aggregateId: id, aggregateType: 'GoodsReceipt', payload: { id, purchaseOrderId: header.purchaseOrderId, orderStatus }, actorId });

      return { response: { ...updatedGrn, status: 'ACCEPTED' as const, orderStatus }, purchaseOrderId: header.purchaseOrderId };
    });
    await this.invalidate(shopId, id, purchaseOrderId);
    return response;
  }

  /** A manager other than the receiver completes the receipt; a rejection leaves it ACCEPTED for review. */
  async approveGrn(shopId: string, id: string, actorId: string, _ipAddress?: string, comments?: string, signature?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const grn = await this.lockReceipt(tx, shopId, id);
      const status = await this.approval.processApproval(tx, shopId, id, actorId, 'APPROVE', comments, signature);
      if (status === 'APPROVED') await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'COMPLETED', actorId, comments ?? 'Approved');

      await this.eventPublisher.publish(tx, shopId, { eventType: 'GRNCompleted', aggregateId: id, aggregateType: 'GoodsReceipt', payload: { id, approvalStatus: status }, actorId });
      return tx.goodsReceipt.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * Refuses the delivery before it is accepted (nothing is in stock yet):
   * RECEIVING / PARTIALLY_RECEIVED / QUALITY_INSPECTION -> REJECTED. Decided
   * by a manager other than the receiver (separation of duties, like the
   * approval); the receiver withdraws a receipt with cancel instead.
   */
  async rejectGrn(shopId: string, id: string, actorId: string, comments?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const grn = await this.lockReceipt(tx, shopId, id);
      if (!REJECTABLE.includes(grn.status)) {
        throw new BadRequestException({ message: `A ${grn.status} goods receipt cannot be rejected.`, code: 'GRN_NOT_REJECTABLE', details: { status: grn.status } });
      }
      await this.assertNotCreator(tx, shopId, id, grn.createdBy, actorId, 'reject');
      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'REJECTED', actorId, comments ?? 'Delivery rejected');
      await tx.goodsReceiptAudit.create({ data: { goodsReceiptId: id, shopId, actorId, action: 'REJECTED', newPayload: { comments: comments ?? null } } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'GRNRejected', aggregateId: id, aggregateType: 'GoodsReceipt', payload: { id }, actorId });
      return tx.goodsReceipt.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /** Withdraws a receipt before its goods are accepted: DRAFT / RECEIVING / PARTIALLY_RECEIVED / QUALITY_INSPECTION -> CANCELLED. */
  async cancelGrn(shopId: string, id: string, actorId: string, comments?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const grn = await this.lockReceipt(tx, shopId, id);
      if (!CANCELLABLE.includes(grn.status)) {
        throw new BadRequestException({ message: `A ${grn.status} goods receipt cannot be cancelled.`, code: 'GRN_NOT_CANCELLABLE', details: { status: grn.status } });
      }
      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'CANCELLED', actorId, comments ?? 'Receipt cancelled');
      await tx.goodsReceiptAudit.create({ data: { goodsReceiptId: id, shopId, actorId, action: 'CANCELLED', newPayload: { comments: comments ?? null } } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'GRNCancelled', aggregateId: id, aggregateType: 'GoodsReceipt', payload: { id }, actorId });
      return tx.goodsReceipt.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  private async assertNotCreator(tx: Prisma.TransactionClient, shopId: string, id: string, createdBy: string | null, actorId: string, verb: string): Promise<void> {
    const created = await tx.goodsReceiptAudit.findFirst({ where: { goodsReceiptId: id, shopId, actorId, action: 'CREATED' }, select: { id: true } });
    if (createdBy === actorId || created) throw new ForbiddenException({ message: `The person who created a goods receipt cannot ${verb} it.`, code: 'SEPARATION_OF_DUTIES' });
  }
}
