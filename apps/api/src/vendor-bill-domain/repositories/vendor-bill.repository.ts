import { Injectable, NotFoundException, Inject, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { VendorBillLifecycleService } from '../services/vendor-bill-lifecycle.service';
import { VendorBillApprovalService } from '../services/vendor-bill-approval.service';
import { VendorBillMatchingService } from '../services/vendor-bill-matching.service';
import { VendorBillTaxService } from '../services/vendor-bill-tax.service';
import { VendorBillOutstandingService } from '../services/vendor-bill-outstanding.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { CacheConfig } from '../../config/domains/cache.config';
import { CreateVendorBillDto, PayVendorBillDto } from '../dto/vendor-bill.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { SupplierPayablesService } from '../../ledger/supplier-payables.service';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { financialYearLabel } from '../../common/time/business-day';

@Injectable()
export class VendorBillRepository {
  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: VendorBillLifecycleService,
    private readonly approval: VendorBillApprovalService,
    private readonly matching: VendorBillMatchingService,
    private readonly tax: VendorBillTaxService,
    private readonly outstanding: VendorBillOutstandingService,
    private readonly eventPublisher: SalesEventPublisher,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig,
    private readonly payables: SupplierPayablesService,
    private readonly sequences: NumberSequenceService
  ) {}

  async createVendorBill(shopId: string, payload: CreateVendorBillDto, actorId: string, ipAddress?: string) {
    const { supplierId, purchaseOrderId, goodsReceiptId, lines, taxMode, ...metadata } = payload;
    
    return procurementTransaction(this.prisma, async (tx) => {
      await assertOwned(tx, 'supplier', supplierId, shopId);
      await assertOwned(tx, 'purchaseOrder', purchaseOrderId, shopId);
      await assertOwned(tx, 'goodsReceipt', goodsReceiptId, shopId);
      await assertOwnedMany(tx, 'product', lines.map((l) => l.productId), shopId);
      await assertOwnedMany(tx, 'productVariant', lines.map((l) => l.variantId), shopId);
      await assertOwnedMany(tx, 'purchaseOrderItem', lines.map((l) => l.purchaseOrderLineId), shopId);
      await assertOwnedMany(tx, 'goodsReceiptLine', lines.map((l) => l.grnLineId), shopId);

      // 1. Tax Preparation
      const { totalBase, totalTax, updatedLines } = this.tax.prepareTaxLiability(lines, taxMode || 'EXCLUSIVE');
      const financialYear = financialYearLabel(new Date(), 'Asia/Kolkata');
      const { number: billNumber } = await this.sequences.next(tx, shopId, 'VENDOR_BILL', `VB-${financialYear}-`);

      const bill = await tx.vendorBill.create({
        data: {
          shopId,
          supplierId,
          purchaseOrderId,
          goodsReceiptId,
          billNumber,
          invoiceNumber: metadata.invoiceNumber,
          invoiceDate: metadata.invoiceDate ? new Date(metadata.invoiceDate) : null,
          dueDate: metadata.dueDate ? new Date(metadata.dueDate) : null,
          status: 'DRAFT',
          currency: metadata.currency || 'INR',
          totalAmount: totalBase + totalTax,
          taxAmount: totalTax,
          outstandingAmount: totalBase + totalTax, // Initial outstanding is total
          createdBy: actorId,
          lines: {
            create: updatedLines.map((line: any) => ({
              shopId,
              productId: line.productId,
              variantId: line.variantId,
              purchaseOrderLineId: line.purchaseOrderLineId,
              grnLineId: line.grnLineId,
              billedQuantity: line.billedQuantity,
              unitPrice: line.unitPrice,
              taxPercentage: line.taxPercentage,
              taxAmount: line.taxAmount,
              totalAmount: line.totalAmount,
            }))
          }
        },
        include: { lines: true }
      });

      await tx.vendorBillAudit.create({
        data: {
          vendorBillId: bill.id,
          shopId,
          actorId,
          action: 'CREATED',
          newPayload: bill as any,
          ipAddress
        }
      });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'VendorBillCreated',
        aggregateId: bill.id,
        aggregateType: 'VendorBill',
        payload: { id: bill.id, billNumber },
        actorId,
      });

      return bill;
    });
  }

  async getVendorBill(shopId: string, id: string) {
    const cacheKey = `vb:${shopId}:${id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const bill = await this.prisma.vendorBill.findUnique({
      where: { id },
      include: { 
        lines: true, 
        attachments: true, 
        statusHistory: { orderBy: { createdAt: 'desc' } },
        paymentSchedules: true,
        approvals: true
      }
    });

    if (!bill || bill.shopId !== shopId || bill.isDeleted) {
      throw new NotFoundException(`Vendor Bill ${id} not found.`);
    }

    await this.cacheManager.set(cacheKey, bill, this.cacheConfig.vendorBillTtlMs); 
    return bill;
  }

  async listVendorBills(shopId: string, limit: number = 50, offset: number = 0) {
    return this.prisma.vendorBill.findMany({
      where: { shopId, isDeleted: false },
      include: { supplier: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset
    });
  }

  /** DRAFT -> SUBMITTED -> PENDING_APPROVAL with one open approval step, after the three-way match. */
  async submitVendorBill(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const bill = await tx.vendorBill.findFirst({ where: { id, shopId, isDeleted: false }, include: { lines: true } });
      if (!bill) throw new NotFoundException({ message: 'Vendor bill not found', code: 'VENDOR_BILL_NOT_FOUND' });

      // Enforce 3-Way Matching on Submit (cumulative over the other bills of the same lines)
      await this.matching.enforceThreeWayMatch(tx, shopId, bill.lines, 5, bill.id); // 5% tolerance

      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, 'SUBMITTED', actorId, 'Submitted for approval');
      await this.lifecycle.transitionStatus(tx, id, shopId, 'SUBMITTED', 'PENDING_APPROVAL', actorId, 'Awaiting approval');
      await this.approval.openApproval(tx, shopId, id);
      await tx.vendorBillAudit.create({ data: { vendorBillId: id, shopId, actorId, action: 'SUBMITTED', newPayload: { status: 'PENDING_APPROVAL' } } });

      const updatedBill = await tx.vendorBill.findFirst({ where: { id, shopId } });
      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'VendorBillSubmitted',
        aggregateId: id,
        aggregateType: 'VendorBill',
        payload: { id, totalAmount: bill.totalAmount.toFixed(2), supplierId: bill.supplierId },
        actorId,
      });

      await this.cacheManager.del(`vb:${shopId}:${id}`);
      return updatedBill;
    });
  }

  async approveVendorBill(shopId: string, id: string, actorId: string, _ipAddress?: string, comments?: string, signature?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const bill = await tx.vendorBill.findFirst({ where: { id, shopId, isDeleted: false } });
      if (!bill) throw new NotFoundException({ message: 'Vendor bill not found', code: 'VENDOR_BILL_NOT_FOUND' });
      const status = await this.approval.processApproval(tx, shopId, id, actorId, 'APPROVE', comments, signature);
      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, status, actorId, comments ?? 'Approved');

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'VendorBillApproved',
        aggregateId: id,
        aggregateType: 'VendorBill',
        payload: { id, approvalStatus: status },
        actorId,
      });

      await this.cacheManager.del(`vb:${shopId}:${id}`);
      return tx.vendorBill.findFirst({ where: { id, shopId } });
    });
  }

  async postVendorBill(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const bill = await tx.vendorBill.findFirst({ where: { id, shopId, isDeleted: false } });
      if (!bill) throw new NotFoundException({ message: 'Vendor bill not found', code: 'VENDOR_BILL_NOT_FOUND' });

      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, 'POSTED', actorId, 'Posted to AP Ledger (Virtual)');

      // Here is where future Accounting/Ledger Engines map Expense & Input GST
      // Currently decoupled per rules.

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'VendorBillPosted',
        aggregateId: id,
        aggregateType: 'VendorBill',
        payload: { id },
        actorId,
      });

      await this.cacheManager.del(`vb:${shopId}:${id}`);
      return await tx.vendorBill.findFirst({ where: { id, shopId } });
    });
  }

  /**
   * Pays a POSTED or PARTIALLY_PAID bill, in instalments if needed. The
   * outstanding amount is the bill's live figure (credit-note allocations
   * already reduced it), not total minus paid.
   */
  async payVendorBill(shopId: string, id: string, payload: PayVendorBillDto, actorId: string, _ipAddress?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const bill = await tx.vendorBill.findFirst({ where: { id, shopId, isDeleted: false } });
      if (!bill) throw new NotFoundException({ message: 'Vendor bill not found', code: 'VENDOR_BILL_NOT_FOUND' });
      if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID') {
        throw new BadRequestException({ message: `A ${bill.status} vendor bill cannot be paid.`, code: 'VENDOR_BILL_NOT_PAYABLE', details: { status: bill.status } });
      }

      const { paymentAmount } = payload;

      // Replay of an idempotent payment: the bill already carries it.
      if (payload.idempotencyKey) {
        const existing = await tx.supplierPayment.findFirst({ where: { shopId, idempotencyKey: payload.idempotencyKey }, select: { id: true } });
        if (existing) return bill;
      }

      // Outstanding is what is left after earlier payments AND credit-note allocations.
      const { paidAmount, outstandingAmount, isFullyPaid } = this.outstanding.processPayment(
        bill.paidAmount.plus(bill.outstandingAmount).toString(),
        bill.paidAmount.toString(),
        paymentAmount.toString()
      );

      await tx.vendorBill.update({
        where: { id },
        data: { paidAmount, outstandingAmount }
      });

      const nextStatus = isFullyPaid ? 'PAID' : 'PARTIALLY_PAID';
      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, nextStatus, actorId, `Paid ${paymentAmount}`);

      // The money leaves through the payables authority (roadmap 3.11): a
      // SupplierPayment row, the supplier's balance and DR AP / CR CASH|BANK.
      await this.payables.pay(tx, {
        shopId,
        supplierId: bill.supplierId,
        vendorBillId: id,
        amount: paymentAmount,
        tender: payload.tender,
        reference: payload.reference,
        idempotencyKey: payload.idempotencyKey,
        recordedById: actorId,
      });

      const updatedBill = await tx.vendorBill.findFirst({ where: { id, shopId } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'VendorBillPaid',
        aggregateId: id,
        aggregateType: 'VendorBill',
        payload: { id, paidAmount, outstandingAmount },
        actorId,
      });

      await this.cacheManager.del(`vb:${shopId}:${id}`);
      return updatedBill;
    });
  }
}
