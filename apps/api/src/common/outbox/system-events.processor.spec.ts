import { UnrecoverableError } from 'bullmq';
import { NotificationType, Prisma } from '@prisma/client';
import { SystemEventsProcessor, analyticsCacheKeys } from './system-events.processor';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

type AnyFn = (...args: any[]) => any;

/** `attempts` mirrors the retry policy the `system-events` queue is registered with. */
function makeJob(
  name: string,
  data: Record<string, unknown>,
  jobId: string | undefined = 'evt-1',
  attemptsMade = 0,
  attempts = 3,
) {
  return { id: jobId ?? 'bull-job-1', name, opts: { jobId, attempts }, data, attemptsMade } as any;
}

describe('SystemEventsProcessor', () => {
  const tx = {
    auditLog: { findFirst: jest.fn(), create: jest.fn() },
    product: { findFirst: jest.fn() },
    notification: { findFirst: jest.fn(), create: jest.fn() },
    customer: { findFirst: jest.fn() },
    shop: { findUnique: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    outboxEvent: { updateMany: jest.fn() },
  };
  const cache = { del: jest.fn() };
  const gateway = { broadcastLowStockAlert: jest.fn() };
  const tenantContext = new TenantContextService();
  let processor: SystemEventsProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn: AnyFn) => fn(tx));
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    cache.del.mockResolvedValue(true);
    tx.auditLog.findFirst.mockResolvedValue(null);
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    tx.notification.findFirst.mockResolvedValue(null);
    tx.notification.create.mockResolvedValue({ id: 'notif-1' });
    tx.shop.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
    processor = new SystemEventsProcessor(prisma as any, tenantContext, cache as any, gateway as any);
  });

  const invoiceCreated = (overrides: Record<string, unknown> = {}) =>
    makeJob('INVOICE_CREATED', {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      shopId: 'shop-1',
      userId: 'user-1',
      payload: {
        eventId: 'evt-1',
        correlationId: 'corr-1',
        shopId: 'shop-1',
        userId: 'user-1',
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-0001',
        type: 'SALE',
        items: [{ productId: 'prod-1', quantity: 2, balanceAfter: 3 }],
      },
      ...overrides,
    });

  it('marks the OutboxEvent FAILED and fails unrecoverably when shopId is missing everywhere', async () => {
    const job = makeJob('INVOICE_CREATED', {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      payload: { invoiceId: 'inv-1', items: [] },
    });

    await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('no shopId'), retryCount: { increment: 1 } }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('falls back to payload.shopId when the job-level shopId is absent', async () => {
    tx.product.findFirst.mockResolvedValue(null);
    const job = makeJob('INVOICE_RETURNED', {
      eventId: 'evt-9',
      correlationId: 'corr-9',
      payload: { shopId: 'shop-9', userId: 'user-9', invoiceId: 'inv-9', items: [] },
    });

    await expect(processor.process(job)).resolves.toEqual({ status: 'processed' });
    expect(cache.del.mock.calls.map((c) => c[0])).toEqual(analyticsCacheKeys('shop-9'));
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('INVOICE_CREATED with a low-stock product creates one LOW_STOCK notification, invalidates the three cache keys and broadcasts', async () => {
    let shopIdSeenInsideTransaction: string | undefined;
    tx.product.findFirst.mockImplementation(async () => {
      shopIdSeenInsideTransaction = tenantContext.getShopId();
      return {
        id: 'prod-1',
        name: 'Basmati Rice 5kg',
        currentStock: new Prisma.Decimal('3'),
        reorderPoint: new Prisma.Decimal('10'),
        isDeleted: false,
      };
    });

    await expect(processor.process(invoiceCreated())).resolves.toEqual({ status: 'processed' });

    expect(shopIdSeenInsideTransaction).toBe('shop-1');

    expect(cache.del).toHaveBeenCalledTimes(3);
    expect(cache.del.mock.calls.map((c) => c[0])).toEqual([
      'shop:shop-1:analytics:dashboard',
      'shop:shop-1:analytics:kpis',
      'shop:shop-1:analytics:summary',
    ]);

    expect(tx.notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shopId: 'shop-1', type: NotificationType.LOW_STOCK, entityId: 'prod-1', isRead: false }),
      }),
    );
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: 'shop-1',
        type: NotificationType.LOW_STOCK,
        title: 'Low Stock Alert',
        entityId: 'prod-1',
        message: expect.stringContaining('Basmati Rice 5kg'),
      }),
    });

    expect(gateway.broadcastLowStockAlert).toHaveBeenCalledTimes(1);
    expect(gateway.broadcastLowStockAlert).toHaveBeenCalledWith({ productId: 'prod-1', productName: 'Basmati Rice 5kg', currentStock: 3 });

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: 'shop-1',
        userId: 'user-1',
        action: 'SYSTEM_EVENT_PROCESSED',
        entity: 'OutboxEvent',
        entityId: 'evt-1',
      }),
    });
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('does not duplicate an unread LOW_STOCK notification and does not notify above the reorder point', async () => {
    tx.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      name: 'Sugar 1kg',
      currentStock: new Prisma.Decimal('1'),
      reorderPoint: new Prisma.Decimal('5'),
      isDeleted: false,
    });
    tx.notification.findFirst.mockResolvedValue({ id: 'notif-existing' });

    await processor.process(invoiceCreated());
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(gateway.broadcastLowStockAlert).not.toHaveBeenCalled();

    jest.clearAllMocks();
    tx.auditLog.findFirst.mockResolvedValue(null);
    tx.notification.findFirst.mockResolvedValue(null);
    tx.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      name: 'Sugar 1kg',
      currentStock: new Prisma.Decimal('50'),
      reorderPoint: new Prisma.Decimal('5'),
      isDeleted: false,
    });

    await processor.process(invoiceCreated());
    expect(tx.notification.findFirst).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('skips already-processed events without touching the cache or notifications', async () => {
    tx.auditLog.findFirst.mockResolvedValue({ id: 'audit-existing' });

    await expect(processor.process(invoiceCreated())).resolves.toEqual({ status: 'skipped-duplicate' });

    expect(cache.del).not.toHaveBeenCalled();
    expect(tx.product.findFirst).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('CUSTOMER_PAYMENT_RECORDED creates a PAYMENT_RECEIVED notification with amount and customer name', async () => {
    tx.customer.findFirst.mockResolvedValue({ name: 'Ramesh Kumar' });
    const job = makeJob('CUSTOMER_PAYMENT_RECORDED', {
      eventId: 'evt-2',
      correlationId: 'corr-2',
      shopId: 'shop-1',
      userId: 'user-1',
      payload: { customerId: 'cust-1', transactionId: 'udhar-1', amount: '250.50', tender: 'CASH' },
    }, 'evt-2');

    await expect(processor.process(job)).resolves.toEqual({ status: 'processed' });

    expect(tx.customer.findFirst).toHaveBeenCalledWith({ where: { id: 'cust-1', shopId: 'shop-1' }, select: { name: true } });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: 'shop-1',
        type: NotificationType.PAYMENT_RECEIVED,
        title: 'Payment received',
        entityId: 'cust-1',
        message: expect.stringContaining('250.50'),
      }),
    });
    expect(tx.notification.create.mock.calls[0][0].data.message).toContain('Ramesh Kumar');
    expect(cache.del).toHaveBeenCalledTimes(3);
  });

  it('marks unknown job names processed without side effects', async () => {
    const job = makeJob('SOMETHING_ELSE', { eventId: 'evt-3', shopId: 'shop-1', userId: 'user-1', payload: {} }, 'evt-3');
    await expect(processor.process(job)).resolves.toEqual({ status: 'ignored-unknown' });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('marks the row FAILED on a permanent error and only bumps retryCount on a transient one', async () => {
    const invalid = makeJob('INVOICE_CREATED', { eventId: 'evt-4', shopId: 'shop-1', userId: 'user-1', payload: { items: [] } }, 'evt-4');
    await expect(processor.process(invalid)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-4' },
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('invoiceId'), retryCount: { increment: 1 } }),
    });

    jest.clearAllMocks();
    prisma.$transaction.mockRejectedValue(new Error('Connection reset by peer'));

    await expect(processor.process(invoiceCreated())).rejects.toThrow('Connection reset by peer');
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: { retryCount: { increment: 1 } },
    });
  });

  it('marks the row FAILED when a transient error exhausts the last attempt', async () => {
    // The relay sets the row DONE at enqueue time, so if the final attempt only
    // bumped retryCount the event would be lost behind a DONE status.
    prisma.$transaction.mockRejectedValue(new Error('Connection reset by peer'));
    const lastAttempt = makeJob(
      'INVOICE_CREATED',
      { eventId: 'evt-1', shopId: 'shop-1', userId: 'user-1', payload: { invoiceId: 'inv-1', shopId: 'shop-1', items: [] } },
      'evt-1',
      2,
      3,
    );

    await expect(processor.process(lastAttempt)).rejects.toThrow('Connection reset by peer');
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: expect.objectContaining({ status: 'FAILED', retryCount: { increment: 1 } }),
    });
  });
});
