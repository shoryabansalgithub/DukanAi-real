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
import { LedgerAccount, LedgerEntryType, Prisma, VendorBillStatus } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';
import { CreateVendorBillDto, PayVendorBillDto } from '../dto/vendor-bill.dto';
import { assertOwned, assertOwnedMany } from '../../prisma/tenant-ownership';
import { SupplierPayablesService } from '../../ledger/supplier-payables.service';
import { LedgerEntryInput } from '../../ledger/ledger-posting.service';
import { procurementTransaction } from '../../common/db/procurement-transaction';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { Clock } from '../../common/time/clock';
import { lockDocument, shopFinancialYear } from '../../purchase-domain/procurement-support';

const ZERO = new Prisma.Decimal(0);
const CANCELLABLE: VendorBillStatus[] = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL'];

/** The entries a posted bill adds to the books and the net change of what the supplier is owed. */
export interface VendorBillPostingPlan {
  entries: LedgerEntryInput[];
  /** Net CREDIT to ACCOUNTS_PAYABLE (negative: the bill lowers the payable). */
  payableDelta: Prisma.Decimal;
}

/**
 * The posting of a vendor bill (release audit S3). The goods receipt already
 * put the stock in at its net cost (DR INVENTORY / CR ACCOUNTS_PAYABLE); the
 * bill adds what the receipt could not know:
 *   DR INPUT_GST                     the bill's tax (input tax credit)
 *   DR / CR INVENTORY                the bill's base minus the receipt value of the lines it bills
 *                                    (billed quantity × the receipt line's unit cost), stocked products
 *   DR EXPENSES                      the base of lines for products that carry no stock (SERVICE / DIGITAL)
 *   CR (or DR) ACCOUNTS_PAYABLE      the net of the above
 * so the payable after the bill is exactly the bill's total and a taxed bill
 * can be paid in full.
 */
export function vendorBillPostingPlan(lines: Array<{ base: Prisma.Decimal; tax: Prisma.Decimal; receiptValue: Prisma.Decimal; stocked: boolean }>): VendorBillPostingPlan {
  const tax = lines.reduce((sum, l) => sum.plus(l.tax), ZERO).toDecimalPlaces(2);
  const inventoryDiff = lines.filter((l) => l.stocked).reduce((sum, l) => sum.plus(l.base.minus(l.receiptValue)), ZERO).toDecimalPlaces(2);
  const expenses = lines.filter((l) => !l.stocked).reduce((sum, l) => sum.plus(l.base), ZERO).toDecimalPlaces(2);
  const payableDelta = tax.plus(inventoryDiff).plus(expenses);
  const entries: LedgerEntryInput[] = [];
  if (tax.greaterThan(0)) entries.push({ account: LedgerAccount.INPUT_GST, type: LedgerEntryType.DEBIT, amount: tax });
  if (inventoryDiff.greaterThan(0)) entries.push({ account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: inventoryDiff });
  if (inventoryDiff.lessThan(0)) entries.push({ account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: inventoryDiff.abs() });
  if (expenses.greaterThan(0)) entries.push({ account: LedgerAccount.EXPENSES, type: LedgerEntryType.DEBIT, amount: expenses });
  if (payableDelta.greaterThan(0)) entries.push({ account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.CREDIT, amount: payableDelta });
  if (payableDelta.lessThan(0)) entries.push({ account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.DEBIT, amount: payableDelta.abs() });
  return { entries, payableDelta };
}

/**
 * Vendor bills (roadmap 4.2): numbered from the shop's sequence, taxed per
 * line in Decimal, three-way matched, approved by someone other than their
 * creator, posted to the books and paid through the payables authority.
 * Every state change locks the bill row and moves its status with a
 * compare-and-set; cached copies are dropped after the commit.
 */
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
    private readonly sequences: NumberSequenceService,
    private readonly clock: Clock,
  ) {}

  async createVendorBill(shopId: string, payload: CreateVendorBillDto, actorId: string, ipAddress?: string) {
    const { supplierId, purchaseOrderId, goodsReceiptId, lines, taxMode, ...metadata } = payload;

    return procurementTransaction(this.prisma, async (tx) => {
      // A deleted supplier takes no new documents (release audit S21).
      await assertOwned(tx, 'supplier', supplierId, shopId, { isDeleted: false });
      await assertOwned(tx, 'purchaseOrder', purchaseOrderId, shopId);
      await assertOwned(tx, 'goodsReceipt', goodsReceiptId, shopId);
      await assertOwnedMany(tx, 'product', lines.map((l) => l.productId), shopId);
      await assertOwnedMany(tx, 'productVariant', lines.map((l) => l.variantId), shopId);
      await assertOwnedMany(tx, 'purchaseOrderItem', lines.map((l) => l.purchaseOrderLineId), shopId);
      await assertOwnedMany(tx, 'goodsReceiptLine', lines.map((l) => l.grnLineId), shopId);
      if (purchaseOrderId || goodsReceiptId) {
        const [po, grn] = await Promise.all([
          purchaseOrderId ? tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, shopId }, select: { supplierId: true } }) : null,
          goodsReceiptId ? tx.goodsReceipt.findFirst({ where: { id: goodsReceiptId, shopId }, select: { supplierId: true, purchaseOrderId: true } }) : null,
        ]);
        if ((po && po.supplierId !== supplierId) || (grn && grn.supplierId !== supplierId)) {
          throw new BadRequestException({ message: 'The bill names a purchase order or goods receipt of another supplier.', code: 'VENDOR_BILL_SUPPLIER_MISMATCH' });
        }
        if (po && grn && grn.purchaseOrderId !== purchaseOrderId) {
          throw new BadRequestException({ message: 'The goods receipt was not received against the named purchase order.', code: 'VENDOR_BILL_LINE_MISMATCH' });
        }
      }

      // 1. Tax per line, in Decimal; the bill is worth the sum of its lines.
      const taxed = this.tax.prepareTaxLiability(lines, taxMode || 'EXCLUSIVE');
      // 2. The references must hold together now; quantities are checked cumulatively on submit.
      await this.matching.enforceThreeWayMatch(
        tx,
        shopId,
        { supplierId, purchaseOrderId, goodsReceiptId },
        taxed.lines.map(({ line, baseAmount }) => ({ ...line, baseAmount })),
        { final: false },
      );

      const now = this.clock.now();
      const financialYear = await shopFinancialYear(tx, shopId, now);
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
          totalAmount: taxed.totalAmount,
          taxAmount: taxed.totalTax,
          outstandingAmount: taxed.totalAmount, // Initial outstanding is total
          createdBy: actorId,
          createdAt: now,
          lines: {
            create: taxed.lines.map(({ line, taxAmount, totalAmount }) => ({
              shopId,
              productId: line.productId,
              variantId: line.variantId,
              purchaseOrderLineId: line.purchaseOrderLineId,
              grnLineId: line.grnLineId,
              billedQuantity: line.billedQuantity,
              unitPrice: line.unitPrice,
              taxPercentage: line.taxPercentage ?? 0,
              taxAmount,
              totalAmount,
              remarks: line.remarks,
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
          newPayload: bill as never,
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

    const bill = await this.prisma.vendorBill.findFirst({
      where: { id, shopId, isDeleted: false },
      include: {
        lines: true,
        attachments: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
        paymentSchedules: true,
        approvals: true
      }
    });

    if (!bill) {
      throw new NotFoundException({ message: `Vendor Bill ${id} not found.`, code: 'VENDOR_BILL_NOT_FOUND' });
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

  /** The bill row under lock (`FOR UPDATE`) with its lines: every state change reads the state it changes here. */
  private async lockBill(tx: Prisma.TransactionClient, shopId: string, id: string) {
    await lockDocument(tx, 'VendorBill', id, shopId, 'VENDOR_BILL_NOT_FOUND');
    return tx.vendorBill.findFirstOrThrow({ where: { id, shopId }, include: { lines: { where: { isDeleted: false } } } });
  }

  private async invalidate(shopId: string, id: string): Promise<void> {
    await this.cacheManager.del(`vb:${shopId}:${id}`);
  }

  /** DRAFT -> SUBMITTED -> PENDING_APPROVAL with one open approval step, after the three-way match. */
  async submitVendorBill(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const bill = await this.lockBill(tx, shopId, id);
      this.lifecycle.validateTransition(bill.status, 'SUBMITTED');

      // Every line matched, prices within tolerance, quantities cumulative over the other live bills.
      await this.matching.enforceThreeWayMatch(
        tx,
        shopId,
        bill,
        bill.lines.map((line) => ({ ...line, baseAmount: line.totalAmount.minus(line.taxAmount) })),
        { final: true, excludeBillId: bill.id },
      );

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
      return updatedBill;
    });
    await this.invalidate(shopId, id);
    return result;
  }

  async approveVendorBill(shopId: string, id: string, actorId: string, _ipAddress?: string, comments?: string, signature?: string) {
    return this.decide(shopId, id, actorId, 'APPROVE', comments, signature);
  }

  /** PENDING_APPROVAL -> REJECTED, by a manager other than the creator or submitter (release audit S24). */
  async rejectVendorBill(shopId: string, id: string, actorId: string, comments?: string) {
    return this.decide(shopId, id, actorId, 'REJECT', comments);
  }

  private async decide(shopId: string, id: string, actorId: string, action: 'APPROVE' | 'REJECT', comments?: string, signature?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const bill = await this.lockBill(tx, shopId, id);
      if (bill.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException({ message: `A ${bill.status} vendor bill is not waiting for a decision.`, code: 'VENDOR_BILL_NOT_PENDING', details: { status: bill.status } });
      }
      const status = await this.approval.processApproval(tx, shopId, id, actorId, action, comments, signature);
      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, status, actorId, comments ?? (status === 'APPROVED' ? 'Approved' : 'Rejected'));

      await this.eventPublisher.publish(tx, shopId, {
        eventType: status === 'APPROVED' ? 'VendorBillApproved' : 'VendorBillRejected',
        aggregateId: id,
        aggregateType: 'VendorBill',
        payload: { id, approvalStatus: status },
        actorId,
      });
      return tx.vendorBill.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /** Withdraws a bill before it is decided: DRAFT / SUBMITTED / PENDING_APPROVAL -> CANCELLED; the open approval step closes with it. */
  async cancelVendorBill(shopId: string, id: string, actorId: string, comments?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const bill = await this.lockBill(tx, shopId, id);
      if (!CANCELLABLE.includes(bill.status)) {
        throw new BadRequestException({ message: `A ${bill.status} vendor bill cannot be cancelled.`, code: 'VENDOR_BILL_NOT_CANCELLABLE', details: { status: bill.status } });
      }
      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, 'CANCELLED', actorId, comments ?? 'Cancelled');
      await tx.vendorBillApproval.updateMany({ where: { vendorBillId: id, shopId, status: 'PENDING' }, data: { status: 'CANCELLED', approverId: actorId, comments } });
      await tx.vendorBillAudit.create({ data: { vendorBillId: id, shopId, actorId, action: 'CANCELLED', newPayload: { comments: comments ?? null } } });
      await this.eventPublisher.publish(tx, shopId, { eventType: 'VendorBillCancelled', aggregateId: id, aggregateType: 'VendorBill', payload: { id }, actorId });
      return tx.vendorBill.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * APPROVED -> POSTED: the bill's input GST and price difference go to the
   * books (`vendorBillPostingPlan`, source VENDOR_BILL) and the supplier's
   * payable moves by the same amount, supplier row locked before the ledger.
   */
  async postVendorBill(shopId: string, id: string, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const bill = await this.lockBill(tx, shopId, id);
      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, 'POSTED', actorId, 'Posted to the ledger');

      const grnLineIds = bill.lines.map((l) => l.grnLineId).filter((x): x is string => !!x);
      const [grnLines, products] = await Promise.all([
        tx.goodsReceiptLine.findMany({ where: { id: { in: grnLineIds }, shopId }, select: { id: true, unitPrice: true } }),
        tx.product.findMany({ where: { id: { in: bill.lines.map((l) => l.productId) }, shopId }, select: { id: true, type: true } }),
      ]);
      const unitCostByGrnLine = new Map(grnLines.map((l) => [l.id, l.unitPrice]));
      const typeByProduct = new Map(products.map((p) => [p.id, p.type]));
      const plan = vendorBillPostingPlan(
        bill.lines.map((line) => {
          const stocked = !['SERVICE', 'DIGITAL'].includes(typeByProduct.get(line.productId) ?? 'SIMPLE');
          const unitCost = line.grnLineId ? unitCostByGrnLine.get(line.grnLineId) : undefined;
          return {
            base: line.totalAmount.minus(line.taxAmount),
            tax: line.taxAmount,
            receiptValue: stocked && unitCost ? line.billedQuantity.times(unitCost).toDecimalPlaces(2) : ZERO,
            stocked,
          };
        }),
      );
      if (plan.entries.length > 0) {
        await this.payables.postWithPayable(
          tx,
          bill.supplierId,
          { shopId, source: { type: 'VENDOR_BILL', id }, invoiceId: null, description: `Vendor bill ${bill.billNumber}`, entries: plan.entries },
          plan.payableDelta,
        );
      }
      await tx.vendorBill.update({ where: { id }, data: { postingDate: this.clock.now() } });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'VendorBillPosted',
        aggregateId: id,
        aggregateType: 'VendorBill',
        payload: { id, totalAmount: bill.totalAmount.toFixed(2), taxAmount: bill.taxAmount.toFixed(2), payableDelta: plan.payableDelta.toFixed(2) },
        actorId,
      });
      return tx.vendorBill.findFirst({ where: { id, shopId } });
    });
    await this.invalidate(shopId, id);
    return result;
  }

  /**
   * Pays a POSTED or PARTIALLY_PAID bill, in instalments if needed. The bill
   * row is locked before the balance is read (release audit S5: two
   * concurrent payments read the same outstanding and both paid it), the
   * outstanding amount is the bill's live figure (credit-note allocations
   * already reduced it), and the status moves by compare-and-set. Lock
   * order: the bill, then (in the payables authority) the drawer, the
   * supplier and the ledger balances.
   */
  async payVendorBill(shopId: string, id: string, payload: PayVendorBillDto, actorId: string, _ipAddress?: string) {
    const result = await procurementTransaction(this.prisma, async (tx) => {
      const bill = await this.lockBill(tx, shopId, id);

      // Replay of an idempotent payment: the bill already carries it.
      if (payload.idempotencyKey) {
        const existing = await tx.supplierPayment.findFirst({ where: { shopId, idempotencyKey: payload.idempotencyKey }, select: { id: true, vendorBillId: true } });
        if (existing) {
          if (existing.vendorBillId !== id) {
            throw new BadRequestException({ message: 'This idempotency key was already used for a different payment.', code: 'IDEMPOTENCY_KEY_REUSED', details: { paymentId: existing.id } });
          }
          return tx.vendorBill.findFirst({ where: { id, shopId } });
        }
      }
      if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID') {
        throw new BadRequestException({ message: `A ${bill.status} vendor bill cannot be paid.`, code: 'VENDOR_BILL_NOT_PAYABLE', details: { status: bill.status } });
      }

      // Outstanding is what is left after earlier payments AND credit-note allocations.
      const paymentAmount = new Prisma.Decimal(payload.paymentAmount).toDecimalPlaces(2);
      const { paidAmount, outstandingAmount, isFullyPaid } = this.outstanding.processPayment(bill.outstandingAmount, bill.paidAmount, paymentAmount);

      await tx.vendorBill.update({ where: { id }, data: { paidAmount, outstandingAmount } });

      const nextStatus = isFullyPaid ? 'PAID' : 'PARTIALLY_PAID';
      await this.lifecycle.transitionStatus(tx, id, shopId, bill.status, nextStatus, actorId, `Paid ${paymentAmount.toFixed(2)}`);

      // The money leaves through the payables authority (roadmap 3.11): a
      // SupplierPayment row, the drawer for cash, the supplier's balance and DR AP / CR CASH|BANK.
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
        payload: { id, paidAmount: paidAmount.toFixed(2), outstandingAmount: outstandingAmount.toFixed(2) },
        actorId,
      });
      return updatedBill;
    });
    await this.invalidate(shopId, id);
    return result;
  }
}
