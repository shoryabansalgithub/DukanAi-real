import { Injectable, NotFoundException, Inject, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { SupplierCreditLifecycleService } from '../services/supplier-credit-lifecycle.service';
import { SupplierCreditAllocationService } from '../services/supplier-credit-allocation.service';
import { SupplierCreditFinancialService } from '../services/supplier-credit-financial.service';
import { SupplierCreditValidationService } from '../services/supplier-credit-validation.service';
import { SupplierCreditApprovalService } from '../services/supplier-credit-approval.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma, SupplierCreditStatus } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';
import { AllocateSupplierCreditDto, CreateSupplierCreditDto } from '../dto/supplier-credit.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { Clock } from '../../common/time/clock';
import { lockDocument, shopFinancialYear } from '../../purchase-domain/procurement-support';

const CANCELLABLE: SupplierCreditStatus[] = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL'];

/**
 * Supplier credit notes (roadmap 4.2): numbered from the shop's sequence
 * (financial year in the shop's time zone), totalled from their lines, and
 * moved through DRAFT → SUBMITTED → PENDING_APPROVAL → APPROVED → ISSUED →
 * ALLOCATED → CLOSED by the lifecycle service. Issuing posts the note
 * (`SupplierCreditFinancialService`); an allocation is only accepted from an
 * issued note against a posted bill of the same supplier. Every state change
 * locks the note row and moves its status with a compare-and-set; cached
 * copies are dropped after the commit.
 */
@Injectable()
export class SupplierCreditRepository {
  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: SupplierCreditLifecycleService,
    private readonly allocation: SupplierCreditAllocationService,
    private readonly finance: SupplierCreditFinancialService,
    private readonly validation: SupplierCreditValidationService,
    private readonly approval: SupplierCreditApprovalService,
    private readonly eventPublisher: SalesEventPublisher,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig,
    private readonly sequences: NumberSequenceService,
    private readonly clock: Clock,
  ) {}

  async createSupplierCredit(shopId: string, payload: CreateSupplierCreditDto, actorId: string, ipAddress?: string) {
    const { supplierId, purchaseReturnId, vendorBillId, lines, ...metadata } = payload;

    return procurementTransaction(this.prisma, async (tx) => {
      // A deleted supplier takes no new documents (release audit S21).
      await assertOwned(tx, 'supplier', supplierId, shopId, { isDeleted: false });
      await assertOwnedMany(tx, 'product', lines.map((l) => l.productId), shopId);

      // The note is worth the sum of its lines; a client total is only a
      // cross-check, never the authority. The GST inside a line cannot exceed it.
      const totalAmount = lines
        .reduce((sum, line) => sum.plus(line.totalAmount ?? 0), new Prisma.Decimal(0))
        .toDecimalPlaces(2);
      if (totalAmount.lte(0)) throw new BadRequestException({ message: 'A credit note must be worth more than zero.', code: 'SUPPLIER_CREDIT_EMPTY' });
      if (metadata.totalAmount !== undefined && !new Prisma.Decimal(metadata.totalAmount).toDecimalPlaces(2).eq(totalAmount)) {
        throw new BadRequestException({ message: `Total ${metadata.totalAmount} does not match the line total ${totalAmount.toString()}.`, code: 'SUPPLIER_CREDIT_TOTAL_MISMATCH' });
      }
      if (lines.some((line) => (line.taxAmount ?? 0) > line.totalAmount)) {
        throw new BadRequestException({ message: 'A line\'s tax cannot exceed its total.', code: 'SUPPLIER_CREDIT_TAX_INVALID' });
      }
      const taxAmount = lines.reduce((sum, line) => sum.plus(line.taxAmount ?? 0), new Prisma.Decimal(0)).toDecimalPlaces(2);

      // References: the supplier's own bill / COMPLETED return, notes of one return capped at its value.
      await this.validation.validateReferences(tx, shopId, { supplierId, purchaseReturnId, vendorBillId }, totalAmount);

      const now = this.clock.now();
      const { number: creditNumber } = await this.sequences.next(tx, shopId, 'SUPPLIER_CREDIT_NOTE', `SCN-${await shopFinancialYear(tx, shopId, now)}-`);

      const scn = await tx.supplierCreditNote.create({
        data: {
          shopId,
          supplierId,
          purchaseReturnId,
          vendorBillId,
          creditNumber,
          status: 'DRAFT',
          creditSource: metadata.creditSource || (purchaseReturnId ? 'PURCHASE_RETURN' : 'PRICE_DIFFERENCE'),
          totalAmount,
          taxAmount,
          remainingBalance: totalAmount,
          createdBy: actorId,
          createdAt: now,
          lines: {
            create: lines.map((line) => ({
              shopId,
              productId: line.productId,
              description: line.description,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              taxPercentage: line.taxPercentage,
              taxAmount: line.taxAmount,
              totalAmount: line.totalAmount,
              remarks: line.remarks
            }))
          }
        },
        include: { lines: true }
      });

      await tx.supplierCreditAudit.create({
        data: {
          supplierCreditId: scn.id,
          shopId,
          actorId,
          action: 'CREATED',
          newPayload: scn as never,
          ipAddress
        }
      });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'SupplierCreditCreated',
        aggregateId: scn.id,
        aggregateType: 'SupplierCreditNote',
        payload: { id: scn.id, creditNumber, supplierId, totalAmount: totalAmount.toString() },
        actorId,
      });

      return scn;
    });
  }

  async getSupplierCredit(shopId: string, id: string) {
    const cacheKey = `scn:${shopId}:${id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const scn = await this.prisma.supplierCreditNote.findFirst({
      where: { id, shopId, isDeleted: false },
      include: {
        lines: true,
        attachments: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
        allocations: true,
        approvals: true
      }
    });

    if (!scn) {
      throw new NotFoundException({ message: `Supplier Credit Note ${id} not found.`, code: 'SUPPLIER_CREDIT_NOT_FOUND' });
    }

    await this.cacheManager.set(cacheKey, scn, this.cacheConfig.supplierCreditTtlMs);
    return scn;
  }

  async listSupplierCredits(shopId: string, limit: number = 50, offset: number = 0) {
    return this.prisma.supplierCreditNote.findMany({
      where: { shopId, isDeleted: false },
      include: { supplier: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset
    });
  }

  /** The note row under lock (`FOR UPDATE`): every state change reads the state it changes here. */
  private async lockNote(tx: Prisma.TransactionClient, shopId: string, id: string) {
    await lockDocument(tx, 'SupplierCreditNote', id, shopId, 'SUPPLIER_CREDIT_NOT_FOUND');
    return tx.supplierCreditNote.findFirstOrThrow({ where: { id, shopId } });
  }

  private async invalidate(shopId: string, id: string, vendorBillId?: string): Promise<void> {
    await this.cacheManager.del(`scn:${shopId}:${id}`);
    if (vendorBillId) await this.cacheManager.del(`vb:${shopId}:${vendorBillId}`);
  }

  async submitSupplierCredit(shopId: string, id: string, actorId: string, ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.lockNote(tx, shopId, id);

      // Submission opens the approval step: SUBMITTED is the hand-off,
      // PENDING_APPROVAL the state the note waits in (roadmap 4.2).
      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, 'SUBMITTED', actorId, 'Submitted for processing');
      await this.lifecycle.transitionStatus(tx, id, shopId, 'SUBMITTED', 'PENDING_APPROVAL', actorId, 'Awaiting approval');
      await this.approval.openApproval(tx, shopId, id);
      await tx.supplierCreditAudit.create({ data: { supplierCreditId: id, shopId, actorId, action: 'SUBMITTED', ipAddress } });

      const updatedScn = await tx.supplierCreditNote.findFirst({ where: { id, shopId } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'SupplierCreditSubmitted',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id, status: 'PENDING_APPROVAL', supplierId: scn.supplierId, totalAmount: scn.totalAmount.toString() },
        actorId,
      });
      return updatedScn;
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * A manager other than the creator or submitter decides the note. An
   * approval issues it at once and posts it (the payable goes down); the
   * return-backed cap is checked again under the return's lock.
   */
  async approveSupplierCredit(shopId: string, id: string, actorId: string, ipAddress?: string, comments?: string, signature?: string, action: 'APPROVE' | 'REJECT' = 'APPROVE') {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.lockNote(tx, shopId, id);
      if (scn.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException({ message: `A ${scn.status} credit note is not waiting for a decision.`, code: 'SUPPLIER_CREDIT_NOT_PENDING', details: { status: scn.status } });
      }

      const approvalStatus = await this.approval.processApproval(tx, shopId, id, actorId, action, comments, signature);
      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, approvalStatus, actorId, approvalStatus === 'APPROVED' ? 'Credit Note approved' : 'Credit Note rejected');
      if (approvalStatus === 'APPROVED') {
        await this.validation.validateReferences(tx, shopId, scn, scn.totalAmount, scn.id);
        // An approved note is issued at once: it is now a balance the supplier owes.
        await this.lifecycle.transitionStatus(tx, id, shopId, 'APPROVED', 'ISSUED', actorId, 'Credit Note issued');
        await tx.supplierCreditNote.update({ where: { id }, data: { issueDate: this.clock.now() } });
        await this.finance.postIssuedNote(tx, shopId, scn);
      }
      await tx.supplierCreditAudit.create({ data: { supplierCreditId: id, shopId, actorId, action: `APPROVAL_${action}`, ipAddress, newPayload: { comments: comments ?? null } } });

      const updatedScn = await tx.supplierCreditNote.findFirst({ where: { id, shopId } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: approvalStatus === 'APPROVED' ? 'SupplierCreditApproved' : 'SupplierCreditRejected',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id, approvalStatus, status: updatedScn?.status },
        actorId,
      });
      return updatedScn;
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /** Withdraws a note before it is decided: DRAFT / SUBMITTED / PENDING_APPROVAL -> CANCELLED; the open approval step closes with it. */
  async cancelSupplierCredit(shopId: string, id: string, actorId: string, comments?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.lockNote(tx, shopId, id);
      if (!CANCELLABLE.includes(scn.status)) {
        throw new BadRequestException({ message: `A ${scn.status} credit note cannot be cancelled.`, code: 'SUPPLIER_CREDIT_NOT_CANCELLABLE', details: { status: scn.status } });
      }
      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, 'CANCELLED', actorId, comments ?? 'Cancelled');
      await tx.supplierCreditApproval.updateMany({ where: { supplierCreditId: id, shopId, status: 'PENDING' }, data: { status: 'CANCELLED', approverId: actorId, comments } });
      await tx.supplierCreditAudit.create({ data: { supplierCreditId: id, shopId, actorId, action: 'CANCELLED', newPayload: { comments: comments ?? null } } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'SupplierCreditCancelled', aggregateId: id, aggregateType: 'SupplierCreditNote', payload: { id }, actorId });
      return tx.supplierCreditNote.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  async allocateSupplierCredit(shopId: string, id: string, payload: AllocateSupplierCreditDto, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      // Lock order: the bill, then the note (inside processAllocation).
      const { noteStatus } = await this.allocation.processAllocation(tx, shopId, id, payload.vendorBillId, new Prisma.Decimal(payload.amount), actorId);
      // The first allocation moves an issued note to ALLOCATED, later ones keep it there.
      if (noteStatus === 'ISSUED') await this.lifecycle.transitionStatus(tx, id, shopId, 'ISSUED', 'ALLOCATED', actorId, 'Allocating Credit Note');

      const updatedScn = await tx.supplierCreditNote.findFirst({ where: { id, shopId } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'SupplierCreditAllocated',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id, allocatedAmount: payload.amount, vendorBillId: payload.vendorBillId },
        actorId,
      });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'OutstandingReduced',
        aggregateId: payload.vendorBillId,
        aggregateType: 'VendorBill',
        payload: { reducedAmount: payload.amount, source: 'SUPPLIER_CREDIT_NOTE' },
        actorId,
      });
      return updatedScn;
    });
    await this.invalidate(shopId, id, payload.vendorBillId);
    return result;
  }

  async closeSupplierCredit(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.lockNote(tx, shopId, id);

      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, 'CLOSED', actorId, 'Credit Note closed fully');

      const updatedScn = await tx.supplierCreditNote.findFirst({ where: { id, shopId } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'SupplierCreditClosed',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id },
        actorId,
      });
      return updatedScn;
    });
    await this.invalidate(shopId, id);
    return result;
  }
}
