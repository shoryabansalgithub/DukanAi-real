import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PurchaseOrderStatus, Prisma } from '@prisma/client';

/**
 * Purchase-order state machine (roadmap 4.2, audit P2-2). A new order gets
 * its initial DRAFT timeline row without a transition (DRAFT -> DRAFT is not
 * one, and used to roll every creation back). Submission moves to SUBMITTED;
 * a single-step approval goes straight to APPROVED (UNDER_REVIEW stays
 * available for a multi-step flow). Receipts move an APPROVED order to
 * ORDERED, then PARTIALLY_RECEIVED / RECEIVED as goods are accepted. Every
 * transition is a compare-and-set on the row's current status, so two
 * concurrent actors cannot both move the same order.
 */
@Injectable()
export class PurchaseLifecycleService {
  private readonly logger = new Logger(PurchaseLifecycleService.name);

  static readonly TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'],
    UNDER_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
    ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
    PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
    RECEIVED: ['BILLED', 'CLOSED'],
    BILLED: ['CLOSED'],
    REJECTED: ['DRAFT', 'ARCHIVED'],
    CANCELLED: ['ARCHIVED'],
    CLOSED: ['ARCHIVED'],
    ARCHIVED: [],
  };

  /** Statuses in which goods may be received against the order. */
  static readonly RECEIVABLE: PurchaseOrderStatus[] = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'];

  validateTransition(currentStatus: PurchaseOrderStatus, targetStatus: PurchaseOrderStatus): void {
    const allowed = PurchaseLifecycleService.TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new BadRequestException({
        message: `Invalid Purchase Order lifecycle transition from ${currentStatus} to ${targetStatus}`,
        code: 'PURCHASE_ORDER_TRANSITION_INVALID',
        details: { from: currentStatus, to: targetStatus, allowed },
      });
    }
  }

  /** The first timeline row of a new order: its initial status, no transition. */
  async recordInitialStatus(tx: Prisma.TransactionClient, purchaseOrderId: string, shopId: string, status: PurchaseOrderStatus, actorId?: string, notes?: string): Promise<void> {
    await tx.purchaseOrderTimeline.create({ data: { purchaseOrderId, shopId, status, actorId, notes } });
  }

  /**
   * Transitions the status of a PO and records the timeline history immutably.
   * The update matches the row only in `currentStatus`: a concurrent
   * transition that won the race makes this one fail with 409.
   */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    purchaseOrderId: string,
    shopId: string,
    currentStatus: PurchaseOrderStatus,
    targetStatus: PurchaseOrderStatus,
    actorId?: string,
    notes?: string,
  ): Promise<void> {
    this.validateTransition(currentStatus, targetStatus);

    const moved = await tx.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, shopId, status: currentStatus },
      data: { status: targetStatus },
    });
    if (moved.count === 0) {
      throw new ConflictException({ message: 'The purchase order changed state concurrently; reload and retry.', code: 'PURCHASE_ORDER_STATE_CONFLICT' });
    }

    await tx.purchaseOrderTimeline.create({
      data: { purchaseOrderId, shopId, status: targetStatus, actorId, notes: notes ?? `${currentStatus} -> ${targetStatus}` },
    });

    this.logger.debug(`PurchaseOrder [${purchaseOrderId}] transitioned: ${currentStatus} -> ${targetStatus}`);
  }
}
