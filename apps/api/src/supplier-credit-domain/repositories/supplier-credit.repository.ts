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
import { Prisma } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';
import { AllocateSupplierCreditDto, CreateSupplierCreditDto } from '../dto/supplier-credit.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { financialYearLabel } from '../../common/time/business-day';

/**
 * Supplier credit notes (roadmap 4.2): numbered from the shop's sequence,
 * totalled from their lines, and moved through DRAFT → SUBMITTED →
 * PENDING_APPROVAL → APPROVED → ISSUED → ALLOCATED → CLOSED by the lifecycle
 * service; an allocation is only accepted from an issued note against a bill
 * of the same supplier.
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
    private readonly sequences: NumberSequenceService
  ) {}

  async createSupplierCredit(shopId: string, payload: CreateSupplierCreditDto, actorId: string, ipAddress?: string) {
    const { supplierId, purchaseReturnId, vendorBillId, lines, ...metadata } = payload;

    return procurementTransaction(this.prisma, async (tx) => {
      // Enterprise Validation Engine: validate references
      await this.validation.validateReferences(tx, shopId, payload);
      await assertOwned(tx, 'supplier', supplierId, shopId);
      await assertOwnedMany(tx, 'product', lines.map((l) => l.productId), shopId);

      const { number: creditNumber } = await this.sequences.next(tx, shopId, 'SUPPLIER_CREDIT_NOTE', `SCN-${financialYearLabel(new Date(), 'Asia/Kolkata')}-`);
      // The note is worth the sum of its lines; a client total is only a
      // cross-check, never the authority.
      const totalAmount = lines
        .reduce((sum, line) => sum.plus(line.totalAmount ?? 0), new Prisma.Decimal(0))
        .toDecimalPlaces(2);
      if (totalAmount.lte(0)) throw new BadRequestException({ message: 'A credit note must be worth more than zero.', code: 'SUPPLIER_CREDIT_EMPTY' });
      if (metadata.totalAmount !== undefined && !new Prisma.Decimal(metadata.totalAmount).toDecimalPlaces(2).eq(totalAmount)) {
        throw new BadRequestException({ message: `Total ${metadata.totalAmount} does not match the line total ${totalAmount.toString()}.`, code: 'SUPPLIER_CREDIT_TOTAL_MISMATCH' });
      }

      const scn = await tx.supplierCreditNote.create({
        data: {
          shopId,
          supplierId,
          purchaseReturnId,
          vendorBillId,
          creditNumber,
          status: 'DRAFT',
          creditSource: metadata.creditSource || 'PURCHASE_RETURN',
          totalAmount,
          remainingBalance: totalAmount,
          createdBy: actorId,
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
          newPayload: scn as any,
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

    const scn = await this.prisma.supplierCreditNote.findUnique({
      where: { id },
      include: { 
        lines: true, 
        attachments: true, 
        statusHistory: { orderBy: { createdAt: 'desc' } },
        allocations: true,
        approvals: true
      }
    });

    if (!scn || scn.shopId !== shopId || scn.isDeleted) {
      throw new NotFoundException(`Supplier Credit Note ${id} not found.`);
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

  private async loadNote(tx: Prisma.TransactionClient, shopId: string, id: string) {
    const scn = await tx.supplierCreditNote.findFirst({ where: { id, shopId, isDeleted: false } });
    if (!scn) throw new NotFoundException(`Supplier Credit Note ${id} not found.`);
    return scn;
  }

  async submitSupplierCredit(shopId: string, id: string, actorId: string, ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.loadNote(tx, shopId, id);

      // Submission opens the approval step: SUBMITTED is the hand-off,
      // PENDING_APPROVAL the state the note waits in (roadmap 4.2).
      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, 'SUBMITTED', actorId, 'Submitted for processing');
      await this.lifecycle.transitionStatus(tx, id, shopId, 'SUBMITTED', 'PENDING_APPROVAL', actorId, 'Awaiting approval');
      await this.approval.openApproval(tx, shopId, id);
      await tx.supplierCreditAudit.create({ data: { supplierCreditId: id, shopId, actorId, action: 'SUBMITTED', ipAddress } });

      const updatedScn = await tx.supplierCreditNote.findUnique({ where: { id } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'SupplierCreditSubmitted',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id, status: 'PENDING_APPROVAL', supplierId: scn.supplierId, totalAmount: scn.totalAmount.toString() },
        actorId,
      });

      await this.cacheManager.del(`scn:${shopId}:${id}`);
      return updatedScn;
    });
  }

  async approveSupplierCredit(shopId: string, id: string, actorId: string, ipAddress?: string, comments?: string, signature?: string, action: 'APPROVE' | 'REJECT' = 'APPROVE') {
    return procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.loadNote(tx, shopId, id);

      const approvalStatus = await this.approval.processApproval(tx, shopId, id, actorId, action, comments, signature);
      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, approvalStatus, actorId, approvalStatus === 'APPROVED' ? 'Credit Note approved' : 'Credit Note rejected');
      if (approvalStatus === 'APPROVED') {
        // An approved note is issued at once: it is now a balance the supplier owes.
        await this.lifecycle.transitionStatus(tx, id, shopId, 'APPROVED', 'ISSUED', actorId, 'Credit Note issued');
      }
      await tx.supplierCreditAudit.create({ data: { supplierCreditId: id, shopId, actorId, action: `APPROVAL_${action}`, ipAddress, newPayload: { comments } } });

      const updatedScn = await tx.supplierCreditNote.findUnique({ where: { id } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: approvalStatus === 'APPROVED' ? 'SupplierCreditApproved' : 'SupplierCreditRejected',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id, approvalStatus, status: updatedScn?.status },
        actorId,
      });

      await this.cacheManager.del(`scn:${shopId}:${id}`);
      return updatedScn;
    });
  }

  async allocateSupplierCredit(shopId: string, id: string, payload: AllocateSupplierCreditDto, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.loadNote(tx, shopId, id);

      // Only an issued note carries a balance that can be applied; the first
      // allocation moves it to ALLOCATED, later ones keep it there.
      if (scn.status !== 'ISSUED' && scn.status !== 'ALLOCATED') {
        throw new BadRequestException({ message: `Credit note ${scn.creditNumber} is ${scn.status}; only an issued note can be allocated.`, code: 'SUPPLIER_CREDIT_NOT_ALLOCATABLE' });
      }
      const bill = await tx.vendorBill.findFirst({ where: { id: payload.vendorBillId, shopId, isDeleted: false }, select: { supplierId: true, status: true } });
      if (!bill) throw new NotFoundException(`Vendor Bill ${payload.vendorBillId} not found.`);
      if (bill.supplierId !== scn.supplierId) throw new BadRequestException({ message: 'A credit note can only be applied to a bill of the same supplier.', code: 'SUPPLIER_CREDIT_SUPPLIER_MISMATCH' });
      if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID') throw new BadRequestException({ message: `Vendor bill is ${bill.status}; only a posted bill carries an outstanding balance.`, code: 'VENDOR_BILL_NOT_PAYABLE' });
      if (scn.status === 'ISSUED') {
        await this.lifecycle.transitionStatus(tx, id, shopId, 'ISSUED', 'ALLOCATED', actorId, 'Allocating Credit Note');
      }

      await this.allocation.processAllocation(tx, shopId, scn, payload.vendorBillId, payload.amount, actorId);
      
      const updatedScn = await tx.supplierCreditNote.findUnique({ where: { id } });
      
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

      await this.cacheManager.del(`scn:${shopId}:${id}`);
      return updatedScn;
    });
  }

  async closeSupplierCredit(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const scn = await this.loadNote(tx, shopId, id);

      // Handle Financial Virtual Preparation
      await this.finance.prepareFinancialAdjustments(tx, shopId, scn);

      await this.lifecycle.transitionStatus(tx, id, shopId, scn.status, 'CLOSED', actorId, 'Credit Note closed fully');

      const updatedScn = await tx.supplierCreditNote.findUnique({ where: { id } });
      
      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'SupplierCreditClosed',
        aggregateId: id,
        aggregateType: 'SupplierCreditNote',
        payload: { id },
        actorId,
      });

      await this.cacheManager.del(`scn:${shopId}:${id}`);
      return updatedScn;
    });
  }
}
