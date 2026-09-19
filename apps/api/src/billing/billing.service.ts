import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GstRate, LedgerAccount, LedgerEntryType, Prisma, ProductType, ProductUnit, TenderType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvoiceDto, InvoiceItemDto, PaymentTenderDto } from './dto/create-invoice.dto';
import { CalculateInvoiceDto } from './dto/calculate-invoice.dto';
import { InventoryCacheService } from '../inventory/inventory-cache.service';
import { BillingHelpers } from './billing.helpers';
import { InvoiceMathEngine, InvoiceMathError, Decimal, InvoiceMathInput, InvoiceCalculationResultV1 } from './utils/invoice-math.engine';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { BillingFeatureConfig } from '../config/domains/features/billing-feature.config';
import { InventoryMutationEngine, MutationType } from '../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../inventory-domain/services/inventory-location.service';
import { OptimisticLockConflictError, InsufficientStockError } from '../inventory-domain/errors/inventory.errors';
import { InvoiceNumberService } from './services/invoice-number.service';
import { LedgerPostingService, LedgerEntryInput } from '../ledger/ledger-posting.service';
import { BillingActor, INVOICE_INCLUDE, InvoiceWithRelations, StockOutcome, isManager, money, qty } from './billing.types';
import { BillingCheckpoints } from './billing-checkpoints';
import { isSerializationFailure } from '../common/db/serialization-retry';
import { financialYearLabel, safeTimeZone } from '../common/time/business-day';

type Tx = Prisma.TransactionClient;

/** Custom (ad-hoc) line as accepted by the API: never in the catalogue, never in stock. */
export interface CustomLine {
  name: string;
  /** Money as a string so no float ever reaches the engine. */
  unitPrice: string;
  gstRate: GstRate;
  unit: ProductUnit;
}

/**
 * A validated, merged request line. `key` is the engine line id: the
 * productId for catalogue lines, `custom:<n>` for ad-hoc lines. Catalogue
 * lines come first, sorted by productId: every transaction locks product
 * rows in the same order, and the locks are taken before any row that
 * references a product is inserted.
 */
export interface NormalisedLine {
  key: string;
  productId: string | null;
  custom: CustomLine | null;
  quantity: number;
  discountPercent: number;
}

interface LockedCustomer {
  id: string;
  name: string;
  state: string | null;
  outstandingBalance: Prisma.Decimal;
  creditLimit: Prisma.Decimal;
  isActive: boolean;
}

export interface ProductRow {
  id: string;
  name: string;
  sku: string;
  type: ProductType;
  unit: ProductUnit;
  currentStock: Prisma.Decimal;
  stockVersion: number;
  sellingPrice: Prisma.Decimal;
  costPrice: Prisma.Decimal;
  mrp: Prisma.Decimal;
  gstRate: GstRate;
  cessRate: Prisma.Decimal;
}

export interface CreateInvoiceResult {
  invoice: InvoiceWithRelations;
  stock: StockOutcome[];
  shiftId: string | null;
  replayed: boolean;
}

const OCC_RETRY_MARKER = 'OPTIMISTIC_LOCK_CONFLICT';
const STOCKED_TYPES = new Set<string>(['SIMPLE', 'VARIABLE', 'BUNDLE', 'COMBO']);
export const CUSTOM_LINE_PREFIX = 'custom:';
export const CUSTOM_SKU = 'CUSTOM';

/**
 * POS checkout.
 *
 * One request = one atomic transaction that creates the invoice, its lines
 * and tenders, deducts stock through the inventory engine, updates the
 * customer's credit under a row lock, updates the open shift, posts a
 * balanced double-entry ledger, writes the audit row and stages the outbox
 * event. Any failure rolls all of it back. Redis is advisory only.
 *
 * Lock order (shared with returns, cancellations and repayments):
 *   original Invoice → Shift → Customer → NumberSequence → Product rows
 *   (ascending productId, exclusive, taken before invoice lines are inserted)
 *   → LedgerAccountBalance (ascending account). A deadlock or lock-wait
 *   rollback (Prisma P2034/P2028, MySQL 1213/1205 via P2010) is retried.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryCache: InventoryCacheService,
    private readonly billingHelpers: BillingHelpers,
    private readonly tenantContext: TenantContextService,
    private readonly billingConfig: BillingFeatureConfig,
    private readonly inventoryMutationEngine: InventoryMutationEngine,
    private readonly locationService: InventoryLocationService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly ledger: LedgerPostingService,
    private readonly checkpoints: BillingCheckpoints,
  ) {}

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  async calculateInvoice(dto: CalculateInvoiceDto, actor: BillingActor) {
    const lines = this.normaliseLines(dto.items);
    const products = await this.loadProducts(actor.shopId, productIds(lines));
    const { isInterState, shopState, customerState } = await this.resolveInterState(actor.shopId, dto.customerId);

    const payments = dto.payments ? this.toPaymentInput(dto.payments, dto.udharAmount) : undefined;
    const result = this.runEngine({
      items: lines.map((l) => this.toMathItem(l, products, isInterState)),
      discountAmount: dto.discountAmount,
      discountPercentage: dto.discountPercentage,
      discountType: dto.discountType,
      discountReason: dto.discountReason,
      payment: payments,
    });
    this.enforceDiscountAuthority(actor, lines, result);

    return { ...result, isInterState, shopState, customerState };
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async createInvoice(dto: CreateInvoiceDto, actor: BillingActor): Promise<CreateInvoiceResult> {
    const lines = this.normaliseLines(dto.items);
    const paymentInput = this.toPaymentInput(dto.payments ?? this.legacyPayments(dto), dto.udharAmount ?? (dto.payments ? 0 : this.legacyUdhar(dto)));
    const requestHash = this.hashRequest({ lines, dto, paymentInput });

    // 1. Idempotent replay (same key + same payload) or reuse rejection.
    const existing = await this.prisma.invoice.findFirst({
      where: { idempotencyKey: dto.idempotencyKey, shopId: actor.shopId },
      include: INVOICE_INCLUDE,
    });
    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException({
          message: 'This idempotency key was already used for a different request.',
          code: 'IDEMPOTENCY_KEY_REUSED',
          details: { invoiceId: existing.id, invoiceNumber: existing.invoiceNumber },
        });
      }
      return { invoice: existing, stock: [], shiftId: existing.shiftId, replayed: true };
    }

    // 2. Products and pure validation (engine limits, discounts, settlement,
    //    authority) before any stock check or lock: invalid input is rejected
    //    deterministically whatever the stock position.
    const products = await this.loadProducts(actor.shopId, productIds(lines));
    const { isInterState } = await this.resolveInterState(actor.shopId, dto.customerId);
    if (paymentInput.udharAmount.greaterThan(0) && !dto.customerId) {
      throw new BadRequestException({ message: 'A customer must be selected for credit (udhar) billing.', code: 'CUSTOMER_REQUIRED' });
    }
    let math: InvoiceCalculationResultV1 = this.runEngine({
      items: lines.map((l) => this.toMathItem(l, products, isInterState)),
      discountAmount: dto.discountAmount,
      discountPercentage: dto.discountPercentage,
      discountType: dto.discountType,
      discountReason: dto.discountReason,
      payment: paymentInput,
    });
    this.enforceDiscountAuthority(actor, lines, math);

    // 3. Location and availability (fail fast before any lock).
    const locationId = await this.locationService.resolveSaleLocation(this.prisma, actor.shopId);
    const availability = await this.loadAvailability(actor.shopId, locationId, products);
    for (const line of stockedLines(lines, products)) {
      const product = products.get(line.productId!)!;
      const available = availability.get(line.productId!) ?? 0;
      if (available < line.quantity) {
        await this.billingHelpers.auditRejected(actor, 'INSUFFICIENT_STOCK', { productId: product.id, requestedQty: line.quantity, availableQty: available });
        throw this.insufficientStock(product, line.quantity, available);
      }
    }

    // 4. Redis advisory pre-check (never authoritative, always compensated).
    const decrementedInRedis: NormalisedLine[] = [];
    for (const line of stockedLines(lines, products)) {
      const status = await this.inventoryCache.tryDecrementStock(line.productId!, line.quantity);
      if (status === 'ok') {
        decrementedInRedis.push(line);
      } else if (status === 'insufficient') {
        // The DB said there is enough (step 3): the cache is stale. Repair it and continue.
        await this.inventoryCache.syncStock(line.productId!, products.get(line.productId!)!.currentStock.toString());
      }
    }

    const timeZone = await this.billingHelpers.shopTimeZone(actor.shopId);
    const MAX_RETRIES = 3;
    let attempt = 0;

    try {
      while (attempt < MAX_RETRIES) {
        attempt++;
        try {
          const outcome = await this.prisma.$transaction(
            async (tx) => {
              const now = new Date();
              const financialYear = financialYearLabel(now, timeZone);

              // Authoritative prices are the ones committed when this transaction runs:
              // re-read the products and recompute so a price change between the
              // preview and the checkout can never be persisted silently (the fixed
              // tender amounts would no longer match and the engine rejects it).
              const txProducts = await this.loadProducts(actor.shopId, productIds(lines), tx);
              txProducts.forEach((p, id) => products.set(id, p));
              math = this.runEngine({
                items: lines.map((l) => this.toMathItem(l, products, isInterState)),
                discountAmount: dto.discountAmount,
                discountPercentage: dto.discountPercentage,
                discountType: dto.discountType,
                discountReason: dto.discountReason,
                payment: paymentInput,
              });
              this.enforceDiscountAuthority(actor, lines, math);
              const payment = math.payment!;

              // a. Shift (explicit or the cashier's open one), locked for the whole transaction.
              const shiftId = await this.lockShift(tx, actor, dto.shiftId);

              // b. Customer lock + credit-limit check.
              let customer: LockedCustomer | null = null;
              if (dto.customerId) {
                customer = await this.lockCustomer(tx, actor.shopId, dto.customerId);
                if (payment.udharAmount.greaterThan(0)) {
                  const projected = customer.outstandingBalance.plus(money(payment.udharAmount));
                  if (projected.greaterThan(customer.creditLimit) && !isManager(actor.role)) {
                    throw new ConflictException({
                      message: `Credit limit exceeded for ${customer.name}.`,
                      code: 'CREDIT_LIMIT_EXCEEDED',
                      details: {
                        creditLimit: customer.creditLimit.toNumber(),
                        currentBalance: customer.outstandingBalance.toNumber(),
                        requestedAmount: payment.udharAmount.toNumber(),
                        projectedBalance: projected.toNumber(),
                      },
                    });
                  }
                }
              }

              // c. Gapless number.
              const { number: invoiceNumber } = await this.invoiceNumbers.next(tx, actor.shopId, 'POS_INVOICE', `INV-${financialYear}-`);

              // d. Product rows (ascending id) BEFORE the invoice lines are inserted:
              //    inserting a line takes a shared lock on its product, and upgrading
              //    that to the engine's exclusive lock later would deadlock two
              //    transactions touching the same product.
              await this.inventoryMutationEngine.lockProducts(tx, actor.shopId, productIds(lines));

              // e. Invoice + lines.
              await this.checkpoints.reach('BEFORE_INVOICE', 'SALE');
              const discountApplied = math.invoiceDiscount.greaterThan(0) || math.totalItemDiscount.greaterThan(0);
              const created = await tx.invoice.create({
                data: {
                  invoiceNumber,
                  financialYear,
                  shopId: actor.shopId,
                  idempotencyKey: dto.idempotencyKey,
                  requestHash,
                  customerId: dto.customerId ?? null,
                  cashierId: actor.userId,
                  paymentMode: payment.paymentMode,
                  status: 'COMPLETED',
                  type: 'SALE',
                  subtotal: money(math.subtotal),
                  discountAmount: money(math.totalDiscount),
                  discountPercentage: dto.discountPercentage !== undefined ? new Prisma.Decimal(dto.discountPercentage) : null,
                  discountType: math.invoiceDiscount.greaterThan(0) ? (dto.discountType ?? 'FIXED_AMOUNT') : null,
                  discountReason: math.invoiceDiscount.greaterThan(0) ? dto.discountReason ?? null : null,
                  approvedBy: discountApplied ? actor.userId : null,
                  approvalTimestamp: discountApplied ? now : null,
                  taxableAmount: money(math.taxableTotal),
                  taxAmount: money(math.totalTax),
                  cgstAmount: money(math.totalCgst),
                  sgstAmount: money(math.totalSgst),
                  igstAmount: money(math.totalIgst),
                  roundOffAmount: money(math.roundOff),
                  totalAmount: money(math.finalTotal),
                  paidAmount: money(payment.paidAmount),
                  changeAmount: money(payment.changeAmount),
                  udharAmount: money(payment.udharAmount),
                  paymentRef: payment.tenders.map((t) => t.reference).filter(Boolean).join(',') || null,
                  isInterState,
                  notes: dto.notes ?? null,
                  shiftId,
                  items: {
                    create: math.lines.map((line) => {
                      const source = lines.find((l) => l.key === line.productId)!;
                      return this.invoiceItemData(source, products, line);
                    }),
                  },
                },
                select: { id: true },
              });
              await this.checkpoints.reach('AFTER_INVOICE', 'SALE');

              // f. Tenders.
              await this.checkpoints.reach('BEFORE_PAYMENT', 'SALE');
              const tenderRows = payment.tenders
                .filter((t) => t.amount.greaterThan(0) || t.changeAmount.greaterThan(0))
                .map((t) => ({
                  invoiceId: created.id,
                  shopId: actor.shopId,
                  tender: t.type as TenderType,
                  amount: money(t.amount),
                  tenderedAmount: money(t.tenderedAmount),
                  changeAmount: money(t.changeAmount),
                  reference: t.reference ?? null,
                }));
              if (tenderRows.length > 0) await tx.invoicePayment.createMany({ data: tenderRows });
              await this.checkpoints.reach('AFTER_PAYMENT', 'SALE');

              // g. Stock, one engine call per catalogue line (product locks already held, in key order).
              await this.checkpoints.reach('BEFORE_INVENTORY', 'SALE');
              const stock: StockOutcome[] = [];
              let costOfGoods = new Decimal(0);
              for (const line of lines) {
                if (!line.productId) continue;
                const product = products.get(line.productId)!;
                try {
                  const result = await this.inventoryMutationEngine.mutateStock(tx, {
                    shopId: actor.shopId,
                    locationId,
                    productId: line.productId,
                    quantity: line.quantity,
                    mutationType: MutationType.SALE,
                    reason: `Sale ${invoiceNumber}`,
                    referenceId: created.id,
                    performedBy: actor.userId,
                    occurredAt: now,
                    allowNegative: false,
                  });
                  if (!result.bypassed) {
                    stock.push({
                      productId: line.productId,
                      quantity: line.quantity,
                      balanceAfter: result.balanceAfter.toNumber(),
                      productStockAfter: result.productStockAfter.toNumber(),
                    });
                    costOfGoods = costOfGoods.plus(new Decimal(product.costPrice.toString()).mul(line.quantity));
                  }
                } catch (e) {
                  if (e instanceof OptimisticLockConflictError) throw new Error(OCC_RETRY_MARKER);
                  if (e instanceof InsufficientStockError) {
                    throw this.insufficientStock(product, line.quantity, Number(e.details?.availableQty ?? 0));
                  }
                  throw e;
                }
              }
              await this.checkpoints.reach('AFTER_INVENTORY', 'SALE');

              // g. Customer credit and purchase stats.
              await this.checkpoints.reach('BEFORE_CUSTOMER', 'SALE');
              if (customer) {
                if (payment.udharAmount.greaterThan(0)) {
                  const before = customer.outstandingBalance;
                  const after = before.plus(money(payment.udharAmount));
                  await tx.udharTransaction.create({
                    data: {
                      customerId: customer.id,
                      invoiceId: created.id,
                      shopId: actor.shopId,
                      recordedById: actor.userId,
                      type: 'CREDIT',
                      amount: money(payment.udharAmount),
                      balanceBefore: before,
                      balanceAfter: after,
                      notes: `Credit sale ${invoiceNumber}`,
                    },
                  });
                  await tx.customer.update({
                    where: { id: customer.id },
                    data: { outstandingBalance: after, totalPurchases: { increment: money(math.finalTotal) }, lastPurchaseAt: now },
                  });
                } else {
                  await tx.customer.update({
                    where: { id: customer.id },
                    data: { totalPurchases: { increment: money(math.finalTotal) }, lastPurchaseAt: now },
                  });
                }
              }
              await this.checkpoints.reach('AFTER_CUSTOMER', 'SALE');

              // h. Shift counters (cash expected = cash applied, i.e. tendered - change).
              await this.checkpoints.reach('BEFORE_SHIFT', 'SALE');
              if (shiftId) {
                const buckets = this.tenderBuckets(payment.tenders);
                await tx.shift.update({
                  where: { id: shiftId },
                  data: {
                    totalSales: { increment: money(math.finalTotal) },
                    cashSales: { increment: buckets.cash },
                    upiSales: { increment: buckets.upi },
                    cardSales: { increment: buckets.card },
                    udharSales: { increment: money(payment.udharAmount) },
                    expectedCash: { increment: buckets.cash },
                  },
                });
              }
              await this.checkpoints.reach('AFTER_SHIFT', 'SALE');

              // i. Balanced double-entry ledger.
              await this.checkpoints.reach('BEFORE_LEDGER', 'SALE');
              await this.ledger.post(tx, {
                shopId: actor.shopId,
                invoiceId: created.id,
                description: `Sale ${invoiceNumber}`,
                entries: this.saleLedgerEntries(payment.tenders, payment.udharAmount, math, costOfGoods),
              });
              await this.checkpoints.reach('AFTER_LEDGER', 'SALE');

              // j. Audit.
              await this.checkpoints.reach('BEFORE_AUDIT', 'SALE');
              await tx.auditLog.create({
                data: {
                  shopId: actor.shopId,
                  userId: actor.userId,
                  action: 'INVOICE_CREATED',
                  entity: 'Invoice',
                  entityId: created.id,
                  ipAddress: actor.ipAddress ?? null,
                  afterData: {
                    invoiceNumber,
                    totalAmount: math.finalTotal.toFixed(2),
                    itemCount: lines.length,
                    customItemCount: lines.filter((l) => l.custom).length,
                    paymentMode: payment.paymentMode,
                    tenders: payment.tenders.map((t) => ({ type: t.type, amount: t.amount.toFixed(2), change: t.changeAmount.toFixed(2) })),
                    udharAmount: payment.udharAmount.toFixed(2),
                    discount: discountApplied
                      ? {
                          invoiceAmount: math.invoiceDiscount.toFixed(2),
                          lineAmount: math.totalItemDiscount.toFixed(2),
                          maxLinePercent: lines.reduce((acc, l) => Math.max(acc, l.discountPercent), 0),
                          reason: dto.discountReason ?? null,
                          approvedBy: actor.userId,
                          approverRole: actor.role,
                        }
                      : null,
                    customerId: dto.customerId ?? null,
                    shiftId,
                  },
                },
              });
              await this.checkpoints.reach('AFTER_AUDIT', 'SALE');

              // k. Outbox.
              await this.checkpoints.reach('EVENT_STAGING', 'SALE');
              await this.billingHelpers.stageEvent(tx, actor, 'INVOICE_CREATED', created.id, {
                invoiceId: created.id,
                invoiceNumber,
                type: 'SALE',
                customerId: dto.customerId ?? null,
                amount: math.finalTotal.toNumber(),
                paymentMode: payment.paymentMode,
                items: stock.map((s) => ({ productId: s.productId, quantity: s.quantity, balanceAfter: s.productStockAfter })),
              });

              const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: created.id }, include: INVOICE_INCLUDE });
              await this.checkpoints.reach('BEFORE_COMMIT', 'SALE');
              return { invoice, stock, shiftId };
            },
            {
              timeout: this.billingConfig.gatewayTimeoutMs,
              maxWait: this.billingConfig.transactionMaxWaitMs,
              isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            },
          );

          // Committed: make the caches and listeners agree with the database.
          await this.billingHelpers.afterStockChange(actor, outcome.stock);
          return { ...outcome, replayed: false };
        } catch (error) {
          if (this.isIdempotencyRace(error)) {
            const duplicate = await this.prisma.invoice.findFirst({
              where: { idempotencyKey: dto.idempotencyKey, shopId: actor.shopId },
              include: INVOICE_INCLUDE,
            });
            if (duplicate) {
              await this.restoreRedis(decrementedInRedis);
              return { invoice: duplicate, stock: [], shiftId: duplicate.shiftId, replayed: true };
            }
          }
          const occConflict = error instanceof Error && error.message === OCC_RETRY_MARKER;
          if ((occConflict || isSerializationFailure(error)) && attempt < MAX_RETRIES) {
            this.logger.warn(`${occConflict ? 'Optimistic lock conflict' : 'Transaction rolled back by the database'} on attempt ${attempt}, retrying`);
            await this.jitter();
            const fresh = await this.loadProducts(actor.shopId, productIds(lines));
            fresh.forEach((p, id) => products.set(id, p));
            continue;
          }
          throw error;
        }
      }
      throw new ConflictException({ message: 'Could not complete the bill due to concurrent activity. Please try again.', code: 'MAX_RETRIES_EXCEEDED' });
    } catch (error) {
      await this.restoreRedis(decrementedInRedis);
      if (error instanceof ConflictException) {
        const body = error.getResponse() as { code?: string; details?: unknown };
        if (body?.code === 'CREDIT_LIMIT_EXCEEDED' || body?.code === 'INSUFFICIENT_STOCK') {
          await this.billingHelpers.auditRejected(actor, body.code, body.details);
        }
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers shared with the reversal service
  // ---------------------------------------------------------------------------

  /**
   * Merges duplicate catalogue lines (same discount), validates custom lines
   * and returns catalogue lines sorted by productId followed by custom lines
   * in submission order.
   */
  normaliseLines(items: InvoiceItemDto[]): NormalisedLine[] {
    const merged = new Map<string, NormalisedLine>();
    const customs: NormalisedLine[] = [];
    items.forEach((item, index) => {
      const discount = item.discountPercent ?? 0;
      const quantity = Number(new Decimal(item.quantity ?? NaN).toFixed(3));
      if (!(quantity > 0)) {
        throw new BadRequestException({ message: `Quantity on line ${index + 1} must be greater than 0.`, code: 'ERR_INVALID_QUANTITY', details: { index } });
      }
      if (item.custom !== undefined && item.productId !== undefined) {
        throw new BadRequestException({ message: 'A line is either a catalogue product or a custom item, not both.', code: 'CUSTOM_ITEM_INVALID', details: { index } });
      }
      if (item.custom !== undefined) {
        const name = item.custom.name?.trim();
        const price = new Decimal(item.custom.unitPrice ?? NaN);
        if (!name || !price.isFinite() || price.lessThanOrEqualTo(0)) {
          throw new BadRequestException({ message: 'A custom item needs a name and a positive unit price.', code: 'CUSTOM_ITEM_INVALID', details: { index } });
        }
        customs.push({
          key: `${CUSTOM_LINE_PREFIX}${index}`,
          productId: null,
          custom: { name, unitPrice: price.toFixed(2), gstRate: item.custom.gstRate, unit: item.custom.unit ?? ProductUnit.PCS },
          quantity,
          discountPercent: discount,
        });
        return;
      }
      if (!item.productId) {
        throw new BadRequestException({ message: 'Each line needs a productId or a custom item.', code: 'CUSTOM_ITEM_INVALID', details: { index } });
      }
      const existing = merged.get(item.productId);
      if (existing) {
        if (existing.discountPercent !== discount) {
          throw new BadRequestException({
            message: `Product ${item.productId} appears twice with different discounts.`,
            code: 'ERR_DUPLICATE_LINE',
          });
        }
        existing.quantity = Number(new Decimal(existing.quantity).plus(quantity).toFixed(3));
      } else {
        merged.set(item.productId, { key: item.productId, productId: item.productId, custom: null, quantity, discountPercent: discount });
      }
    });
    const products = Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
    return [...products, ...customs];
  }

  async loadProducts(shopId: string, ids: string[], db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<Map<string, ProductRow>> {
    if (ids.length === 0) return new Map();
    const rows = await db.product.findMany({
      where: { id: { in: ids }, shopId, isDeleted: false, isActive: true },
      select: {
        id: true, name: true, sku: true, type: true, unit: true, currentStock: true, stockVersion: true,
        sellingPrice: true, costPrice: true, mrp: true, gstRate: true, cessRate: true,
      },
    });
    const map = new Map<string, ProductRow>(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !map.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({ message: `Products not found or inactive: ${missing.join(', ')}`, code: 'PRODUCT_NOT_FOUND', details: { productIds: missing } });
    }
    return map;
  }

  private async loadAvailability(shopId: string, locationId: string, products: Map<string, ProductRow>): Promise<Map<string, number>> {
    if (products.size === 0) return new Map();
    const items = await this.prisma.inventoryItem.findMany({
      where: { shopId, locationId, variantId: null, isDeleted: false, productId: { in: Array.from(products.keys()) } },
      select: { productId: true, onHand: true, reserved: true },
    });
    const anyItems = await this.prisma.inventoryItem.groupBy({
      by: ['productId'],
      where: { shopId, isDeleted: false, productId: { in: Array.from(products.keys()) } },
      _count: { _all: true },
    });
    const hasItems = new Set(anyItems.map((a) => a.productId));
    const map = new Map<string, number>();
    for (const [id, product] of products) {
      const item = items.find((i) => i.productId === id);
      if (item) map.set(id, item.onHand.minus(item.reserved).toNumber());
      // Legacy products without any InventoryItem: the engine bootstraps from currentStock.
      else if (!hasItems.has(id)) map.set(id, product.currentStock.toNumber());
      else map.set(id, 0);
    }
    return map;
  }

  async resolveInterState(shopId: string, customerId?: string | null) {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId }, select: { state: true } });
    const shopState = shop?.state ?? null;
    let customerState: string | null = null;
    if (customerId) {
      const customer = await this.prisma.customer.findFirst({ where: { id: customerId, shopId, isDeleted: false }, select: { state: true } });
      if (!customer) throw new NotFoundException({ message: 'Customer not found.', code: 'CUSTOMER_NOT_FOUND' });
      customerState = customer.state ?? null;
    }
    const isInterState = !!(shopState && customerState && normaliseState(shopState) !== normaliseState(customerState));
    return { isInterState, shopState, customerState };
  }

  toMathItem(line: NormalisedLine, products: Map<string, ProductRow>, isInterState: boolean) {
    if (line.custom) {
      return {
        productId: line.key,
        quantity: line.quantity,
        unitPrice: line.custom.unitPrice,
        discountPercent: line.discountPercent,
        gstRateStr: line.custom.gstRate,
        cessRate: '0',
        isInterState,
      };
    }
    const product = products.get(line.productId!)!;
    return {
      productId: line.productId!,
      quantity: line.quantity,
      unitPrice: product.sellingPrice.toString(),
      discountPercent: line.discountPercent,
      gstRateStr: product.gstRate,
      cessRate: product.cessRate.toString(),
      isInterState,
    };
  }

  /** Snapshot persisted on the invoice line: catalogue values or the custom payload. */
  private invoiceItemData(line: NormalisedLine, products: Map<string, ProductRow>, math: InvoiceCalculationResultV1['lines'][number]) {
    const amounts = {
      quantity: qty(math.quantity),
      discountPercent: new Prisma.Decimal(line.discountPercent),
      discountAmount: money(math.discountAmount),
      taxableAmount: money(math.taxableAmount),
      cgstAmount: money(math.cgstAmount),
      sgstAmount: money(math.sgstAmount),
      igstAmount: money(math.igstAmount),
      cessAmount: money(math.cessAmount),
      totalAmount: money(math.lineTotal),
    };
    if (line.custom) {
      return {
        productId: null,
        isCustom: true,
        productName: line.custom.name,
        productSku: CUSTOM_SKU,
        unit: line.custom.unit,
        costPrice: new Prisma.Decimal(0),
        sellingPrice: new Prisma.Decimal(line.custom.unitPrice),
        mrp: new Prisma.Decimal(line.custom.unitPrice),
        gstRate: line.custom.gstRate,
        ...amounts,
      };
    }
    const product = products.get(line.productId!)!;
    return {
      productId: product.id,
      isCustom: false,
      productName: product.name,
      productSku: product.sku,
      unit: product.unit,
      costPrice: product.costPrice,
      sellingPrice: product.sellingPrice,
      mrp: product.mrp,
      gstRate: product.gstRate,
      ...amounts,
    };
  }

  toPaymentInput(payments: PaymentTenderDto[], udharAmount?: number) {
    return {
      tenders: payments.map((p) => ({ type: p.tender as 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER', amount: p.amount, tenderedAmount: p.tenderedAmount, reference: p.reference })),
      udharAmount: new Decimal(udharAmount ?? 0),
    };
  }

  runEngine(input: InvoiceMathInput): InvoiceCalculationResultV1 {
    try {
      return InvoiceMathEngine.calculate(input);
    } catch (e) {
      if (e instanceof InvoiceMathError || (e as { name?: string })?.name === 'InvoiceMathError') {
        throw new BadRequestException({ message: (e as Error).message, code: (e as { code: string }).code });
      }
      throw e;
    }
  }

  /**
   * Discount authority: a CASHIER may discount up to
   * `cashierMaxDiscountPercent` (line or invoice level, percent of the
   * eligible amount); anything above needs a manager to bill the invoice.
   * The billing actor is stamped as `approvedBy` on the invoice.
   */
  enforceDiscountAuthority(actor: BillingActor, lines: NormalisedLine[], math: InvoiceCalculationResultV1): void {
    if (isManager(actor.role)) return;
    const limit = new Decimal(this.billingConfig.cashierMaxDiscountPercent);
    const maxLine = lines.reduce((acc, l) => Decimal.max(acc, new Decimal(l.discountPercent)), new Decimal(0));
    const netSubtotal = math.subtotal.minus(math.totalItemDiscount);
    const invoicePct = netSubtotal.greaterThan(0) ? math.invoiceDiscount.div(netSubtotal).mul(100) : new Decimal(0);
    const requested = Decimal.max(maxLine, invoicePct);
    if (requested.greaterThan(limit)) {
      throw new ForbiddenException({
        message: `Discounts above ${limit.toFixed(2)}% need a manager to bill this invoice.`,
        code: 'DISCOUNT_REQUIRES_APPROVAL',
        details: { maxPercent: limit.toNumber(), requestedPercent: requested.toDecimalPlaces(2).toNumber() },
      });
    }
  }

  private legacyPayments(dto: CreateInvoiceDto): PaymentTenderDto[] {
    const mode = dto.paymentMode ?? 'CASH';
    const paid = dto.amountPaid ?? 0;
    if (mode === 'UDHAR' || paid === 0) return [];
    const tender: TenderType = mode === 'SPLIT' ? 'CASH' : (mode as TenderType);
    return [{ tender, amount: paid }];
  }

  private legacyUdhar(dto: CreateInvoiceDto): number {
    if (dto.paymentMode === 'UDHAR') return dto.udharAmount ?? dto.amountPaid ?? 0;
    return dto.udharAmount ?? 0;
  }

  private hashRequest(payload: { lines: NormalisedLine[]; dto: CreateInvoiceDto; paymentInput: ReturnType<BillingService['toPaymentInput']> }): string {
    const canonical = {
      lines: payload.lines.map((l) => ({ key: l.key, productId: l.productId, custom: l.custom, quantity: l.quantity, discountPercent: l.discountPercent })),
      customerId: payload.dto.customerId ?? null,
      discountAmount: payload.dto.discountAmount ?? null,
      discountPercentage: payload.dto.discountPercentage ?? null,
      discountType: payload.dto.discountType ?? null,
      tenders: payload.paymentInput.tenders.map((t) => ({ type: t.type, amount: Number(t.amount), tendered: t.tenderedAmount ?? null })),
      udhar: payload.paymentInput.udharAmount.toFixed(2),
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * Locks the shift the invoice is booked on. An explicit shiftId must be an
   * OPEN shift of this shop opened by the actor (managers may bill on any
   * open shift of the shop); otherwise the actor's own open shift is used.
   */
  async lockShift(tx: Tx, actor: BillingActor, shiftId?: string | null): Promise<string | null> {
    if (shiftId) {
      const rows = await tx.$queryRaw<Array<{ id: string; openedById: string }>>`
        SELECT id, openedById FROM Shift WHERE id = ${shiftId} AND shopId = ${actor.shopId} AND status = 'OPEN' AND isDeleted = false FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new ConflictException({ message: 'Shift is closed, invalid, or belongs to another shop.', code: 'SHIFT_INVALID' });
      }
      if (rows[0].openedById !== actor.userId && !isManager(actor.role)) {
        throw new ForbiddenException({ message: 'You can only bill on your own open shift.', code: 'SHIFT_FORBIDDEN' });
      }
      return rows[0].id;
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM Shift WHERE shopId = ${actor.shopId} AND openedById = ${actor.userId} AND status = 'OPEN' AND isDeleted = false
      ORDER BY openedAt DESC LIMIT 1 FOR UPDATE
    `;
    return rows[0]?.id ?? null;
  }

  /**
   * Row-locks the customer. Inactive customers cannot be billed or take
   * payments; reversals of their existing invoices pass `allowInactive`.
   */
  async lockCustomer(tx: Tx, shopId: string, customerId: string, options: { allowInactive?: boolean } = {}): Promise<LockedCustomer> {
    const rows = await tx.$queryRaw<Array<{ id: string; name: string; state: string | null; outstandingBalance: unknown; creditLimit: unknown; isActive: number | boolean }>>`
      SELECT id, name, state, outstandingBalance, creditLimit, isActive FROM Customer
      WHERE id = ${customerId} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundException({ message: 'Customer not found.', code: 'CUSTOMER_NOT_FOUND' });
    const row = rows[0];
    const customer: LockedCustomer = {
      id: row.id,
      name: row.name,
      state: row.state,
      outstandingBalance: new Prisma.Decimal(String(row.outstandingBalance)),
      creditLimit: new Prisma.Decimal(String(row.creditLimit)),
      isActive: Boolean(row.isActive),
    };
    if (!customer.isActive && !options.allowInactive) {
      throw new ConflictException({ message: `${customer.name} is inactive and cannot be billed.`, code: 'CUSTOMER_INACTIVE', details: { customerId } });
    }
    return customer;
  }

  tenderBuckets(tenders: ReadonlyArray<{ type: string; amount: Decimal }>) {
    const sum = (types: string[]) => money(tenders.filter((t) => types.includes(t.type)).reduce((a, t) => a.plus(t.amount), new Decimal(0)));
    return { cash: sum(['CASH']), upi: sum(['UPI']), card: sum(['CARD', 'BANK_TRANSFER']), bank: sum(['UPI', 'CARD', 'BANK_TRANSFER']) };
  }

  /**
   * Sale posting: Σ tenders + udhar (debits) = revenue + GST (credits), plus
   * cost of goods for the lines that actually left inventory (SERVICE,
   * DIGITAL and custom lines carry no stock and post no COGS).
   */
  saleLedgerEntries(
    tenders: ReadonlyArray<{ type: string; amount: Decimal }>,
    udhar: Decimal,
    math: InvoiceCalculationResultV1,
    costOfGoods: Decimal,
  ): LedgerEntryInput[] {
    const buckets = this.tenderBuckets(tenders);
    const entries: LedgerEntryInput[] = [
      { account: LedgerAccount.CASH, type: LedgerEntryType.DEBIT, amount: buckets.cash },
      { account: LedgerAccount.BANK, type: LedgerEntryType.DEBIT, amount: buckets.bank },
      { account: LedgerAccount.ACCOUNTS_RECEIVABLE, type: LedgerEntryType.DEBIT, amount: money(udhar) },
      { account: LedgerAccount.SALES_REVENUE, type: LedgerEntryType.CREDIT, amount: money(math.taxableTotal.plus(math.roundOff)) },
      { account: LedgerAccount.GST_PAYABLE, type: LedgerEntryType.CREDIT, amount: money(math.totalTax) },
    ];
    if (costOfGoods.greaterThan(0)) {
      entries.push({ account: LedgerAccount.COST_OF_GOODS, type: LedgerEntryType.DEBIT, amount: money(costOfGoods) });
      entries.push({ account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: money(costOfGoods) });
    }
    return entries;
  }

  insufficientStock(product: ProductRow, requestedQty: number, availableQty: number) {
    return new ConflictException({
      message: `Insufficient stock for "${product.name}": requested ${requestedQty}, available ${availableQty}.`,
      code: 'INSUFFICIENT_STOCK',
      details: { productId: product.id, productName: product.name, requestedQty, availableQty },
    });
  }

  private isIdempotencyRace(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      String((error.meta as { target?: unknown })?.target ?? '').includes('idempotencyKey')
    );
  }

  private async restoreRedis(lines: NormalisedLine[]) {
    for (const line of lines) if (line.productId) await this.inventoryCache.restoreStock(line.productId, line.quantity);
    lines.length = 0;
  }

  private async jitter() {
    const ms = Math.random() * this.billingConfig.jitterDelayRandomMultiplier + this.billingConfig.jitterDelayBaseMs;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function productIds(lines: NormalisedLine[]): string[] {
  return lines.filter((l) => l.productId).map((l) => l.productId!);
}

/** Catalogue lines whose product type carries physical stock. */
function stockedLines(lines: NormalisedLine[], products: Map<string, ProductRow>): NormalisedLine[] {
  return lines.filter((l) => l.productId && STOCKED_TYPES.has(products.get(l.productId)!.type));
}

function normaliseState(state: string): string {
  return state.trim().toLowerCase().replace(/\s+/g, ' ');
}

export { safeTimeZone };
