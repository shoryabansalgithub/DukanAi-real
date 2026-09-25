import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { NotificationType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { TenantContext } from '../../iam/tenant-context/tenant-context.interface';
import { InventoryGateway } from '../../inventory/inventory.gateway';
import {
  asOptionalString,
  LEGACY_CORRELATION_ID,
  parseOutboxPayload,
  SystemEventJobData,
} from './outbox-routing';

import { invalidateAnalyticsCache } from '../cache/analytics-cache-keys';

/** Contract §6: keys the event processor invalidates after any invoice mutation. */
export { analyticsCacheKeys } from '../cache/analytics-cache-keys';

export const SYSTEM_EVENT_PROCESSED_ACTION = 'SYSTEM_EVENT_PROCESSED';

/** OutboxEvent.error is a plain Prisma String, i.e. VARCHAR(191) on MySQL. */
const MAX_ERROR_LENGTH = 191;

/** Prisma codes that mean "try again later", not "this event is broken". */
/** P2024/P2028: pool wait or transaction start timed out under load; P2034: deadlock / write conflict. */
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1011', 'P1017', 'P2024', 'P2028', 'P2034']);

export type SystemEventOutcome = { status: 'processed' | 'skipped-duplicate' | 'ignored-unknown' };

interface LowStockAlert {
  productId: string;
  productName: string;
  currentStock: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isNaN() ? null : decimal;
  } catch {
    return null;
  }
}

function extractProductIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const ids = new Set<string>();
  for (const item of items) {
    const productId = asOptionalString((item as { productId?: unknown } | null)?.productId);
    if (productId) ids.add(productId);
  }
  return [...ids];
}

/**
 * Consumer of the `system-events` queue (POS/billing outbox events, contract §7).
 *
 * Every job runs inside an explicit tenant context built from the top-level
 * `shopId` of the job data (fallback: payload.shopId), because Product,
 * Notification, Customer and AuditLog are tenant-scoped in the Prisma extension.
 */
@Processor('system-events')
export class SystemEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(SystemEventsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly inventoryGateway: InventoryGateway,
  ) {
    super();
  }

  async process(job: Job<SystemEventJobData, unknown, string>): Promise<SystemEventOutcome> {
    const eventId = job.opts.jobId ?? job.data?.eventId;
    if (!eventId) {
      // Without the OutboxEvent id there is no row to mark; the job is dropped loudly.
      this.logger.error(`Job ${String(job.id)} (${job.name}) carries no OutboxEvent id; dropping it.`);
      throw new UnrecoverableError('Job missing jobId (OutboxEvent.id) for idempotency tracking.');
    }

    const payload = parseOutboxPayload(job.data?.payload);
    const shopId = asOptionalString(job.data?.shopId) ?? asOptionalString(payload.shopId);
    if (!shopId) {
      const message = `OutboxEvent ${eventId} (${job.name}) has no shopId at job level or in its payload; tenant context cannot be established.`;
      this.logger.error(message);
      await this.markFailed(eventId, message);
      throw new UnrecoverableError(message);
    }

    const context: TenantContext = {
      shopId,
      userId: asOptionalString(job.data?.userId) ?? asOptionalString(payload.userId),
      correlationId:
        asOptionalString(job.data?.correlationId) ??
        asOptionalString(payload.correlationId) ??
        LEGACY_CORRELATION_ID,
      requestId: randomUUID(),
    };

    try {
      const outcome = await this.tenantContext.runWithContext(context, () =>
        this.handle(job, eventId, shopId, payload, context),
      );
      this.logger.log(`System event ${eventId} (${job.name}) for shop ${shopId}: ${outcome.status}`);
      return outcome;
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof UnrecoverableError || !this.isTransientError(error)) {
        this.logger.error(`Permanent failure on system event ${eventId} (${job.name}): ${message}`);
        await this.markFailed(eventId, message);
        throw error instanceof UnrecoverableError ? error : new UnrecoverableError(`Permanent failure: ${message}`);
      }
      // The relay marks the row DONE at enqueue time, so this catch block is the
      // only place a processing failure can be recorded. Once BullMQ has no
      // retries left nothing else runs, so the final attempt must mark the row
      // FAILED here or the event is lost behind a DONE status.
      const maxAttempts = job.opts.attempts ?? 1;
      const attempt = job.attemptsMade + 1;
      if (attempt >= maxAttempts) {
        this.logger.error(
          `System event ${eventId} (${job.name}) exhausted ${maxAttempts} attempt(s); marking FAILED: ${message}`,
        );
        await this.markFailed(eventId, message);
        throw error;
      }
      this.logger.warn(`Transient failure on system event ${eventId} (${job.name}), attempt ${attempt}: ${message}`);
      await this.incrementRetryCount(eventId);
      throw error;
    }
  }

  private async handle(
    job: Job<SystemEventJobData, unknown, string>,
    eventId: string,
    shopId: string,
    payload: Record<string, unknown>,
    context: TenantContext,
  ): Promise<SystemEventOutcome> {
    const lowStockAlerts: LowStockAlert[] = [];

    const outcome = await this.prisma.$transaction(async (tx): Promise<SystemEventOutcome> => {
      // Idempotency guard. AuditLog has no unique index over (entity, entityId,
      // action), so this is a check-then-insert rather than an insert guarded by
      // P2002. It is safe because (1) BullMQ runs a given jobId (= OutboxEvent.id)
      // on at most one worker at a time, so two workers never race on the same
      // event, and (2) the check and the marker share this transaction with the
      // side effects: a retry after a rollback finds no marker and re-runs, a
      // retry after a commit finds the marker and skips.
      const alreadyProcessed = await tx.auditLog.findFirst({
        where: { shopId, entity: 'OutboxEvent', entityId: eventId, action: SYSTEM_EVENT_PROCESSED_ACTION },
        select: { id: true },
      });
      if (alreadyProcessed) {
        this.logger.warn(`Idempotency hit: event ${eventId} (${job.name}) was already handled; skipping.`);
        return { status: 'skipped-duplicate' };
      }

      let status: SystemEventOutcome['status'] = 'processed';
      switch (job.name) {
        case 'INVOICE_CREATED':
          await this.handleInvoiceMutation(shopId, payload, job.name);
          lowStockAlerts.push(...(await this.raiseLowStockNotifications(tx, shopId, payload)));
          break;
        case 'INVOICE_RETURNED':
        case 'INVOICE_CANCELLED':
          await this.handleInvoiceMutation(shopId, payload, job.name);
          break;
        case 'CUSTOMER_PAYMENT_RECORDED':
          await this.handleCustomerPaymentRecorded(tx, shopId, payload);
          break;
        case 'BILL_SCANNED':
          this.handleBillScanned(payload);
          break;
        default:
          this.logger.warn(`Unknown job name ${job.name} for event ${eventId}; marking as processed so it is not retried.`);
          status = 'ignored-unknown';
      }

      await tx.auditLog.create({
        data: {
          shopId,
          userId: await this.resolveActorId(tx, shopId, context.userId),
          action: SYSTEM_EVENT_PROCESSED_ACTION,
          entity: 'OutboxEvent',
          entityId: eventId,
          afterData: payload as unknown as Prisma.InputJsonObject,
        },
      });

      return { status };
    }, { maxWait: 30_000, timeout: 60_000 });

    // Post-commit, best-effort: the marker is committed, so a socket failure must not fail the job.
    for (const alert of lowStockAlerts) {
      try {
        this.inventoryGateway.broadcastLowStockAlert(alert);
      } catch (error) {
        this.logger.warn(`Could not broadcast low-stock alert for product ${alert.productId}: ${errorMessage(error)}`);
      }
    }

    return outcome;
  }

  /**
   * Ledger, stock, udhar and shift were written atomically in the billing
   * transaction; this worker only owns secondary effects. Cache invalidation
   * runs inside the job transaction on purpose: if the cache is unreachable the
   * job rolls back and BullMQ retries instead of committing the idempotency
   * marker next to a stale dashboard.
   */
  private async handleInvoiceMutation(
    shopId: string,
    payload: Record<string, unknown>,
    eventType: string,
  ): Promise<void> {
    const invoiceId = asOptionalString(payload.invoiceId);
    if (!invoiceId) {
      throw new UnrecoverableError(`Invalid payload for ${eventType}: invoiceId is missing`);
    }
    await this.invalidateAnalyticsCache(shopId);
    this.logger.debug(`${eventType} for invoice ${invoiceId}: analytics cache invalidated for shop ${shopId}`);
  }

  private async invalidateAnalyticsCache(shopId: string): Promise<void> {
    await invalidateAnalyticsCache(this.cache, shopId);
  }

  /** One unread LOW_STOCK notification per product; re-raised only after the previous one was read. */
  private async raiseLowStockNotifications(
    tx: Prisma.TransactionClient,
    shopId: string,
    payload: Record<string, unknown>,
  ): Promise<LowStockAlert[]> {
    const invoiceId = asOptionalString(payload.invoiceId) ?? null;
    const alerts: LowStockAlert[] = [];

    for (const productId of extractProductIds(payload.items)) {
      const product = await tx.product.findFirst({
        where: { id: productId, shopId, isDeleted: false },
        select: { id: true, name: true, currentStock: true, reorderPoint: true, isDeleted: true },
      });
      if (!product) {
        this.logger.warn(`Product ${productId} from invoice ${invoiceId} not found in shop ${shopId}; skipping low-stock check.`);
        continue;
      }
      if (product.currentStock.gt(product.reorderPoint)) continue;

      const existing = await tx.notification.findFirst({
        where: { shopId, type: NotificationType.LOW_STOCK, entityId: productId, isRead: false, isDeleted: false },
        select: { id: true },
      });
      if (existing) {
        this.logger.debug(`Unread LOW_STOCK notification ${existing.id} already exists for product ${productId}; not duplicating.`);
        continue;
      }

      await tx.notification.create({
        data: {
          shopId,
          type: NotificationType.LOW_STOCK,
          title: 'Low Stock Alert',
          message: `${product.name} is low on stock: ${product.currentStock.toString()} left (reorder point ${product.reorderPoint.toString()}).`,
          entityId: productId,
          metadata: {
            productId,
            currentStock: product.currentStock.toString(),
            reorderPoint: product.reorderPoint.toString(),
            invoiceId,
          },
        },
      });
      alerts.push({ productId, productName: product.name, currentStock: product.currentStock.toNumber() });
    }

    return alerts;
  }

  private async handleCustomerPaymentRecorded(
    tx: Prisma.TransactionClient,
    shopId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const customerId = asOptionalString(payload.customerId);
    const amount = toDecimal(payload.amount);
    if (!customerId || !amount) {
      throw new UnrecoverableError('Invalid payload for CUSTOMER_PAYMENT_RECORDED: customerId or amount is missing');
    }

    const customer = await tx.customer.findFirst({ where: { id: customerId, shopId }, select: { name: true } });
    if (!customer) {
      this.logger.warn(`Customer ${customerId} not found in shop ${shopId}; recording payment notification without a name.`);
    }
    const customerName = customer?.name ?? 'customer';
    const tender = asOptionalString(payload.tender);

    await tx.notification.create({
      data: {
        shopId,
        type: NotificationType.PAYMENT_RECEIVED,
        title: 'Payment received',
        message: `Received ₹${amount.toFixed(2)} from ${customerName}${tender ? ` via ${tender}` : ''}.`,
        entityId: customerId,
        metadata: {
          customerId,
          transactionId: asOptionalString(payload.transactionId) ?? null,
          amount: amount.toFixed(2),
          tender: tender ?? null,
        },
      },
    });

    // outstandingUdhar is part of the dashboard summary (contract §6).
    await this.invalidateAnalyticsCache(shopId);
  }

  private handleBillScanned(payload: Record<string, unknown>): void {
    const billId = asOptionalString(payload.billId);
    const fileUrl = asOptionalString(payload.fileUrl);
    if (!billId || !fileUrl) {
      throw new UnrecoverableError('Invalid payload for BILL_SCANNED: billId or fileUrl is missing');
    }
    this.logger.log(`Dispatching OCR job for bill ${billId} with url ${fileUrl}`);
  }

  /**
   * AuditLog.userId is a FK to User. Contract §7 guarantees userId on every
   * payload; legacy rows may lack it, in which case the shop owner is used for
   * the marker. No id is ever invented.
   */
  private async resolveActorId(tx: Prisma.TransactionClient, shopId: string, userId?: string): Promise<string> {
    if (userId) return userId;
    const shop = await tx.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } });
    if (!shop?.ownerId) {
      throw new UnrecoverableError(`Cannot record idempotency marker for shop ${shopId}: event has no userId and the shop has no owner`);
    }
    this.logger.warn(`Event has no userId; recording idempotency marker as shop ${shopId} owner ${shop.ownerId}`);
    return shop.ownerId;
  }

  /** OutboxEvent is not tenant-scoped; updates run by id outside any tenant context. */
  private async markFailed(eventId: string, message: string): Promise<void> {
    try {
      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId },
        data: { status: 'FAILED', error: message.slice(0, MAX_ERROR_LENGTH), retryCount: { increment: 1 } },
      });
    } catch (error) {
      this.logger.error(`Could not mark OutboxEvent ${eventId} FAILED: ${errorMessage(error)}`);
    }
  }

  private async incrementRetryCount(eventId: string): Promise<void> {
    try {
      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId },
        data: { retryCount: { increment: 1 } },
      });
    } catch (error) {
      this.logger.error(`Could not increment retryCount of OutboxEvent ${eventId}: ${errorMessage(error)}`);
    }
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof UnrecoverableError) return false;
    if (
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientRustPanicError
    ) {
      return true;
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && TRANSIENT_PRISMA_CODES.has(code)) return true;

    const message = errorMessage(error).toLowerCase();
    return (
      message.includes('deadlock') ||
      message.includes('unable to start a transaction') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('connection') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('enableofflinequeue')
    );
  }
}
