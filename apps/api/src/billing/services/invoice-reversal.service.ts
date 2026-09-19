import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InvoiceItem, LedgerAccount, LedgerEntryType, Prisma, TenderType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingService } from '../billing.service';
import { BillingHelpers } from '../billing.helpers';
import { CancelInvoiceDto, ReturnInvoiceDto } from '../dto/return-invoice.dto';
import { InvoiceMathEngine, Decimal, deriveInvoicePaymentMode, InvoiceMathError, ReturnCalculationResult } from '../utils/invoice-math.engine';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { InvoiceNumberService } from './invoice-number.service';
import { LedgerPostingService, LedgerEntryInput } from '../../ledger/ledger-posting.service';
import { BillingActor, INVOICE_INCLUDE, InvoiceWithRelations, StockOutcome, money, qty } from '../billing.types';
import { BillingFeatureConfig } from '../../config/domains/features/billing-feature.config';
import { BillingCheckpoints, BillingFlow } from '../billing-checkpoints';
import { withSerializationRetry } from '../../common/db/serialization-retry';
import { financialYearLabel, isSameBusinessDay } from '../../common/time/business-day';

type Tx = Prisma.TransactionClient;

interface ReversalLine {
  item: InvoiceItem;
  quantity: Decimal;
}

interface RestoredStock {
  stock: StockOutcome[];
  /** Cost of the goods that physically came back (custom, SERVICE and DIGITAL lines excluded). */
  costOfGoods: Decimal;
}

export interface ReturnResult {
  invoice: InvoiceWithRelations;
  stock: StockOutcome[];
  replayed: boolean;
}

/**
 * Returns and cancellations: the exact financial and physical inverse of a
 * sale, executed through the same authorities (inventory engine, ledger
 * posting, shift, customer credit) inside one transaction.
 *
 * Lock order matches BillingService: original Invoice → Shift → Customer →
 * NumberSequence → Product rows (ascending productId, before any line insert)
 * → ledger balances.
 */
@Injectable()
export class InvoiceReversalService {
  private readonly logger = new Logger(InvoiceReversalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly helpers: BillingHelpers,
    private readonly engine: InventoryMutationEngine,
    private readonly locationService: InventoryLocationService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly ledger: LedgerPostingService,
    private readonly billingConfig: BillingFeatureConfig,
    private readonly checkpoints: BillingCheckpoints,
  ) {}

  private transaction<T>(flow: BillingFlow, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withSerializationRetry(
      () =>
        this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: this.billingConfig.gatewayTimeoutMs,
          maxWait: this.billingConfig.transactionMaxWaitMs,
        }),
      { attempts: 3, baseDelayMs: this.billingConfig.jitterDelayBaseMs, randomDelayMs: this.billingConfig.jitterDelayRandomMultiplier },
    ).catch((e) => {
      this.logger.debug(`${flow} transaction failed: ${(e as Error).message}`);
      throw e;
    });
  }

  // ---------------------------------------------------------------------------
  // Returns (full or partial)
  // ---------------------------------------------------------------------------

  async processReturn(dto: ReturnInvoiceDto, actor: BillingActor): Promise<ReturnResult> {
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ invoiceId: dto.invoiceId, items: dto.items ?? null, refund: dto.refund ?? null }))
      .digest('hex');

    const existing = await this.prisma.invoice.findFirst({
      where: { idempotencyKey: dto.idempotencyKey, shopId: actor.shopId },
      include: INVOICE_INCLUDE,
    });
    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException({ message: 'This idempotency key was already used for a different return.', code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      return { invoice: existing, stock: [], replayed: true };
    }

    const timeZone = await this.helpers.shopTimeZone(actor.shopId);
    const locationId = await this.locationService.resolveSaleLocation(this.prisma, actor.shopId);

    const outcome = await this.transaction('RETURN', async (tx) => {
        const original = await this.lockOriginal(tx, actor.shopId, dto.invoiceId);
        if (original.type !== 'SALE' || original.status !== 'COMPLETED') {
          throw new ConflictException({ message: 'Only completed sales can be returned.', code: 'INVOICE_NOT_RETURNABLE' });
        }

        const lines = this.selectReturnLines(original.items, dto.items);
        const math = this.returnMath(lines);
        const refundTotal = money(math.finalTotal);
        const now = new Date();
        const financialYear = financialYearLabel(now, timeZone);

        // Shift before customer (canonical lock order). Cash leaves the drawer: an open shift is mandatory.
        const shiftId = await this.billing.lockShift(tx, actor, undefined);

        // Credit reversal: the refund first cancels credit (up to this sale's not
        // yet reversed credit and the customer's current outstanding balance;
        // repayments are not allocated per invoice), the rest is paid out.
        const priorReturnedUdhar = await this.priorReturnedUdhar(tx, actor.shopId, original.id);
        const customer = original.customerId ? await this.billing.lockCustomer(tx, actor.shopId, original.customerId, { allowInactive: true }) : null;
        const reversibleCredit = Prisma.Decimal.max(original.udharAmount.minus(priorReturnedUdhar), 0);
        const udharReversal = customer
          ? Prisma.Decimal.min(refundTotal, reversibleCredit, Prisma.Decimal.max(customer.outstandingBalance, 0))
          : new Prisma.Decimal(0);
        const physicalRefund = refundTotal.minus(udharReversal);
        const tender: TenderType = dto.refund?.tender ?? 'CASH';
        if (physicalRefund.greaterThan(0) && tender === 'CASH' && !shiftId) {
          throw new ConflictException({ message: 'Open a shift before refunding cash.', code: 'SHIFT_REQUIRED' });
        }

        const { number: invoiceNumber } = await this.invoiceNumbers.next(tx, actor.shopId, 'POS_RETURN', `RET-${financialYear}-`);
        // Product locks before the return lines are inserted (see BillingService).
        await this.engine.lockProducts(tx, actor.shopId, lines.map((l) => l.item.productId).filter((id): id is string => !!id));
        const tenders = physicalRefund.greaterThan(0) ? [{ type: tender as 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER', amount: new Decimal(physicalRefund.toString()) }] : [];
        const paymentMode = deriveInvoicePaymentMode(tenders, new Decimal(udharReversal.toString()));

        await this.checkpoints.reach('BEFORE_INVOICE', 'RETURN');
        const returnInvoice = await tx.invoice.create({
          data: {
            invoiceNumber,
            financialYear,
            shopId: actor.shopId,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            customerId: original.customerId,
            cashierId: actor.userId,
            originalId: original.id,
            type: 'SALES_RETURN',
            status: 'COMPLETED',
            paymentMode,
            paymentRef: dto.refund?.reference ?? null,
            isInterState: original.isInterState,
            subtotal: money(math.subtotal),
            discountAmount: money(math.totalDiscount),
            taxableAmount: money(math.taxableTotal),
            cgstAmount: money(math.totalCgst),
            sgstAmount: money(math.totalSgst),
            igstAmount: money(math.totalIgst),
            taxAmount: money(math.totalTax),
            roundOffAmount: money(math.roundOff),
            totalAmount: refundTotal,
            paidAmount: physicalRefund,
            udharAmount: udharReversal,
            changeAmount: new Prisma.Decimal(0),
            notes: [dto.reason, dto.notes].filter(Boolean).join(' - ') || null,
            shiftId,
            items: {
              create: math.lines.map((line) => {
                const src = lines.find((l) => l.item.id === line.lineRef)!.item;
                return {
                  productId: src.productId,
                  isCustom: src.isCustom,
                  productName: src.productName,
                  productSku: src.productSku,
                  quantity: qty(line.quantity),
                  unit: src.unit,
                  costPrice: src.costPrice,
                  sellingPrice: src.sellingPrice,
                  mrp: src.mrp,
                  discountPercent: src.discountPercent,
                  discountAmount: money(line.discountAmount),
                  taxableAmount: money(line.taxableAmount),
                  gstRate: src.gstRate,
                  cgstAmount: money(line.cgstAmount),
                  sgstAmount: money(line.sgstAmount),
                  igstAmount: money(line.igstAmount),
                  cessAmount: money(line.cessAmount),
                  totalAmount: money(line.lineTotal),
                };
              }),
            },
            payments: physicalRefund.greaterThan(0)
              ? { create: [{ shopId: actor.shopId, tender, amount: physicalRefund, tenderedAmount: physicalRefund, changeAmount: 0, reference: dto.refund?.reference ?? null }] }
              : undefined,
          },
          include: INVOICE_INCLUDE,
        });

        await this.checkpoints.reach('AFTER_INVOICE', 'RETURN');

        // Track returned quantities on the original lines.
        for (const line of lines) {
          await tx.invoiceItem.update({ where: { id: line.item.id }, data: { returnedQuantity: { increment: qty(line.quantity) } } });
        }

        await this.checkpoints.reach('BEFORE_INVENTORY', 'RETURN');
        const { stock, costOfGoods } = await this.restoreStock(tx, actor, locationId, lines, returnInvoice.id, `Return ${invoiceNumber}`, now);
        await this.checkpoints.reach('AFTER_INVENTORY', 'RETURN');

        await this.checkpoints.reach('BEFORE_CUSTOMER', 'RETURN');
        if (customer) {
          if (udharReversal.greaterThan(0)) {
            const after = customer.outstandingBalance.minus(udharReversal);
            await tx.udharTransaction.create({
              data: {
                customerId: customer.id,
                invoiceId: returnInvoice.id,
                shopId: actor.shopId,
                recordedById: actor.userId,
                type: 'ADJUSTMENT',
                amount: udharReversal,
                balanceBefore: customer.outstandingBalance,
                balanceAfter: after,
                notes: `Return ${invoiceNumber} against ${original.invoiceNumber}`,
              },
            });
            await tx.customer.update({ where: { id: customer.id }, data: { outstandingBalance: after, totalPurchases: { decrement: refundTotal } } });
          } else {
            await tx.customer.update({ where: { id: customer.id }, data: { totalPurchases: { decrement: refundTotal } } });
          }
        }

        await this.checkpoints.reach('AFTER_CUSTOMER', 'RETURN');

        await this.checkpoints.reach('BEFORE_SHIFT', 'RETURN');
        if (shiftId) {
          await this.applyShiftReversal(tx, shiftId, refundTotal, tenders, udharReversal);
        }
        await this.checkpoints.reach('AFTER_SHIFT', 'RETURN');

        await this.checkpoints.reach('BEFORE_LEDGER', 'RETURN');
        await this.ledger.post(tx, {
          shopId: actor.shopId,
          invoiceId: returnInvoice.id,
          description: `Return ${invoiceNumber}`,
          entries: this.reversalLedgerEntries(math, tenders, udharReversal, costOfGoods),
        });
        await this.checkpoints.reach('AFTER_LEDGER', 'RETURN');

        await this.checkpoints.reach('BEFORE_AUDIT', 'RETURN');
        await tx.auditLog.create({
          data: {
            shopId: actor.shopId,
            userId: actor.userId,
            action: 'INVOICE_RETURNED',
            entity: 'Invoice',
            entityId: returnInvoice.id,
            ipAddress: actor.ipAddress ?? null,
            beforeData: { originalInvoiceId: original.id, originalInvoiceNumber: original.invoiceNumber },
            afterData: {
              returnInvoiceNumber: invoiceNumber,
              refundTotal: refundTotal.toFixed(2),
              physicalRefund: physicalRefund.toFixed(2),
              refundTender: physicalRefund.greaterThan(0) ? tender : null,
              creditReversed: udharReversal.toFixed(2),
              reason: dto.reason ?? null,
              items: lines.map((l) => ({ invoiceItemId: l.item.id, productId: l.item.productId, isCustom: l.item.isCustom, quantity: l.quantity.toFixed(3) })),
            },
          },
        });
        await this.checkpoints.reach('AFTER_AUDIT', 'RETURN');

        await this.checkpoints.reach('EVENT_STAGING', 'RETURN');
        await this.helpers.stageEvent(tx, actor, 'INVOICE_RETURNED', returnInvoice.id, {
          invoiceId: returnInvoice.id,
          invoiceNumber,
          originalInvoiceId: original.id,
          amount: refundTotal.toNumber(),
          items: stock.map((s) => ({ productId: s.productId, quantity: s.quantity, balanceAfter: s.productStockAfter })),
        });

        await this.checkpoints.reach('BEFORE_COMMIT', 'RETURN');
        return { invoice: returnInvoice, stock };
      });

    await this.helpers.afterStockChange(actor, outcome.stock);
    return { ...outcome, replayed: false };
  }

  // ---------------------------------------------------------------------------
  // Cancellation (same business day, no returns yet)
  // ---------------------------------------------------------------------------

  async cancelInvoice(invoiceId: string, dto: CancelInvoiceDto, actor: BillingActor): Promise<ReturnResult> {
    const timeZone = await this.helpers.shopTimeZone(actor.shopId);
    const locationId = await this.locationService.resolveSaleLocation(this.prisma, actor.shopId);

    const outcome = await this.transaction('CANCEL', async (tx) => {
        const original = await this.lockOriginal(tx, actor.shopId, invoiceId);
        if (original.type !== 'SALE') {
          throw new ConflictException({ message: 'Only sales can be cancelled; use a return for return invoices.', code: 'INVOICE_NOT_CANCELLABLE' });
        }
        if (original.status === 'CANCELLED') {
          return { invoice: original, stock: [] as StockOutcome[], alreadyCancelled: true };
        }
        if (original.status !== 'COMPLETED') {
          throw new ConflictException({ message: 'Invoice is not in a cancellable state.', code: 'INVOICE_NOT_CANCELLABLE' });
        }
        const hasReturns = original.items.some((i) => i.returnedQuantity.greaterThan(0));
        if (hasReturns) {
          throw new ConflictException({ message: 'Invoice already has returns; cancel is not allowed.', code: 'INVOICE_NOT_CANCELLABLE' });
        }
        if (!isSameBusinessDay(original.createdAt, new Date(), timeZone)) {
          throw new ConflictException({ message: 'Only invoices from the current business day can be cancelled; use a return instead.', code: 'INVOICE_NOT_CANCELLABLE' });
        }

        const now = new Date();
        const lines: ReversalLine[] = this.sortForLocking(original.items.map((item) => ({ item, quantity: new Decimal(item.quantity.toString()) })));
        const math = this.returnMath(lines);
        const refundTotal = original.totalAmount;

        // Shift before customer (canonical lock order).
        const shiftId = await this.billing.lockShift(tx, actor, undefined);

        // Refund every tender the way it was paid; credit that was already repaid comes back as cash.
        const customer = original.customerId ? await this.billing.lockCustomer(tx, actor.shopId, original.customerId, { allowInactive: true }) : null;
        const udharReversal = customer ? Prisma.Decimal.min(original.udharAmount, Prisma.Decimal.max(customer.outstandingBalance, 0)) : new Prisma.Decimal(0);
        const repaidCredit = original.udharAmount.minus(udharReversal);
        const tenderMap = new Map<TenderType, Prisma.Decimal>();
        for (const p of original.payments) tenderMap.set(p.tender, (tenderMap.get(p.tender) ?? new Prisma.Decimal(0)).plus(p.amount));
        if (original.payments.length === 0 && original.paidAmount.greaterThan(0)) {
          const legacyTender: TenderType = original.paymentMode === 'UPI' ? 'UPI' : original.paymentMode === 'CARD' ? 'CARD' : 'CASH';
          tenderMap.set(legacyTender, (tenderMap.get(legacyTender) ?? new Prisma.Decimal(0)).plus(original.paidAmount));
        }
        if (repaidCredit.greaterThan(0)) tenderMap.set('CASH', (tenderMap.get('CASH') ?? new Prisma.Decimal(0)).plus(repaidCredit));
        const tenders = Array.from(tenderMap.entries())
          .filter(([, amount]) => amount.greaterThan(0))
          .map(([type, amount]) => ({ type: type as 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER', amount: new Decimal(amount.toString()) }));

        const cashRefund = tenderMap.get('CASH') ?? new Prisma.Decimal(0);
        if (cashRefund.greaterThan(0) && !shiftId) {
          throw new ConflictException({ message: 'Open a shift before cancelling a cash invoice.', code: 'SHIFT_REQUIRED' });
        }

        await this.checkpoints.reach('BEFORE_INVOICE', 'CANCEL');
        const cancelled = await tx.invoice.update({
          where: { id: original.id },
          data: { status: 'CANCELLED', cancelReason: dto.reason, cancelledAt: now, cancelledById: actor.userId },
          include: INVOICE_INCLUDE,
        });

        await this.checkpoints.reach('AFTER_INVOICE', 'CANCEL');

        await this.checkpoints.reach('BEFORE_INVENTORY', 'CANCEL');
        const { stock, costOfGoods } = await this.restoreStock(tx, actor, locationId, lines, original.id, `Cancelled ${original.invoiceNumber}`, now);
        await this.checkpoints.reach('AFTER_INVENTORY', 'CANCEL');

        await this.checkpoints.reach('BEFORE_CUSTOMER', 'CANCEL');
        if (customer) {
          if (udharReversal.greaterThan(0)) {
            const after = customer.outstandingBalance.minus(udharReversal);
            await tx.udharTransaction.create({
              data: {
                customerId: customer.id,
                invoiceId: original.id,
                shopId: actor.shopId,
                recordedById: actor.userId,
                type: 'ADJUSTMENT',
                amount: udharReversal,
                balanceBefore: customer.outstandingBalance,
                balanceAfter: after,
                notes: `Cancellation of ${original.invoiceNumber}`,
              },
            });
            await tx.customer.update({ where: { id: customer.id }, data: { outstandingBalance: after, totalPurchases: { decrement: refundTotal } } });
          } else {
            await tx.customer.update({ where: { id: customer.id }, data: { totalPurchases: { decrement: refundTotal } } });
          }
        }

        await this.checkpoints.reach('AFTER_CUSTOMER', 'CANCEL');

        await this.checkpoints.reach('BEFORE_SHIFT', 'CANCEL');
        if (shiftId) await this.applyShiftReversal(tx, shiftId, refundTotal, tenders, udharReversal);
        await this.checkpoints.reach('AFTER_SHIFT', 'CANCEL');

        await this.checkpoints.reach('BEFORE_LEDGER', 'CANCEL');
        await this.ledger.post(tx, {
          shopId: actor.shopId,
          invoiceId: original.id,
          description: `Cancellation ${original.invoiceNumber}`,
          entries: this.reversalLedgerEntries(math, tenders, udharReversal, costOfGoods),
        });
        await this.checkpoints.reach('AFTER_LEDGER', 'CANCEL');

        await this.checkpoints.reach('BEFORE_AUDIT', 'CANCEL');
        await tx.auditLog.create({
          data: {
            shopId: actor.shopId,
            userId: actor.userId,
            action: 'INVOICE_CANCELLED',
            entity: 'Invoice',
            entityId: original.id,
            ipAddress: actor.ipAddress ?? null,
            beforeData: { status: 'COMPLETED', totalAmount: original.totalAmount.toFixed(2) },
            afterData: { status: 'CANCELLED', reason: dto.reason, refunds: tenders.map((t) => ({ type: t.type, amount: t.amount.toFixed(2) })), creditReversed: udharReversal.toFixed(2) },
          },
        });
        await this.checkpoints.reach('AFTER_AUDIT', 'CANCEL');

        await this.checkpoints.reach('EVENT_STAGING', 'CANCEL');
        await this.helpers.stageEvent(tx, actor, 'INVOICE_CANCELLED', original.id, {
          invoiceId: original.id,
          invoiceNumber: original.invoiceNumber,
          amount: refundTotal.toNumber(),
          items: stock.map((s) => ({ productId: s.productId, quantity: s.quantity, balanceAfter: s.productStockAfter })),
        });

        await this.checkpoints.reach('BEFORE_COMMIT', 'CANCEL');
        return { invoice: cancelled, stock, alreadyCancelled: false };
      });

    await this.helpers.afterStockChange(actor, outcome.stock);
    return { invoice: outcome.invoice, stock: outcome.stock, replayed: outcome.alreadyCancelled };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async lockOriginal(tx: Tx, shopId: string, invoiceId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM Invoice WHERE id = ${invoiceId} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundException({ message: 'Invoice not found.', code: 'INVOICE_NOT_FOUND' });
    const original = await tx.invoice.findFirst({ where: { id: invoiceId, shopId }, include: INVOICE_INCLUDE });
    if (!original) throw new NotFoundException({ message: 'Invoice not found.', code: 'INVOICE_NOT_FOUND' });
    return original;
  }

  private selectReturnLines(items: InvoiceItem[], requested?: Array<{ invoiceItemId: string; quantity: number }>): ReversalLine[] {
    const remainingOf = (item: InvoiceItem) => new Decimal(item.quantity.toString()).minus(item.returnedQuantity.toString());
    let lines: ReversalLine[];
    if (!requested || requested.length === 0) {
      lines = items.filter((i) => remainingOf(i).greaterThan(0)).map((item) => ({ item, quantity: remainingOf(item) }));
    } else {
      lines = requested.map((r) => {
        const item = items.find((i) => i.id === r.invoiceItemId);
        if (!item) throw new NotFoundException({ message: `Invoice line ${r.invoiceItemId} not found.`, code: 'INVOICE_ITEM_NOT_FOUND' });
        const quantity = new Decimal(r.quantity).toDecimalPlaces(3);
        const remaining = remainingOf(item);
        if (quantity.greaterThan(remaining)) {
          throw new ConflictException({
            message: `Only ${remaining.toString()} of ${item.productName} can still be returned.`,
            code: 'RETURN_QTY_EXCEEDS',
            details: { invoiceItemId: item.id, requested: quantity.toNumber(), returnable: remaining.toNumber() },
          });
        }
        return { item, quantity };
      });
      const ids = new Set<string>();
      for (const l of lines) {
        if (ids.has(l.item.id)) throw new ConflictException({ message: 'Duplicate return line.', code: 'ERR_DUPLICATE_LINE' });
        ids.add(l.item.id);
      }
    }
    if (lines.length === 0) {
      throw new ConflictException({ message: 'Nothing left to return on this invoice.', code: 'INVOICE_NOT_RETURNABLE' });
    }
    return this.sortForLocking(lines);
  }

  /** Catalogue lines in ascending productId (the engine's lock order), custom lines last. */
  private sortForLocking(lines: ReversalLine[]): ReversalLine[] {
    return [...lines].sort((a, b) => {
      if (!a.item.productId && !b.item.productId) return 0;
      if (!a.item.productId) return 1;
      if (!b.item.productId) return -1;
      return a.item.productId.localeCompare(b.item.productId);
    });
  }

  /** Legacy lines (before persisted line math) derive taxable/discount from the stored totals. */
  private lineAmounts(item: InvoiceItem) {
    const taxes = item.cgstAmount.plus(item.sgstAmount).plus(item.igstAmount).plus(item.cessAmount);
    if (item.taxableAmount.greaterThan(0) || item.totalAmount.isZero()) {
      return { discountAmount: item.discountAmount, taxableAmount: item.taxableAmount };
    }
    const taxable = item.totalAmount.minus(taxes);
    const gross = item.sellingPrice.mul(item.quantity);
    return { discountAmount: Prisma.Decimal.max(gross.minus(taxable), 0), taxableAmount: taxable };
  }

  private returnMath(lines: ReversalLine[]): ReturnCalculationResult {
    try {
      return InvoiceMathEngine.calculateReturn({
        lines: lines.map(({ item, quantity }) => {
          const amounts = this.lineAmounts(item);
          return {
            lineRef: item.id,
            originalQuantity: item.quantity.toString(),
            quantity: quantity.toString(),
            unitPrice: item.sellingPrice.toString(),
            discountAmount: amounts.discountAmount.toString(),
            taxableAmount: amounts.taxableAmount.toString(),
            cgstAmount: item.cgstAmount.toString(),
            sgstAmount: item.sgstAmount.toString(),
            igstAmount: item.igstAmount.toString(),
            cessAmount: item.cessAmount.toString(),
            totalAmount: item.totalAmount.toString(),
          };
        }),
      });
    } catch (e) {
      if (e instanceof InvoiceMathError || (e as { name?: string })?.name === 'InvoiceMathError') {
        throw new ConflictException({ message: (e as Error).message, code: (e as { code: string }).code });
      }
      throw e;
    }
  }

  private async priorReturnedUdhar(tx: Tx, shopId: string, originalId: string): Promise<Prisma.Decimal> {
    const agg = await tx.invoice.aggregate({ where: { shopId, originalId, type: 'SALES_RETURN', status: 'COMPLETED', isDeleted: false }, _sum: { udharAmount: true } });
    return agg._sum.udharAmount ?? new Prisma.Decimal(0);
  }

  /** Physical restock for catalogue lines; custom lines are money-only and never enter the inventory authority. */
  private async restoreStock(tx: Tx, actor: BillingActor, locationId: string, lines: ReversalLine[], referenceId: string, reason: string, occurredAt: Date): Promise<RestoredStock> {
    const stock: StockOutcome[] = [];
    let costOfGoods = new Decimal(0);
    for (const line of lines) {
      const productId = line.item.productId;
      if (!productId || line.item.isCustom) continue;
      const result = await this.engine.mutateStock(tx, {
        shopId: actor.shopId,
        locationId,
        productId,
        quantity: line.quantity.toNumber(),
        mutationType: MutationType.RETURN,
        reason,
        referenceId,
        performedBy: actor.userId,
        occurredAt,
        allowNegative: true,
      });
      if (!result.bypassed) {
        stock.push({ productId, quantity: line.quantity.toNumber(), balanceAfter: result.balanceAfter.toNumber(), productStockAfter: result.productStockAfter.toNumber() });
        costOfGoods = costOfGoods.plus(new Decimal(line.item.costPrice.toString()).mul(line.quantity));
      }
    }
    return { stock, costOfGoods };
  }

  private async applyShiftReversal(tx: Tx, shiftId: string, refundTotal: Prisma.Decimal, tenders: ReadonlyArray<{ type: string; amount: Decimal }>, udharReversal: Prisma.Decimal) {
    const buckets = this.billing.tenderBuckets(tenders);
    await tx.shift.update({
      where: { id: shiftId },
      data: {
        totalSales: { decrement: refundTotal },
        cashSales: { decrement: buckets.cash },
        upiSales: { decrement: buckets.upi },
        cardSales: { decrement: buckets.card },
        udharSales: { decrement: udharReversal },
        expectedCash: { decrement: buckets.cash },
      },
    });
  }

  private reversalLedgerEntries(math: ReturnCalculationResult, tenders: ReadonlyArray<{ type: string; amount: Decimal }>, udharReversal: Prisma.Decimal, costOfGoods: Decimal): LedgerEntryInput[] {
    const buckets = this.billing.tenderBuckets(tenders);
    const entries: LedgerEntryInput[] = [
      { account: LedgerAccount.SALES_REVENUE, type: LedgerEntryType.DEBIT, amount: money(math.taxableTotal.plus(math.roundOff)) },
      { account: LedgerAccount.GST_PAYABLE, type: LedgerEntryType.DEBIT, amount: money(math.totalTax) },
      { account: LedgerAccount.CASH, type: LedgerEntryType.CREDIT, amount: buckets.cash },
      { account: LedgerAccount.BANK, type: LedgerEntryType.CREDIT, amount: buckets.bank },
      { account: LedgerAccount.ACCOUNTS_RECEIVABLE, type: LedgerEntryType.CREDIT, amount: udharReversal },
    ];
    if (costOfGoods.greaterThan(0)) {
      entries.push({ account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: money(costOfGoods) });
      entries.push({ account: LedgerAccount.COST_OF_GOODS, type: LedgerEntryType.CREDIT, amount: money(costOfGoods) });
    }
    return entries;
  }
}
