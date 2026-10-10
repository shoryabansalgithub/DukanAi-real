import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { rethrowUniqueViolation } from '../common/db/unique-violation';
import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CustomerRepository } from './repositories/customer.repository';
import { CustomerAuditService } from './services/customer-audit.service';
import { CreateEnterpriseCustomerDto } from './dto/enterprise-customer.dto';
import { CreateCustomerDto, PaginationDto, RecordPaymentDto, UpdateCustomerDto } from './dto/create-customer.dto';
import { CustomerType, CustomerLifecycleStatus, KycStatus } from './domain/enums';
import { SalesFeatureConfig } from '../config/domains/features/sales-feature.config';
import { LedgerPostingService } from '../ledger/ledger-posting.service';
import { BillingHelpers } from '../billing/billing.helpers';
import { Clock } from '../common/time/clock';
import { BillingActor, isManager, money } from '../billing/billing.types';
import { BillingCheckpoints } from '../billing/billing-checkpoints';
import { withSerializationRetry } from '../common/db/serialization-retry';

type CreateInput = CreateCustomerDto & Partial<CreateEnterpriseCustomerDto>;

/** The idempotency key of a customer's one opening-udhar row (roadmap 9.20). */
export function openingBalanceKey(customerId: string): string {
  return `OPENING:${customerId}`;
}

/** Largest balance a `Decimal(10, 2)` udhar column holds. */
const MAX_OPENING_BALANCE = new Prisma.Decimal('99999999.99');

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly customerRepository: CustomerRepository,
    private readonly auditService: CustomerAuditService,
    private readonly salesFeatureConfig: SalesFeatureConfig,
    private readonly ledger: LedgerPostingService,
    private readonly billingHelpers: BillingHelpers,
    private readonly checkpoints: BillingCheckpoints,
    private readonly clock: Clock,
  ) {}

  async create(data: CreateInput, actor?: Pick<BillingActor, 'userId' | 'ipAddress' | 'role'>) {
    const shopId = this.tenantContext.getShopId();
    this.assertCreditLimitAuthority(data.creditLimit, actor);

    const duplicate = await this.prisma.customer.findFirst({ where: { shopId, phone: data.phone, isDeleted: false }, select: { id: true } });
    if (duplicate) {
      throw new ConflictException({ message: 'A customer with this phone number already exists.', code: 'CUSTOMER_PHONE_IN_USE', details: { customerId: duplicate.id } });
    }

    try {
      // The customer and its audit row commit together (audit P2-4): a crash
      // between them cannot leave a customer without its CREATED entry.
      return await this.prisma.$transaction(async (tx) => {
        const newCustomer = await this.customerRepository.create(
          {
            name: data.name,
            phone: data.phone,
            // Scalar shopId (not shop.connect): the tenant Prisma extension injects
            // shopId for tenant-owned models, and Prisma rejects both a relation
            // connect and the scalar FK in the same create.
            shopId,
            email: data.email || null,
            address: data.address || null,
            city: data.city || null,
            state: data.state || null,
            notes: data.notes || null,
            creditLimit: money(data.creditLimit ?? this.salesFeatureConfig.defaultCreditLimit),
            outstandingBalance: 0,
            type: data.type || CustomerType.RETAIL,
            lifecycleStatus: data.lifecycleStatus || CustomerLifecycleStatus.LEAD,
            kycStatus: KycStatus.PENDING,
            profile: data.profile ? { create: data.profile } : undefined,
            addresses: data.addresses?.length ? { create: data.addresses } : undefined,
            contacts: data.contacts?.length ? { create: data.contacts } : undefined,
          },
          tx,
        );
        await this.auditService.logAction({ customerId: newCustomer.id, actorId: actor?.userId, ipAddress: actor?.ipAddress, action: 'CUSTOMER_CREATED', newPayload: newCustomer }, tx);
        return newCustomer;
      });
    } catch (error) {
      rethrowUniqueViolation(error, [{ index: 'Customer_shopId_phone', code: 'CUSTOMER_PHONE_IN_USE', message: 'A customer with this phone number already exists.' }]);
    }
  }

  async findAll(options: { q?: string; skip?: number; take?: number }) {
    const shopId = this.tenantContext.getShopId();
    return this.customerRepository.findAll(shopId, options);
  }

  async findOne(id: string) {
    const shopId = this.tenantContext.getShopId();
    const customer = await this.customerRepository.findById(id, shopId);
    if (!customer) throw new NotFoundException({ message: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto, actor?: Pick<BillingActor, 'userId' | 'ipAddress' | 'role'>) {
    const shopId = this.tenantContext.getShopId();
    this.assertCreditLimitAuthority(dto.creditLimit, actor);
    const before = await this.prisma.customer.findFirst({ where: { id, shopId, isDeleted: false } });
    if (!before) throw new NotFoundException({ message: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });

    if (dto.phone && dto.phone !== before.phone) {
      const duplicate = await this.prisma.customer.findFirst({ where: { shopId, phone: dto.phone, isDeleted: false, id: { not: id } }, select: { id: true } });
      if (duplicate) throw new ConflictException({ message: 'A customer with this phone number already exists.', code: 'CUSTOMER_PHONE_IN_USE' });
    }

    const data: Prisma.CustomerUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email || null;
    if (dto.address !== undefined) data.address = dto.address || null;
    if (dto.city !== undefined) data.city = dto.city || null;
    if (dto.state !== undefined) data.state = dto.state || null;
    if (dto.notes !== undefined) data.notes = dto.notes || null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.creditLimit !== undefined) data.creditLimit = money(dto.creditLimit);

    let updated: Awaited<ReturnType<CustomerRepository['update']>>;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.customer.update({ where: { id, shopId }, data });
        // A credit-limit change is an authorisation event (roadmap 3.4, audit
        // P1-11): it gets an AuditLog row in the same transaction as the change.
        if (dto.creditLimit !== undefined && !before.creditLimit.equals(row.creditLimit) && actor?.userId) {
          await tx.auditLog.create({
            data: {
              shopId,
              userId: actor.userId,
              action: 'CUSTOMER_CREDIT_LIMIT_CHANGED',
              entity: 'Customer',
              entityId: id,
              ipAddress: actor.ipAddress ?? null,
              beforeData: { creditLimit: before.creditLimit.toFixed(2) },
              afterData: { creditLimit: row.creditLimit.toFixed(2) },
            },
          });
        }
        return row;
      });
    } catch (error) {
      rethrowUniqueViolation(error, [{ index: 'Customer_shopId_phone', code: 'CUSTOMER_PHONE_IN_USE', message: 'A customer with this phone number already exists.' }]);
    }
    await this.auditService.logAction({
      customerId: id,
      actorId: actor?.userId,
      ipAddress: actor?.ipAddress,
      action: dto.creditLimit !== undefined && !before.creditLimit.equals(updated.creditLimit) ? 'CUSTOMER_CREDIT_LIMIT_CHANGED' : 'CUSTOMER_UPDATED',
      previousPayload: { name: before.name, phone: before.phone, state: before.state, creditLimit: before.creditLimit.toFixed(2), isActive: before.isActive },
      newPayload: { name: updated.name, phone: updated.phone, state: updated.state, creditLimit: updated.creditLimit.toFixed(2), isActive: updated.isActive },
    });
    return updated;
  }

  async ledgerEntries(id: string, query: PaginationDto) {
    const shopId = this.tenantContext.getShopId();
    await this.findOne(id);
    const take = query.take ?? 25;
    const skip = query.skip ?? 0;
    const where: Prisma.UdharTransactionWhereInput = { shopId, customerId: id };
    const [items, total] = await Promise.all([
      this.prisma.udharTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true, type: true, amount: true, balanceBefore: true, balanceAfter: true, tender: true, reference: true, notes: true, createdAt: true,
          invoice: { select: { id: true, invoiceNumber: true, type: true } },
          recordedBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.udharTransaction.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async invoices(id: string, query: PaginationDto) {
    const shopId = this.tenantContext.getShopId();
    await this.findOne(id);
    const take = query.take ?? 25;
    const skip = query.skip ?? 0;
    const where: Prisma.InvoiceWhereInput = { shopId, customerId: id, isDeleted: false };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: { id: true, invoiceNumber: true, type: true, status: true, totalAmount: true, paidAmount: true, udharAmount: true, paymentMode: true, createdAt: true, _count: { select: { items: true } } },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { items: items.map((i) => ({ ...i, itemCount: i._count.items })), total, skip, take };
  }

  /**
   * Records an udhaar repayment atomically: customer row lock, balance
   * decrement, UdharTransaction, ledger posting (CASH/BANK vs receivable),
   * shift receipts for cash, audit and outbox event. Idempotent per
   * (shop, idempotencyKey).
   */
  async recordPayment(id: string, dto: RecordPaymentDto, actor: BillingActor) {
    const amount = money(dto.amount);
    if (!amount.greaterThan(0)) throw new BadRequestException({ message: 'Payment amount must be positive.', code: 'INVALID_AMOUNT' });
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ id, amount: amount.toFixed(2), tender: dto.tender })).digest('hex');

    const replay = await this.replayPayment(id, dto, amount, actor);
    if (replay) return replay;

    const result = await withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      // Canonical lock order (shared with sales and returns): Shift, then Customer.
      const shiftRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM Shift WHERE shopId = ${actor.shopId} AND openedById = ${actor.userId} AND status = 'OPEN' AND isDeleted = false ORDER BY openedAt DESC LIMIT 1 FOR UPDATE
      `;
      const shiftId = shiftRows[0]?.id ?? null;
      const now = this.clock.now();

      const rows = await tx.$queryRaw<Array<{ id: string; name: string; outstandingBalance: unknown; isActive: number | boolean }>>`
        SELECT id, name, outstandingBalance, isActive FROM Customer WHERE id = ${id} AND shopId = ${actor.shopId} AND isDeleted = false FOR UPDATE
      `;
      if (rows.length === 0) throw new NotFoundException({ message: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
      if (!rows[0].isActive) throw new ConflictException({ message: `${rows[0].name} is inactive; reactivate the customer before recording a payment.`, code: 'CUSTOMER_INACTIVE' });
      const before = new Prisma.Decimal(String(rows[0].outstandingBalance));

      if (amount.greaterThan(before) && !dto.allowAdvance) {
        throw new ConflictException({
          message: `Payment exceeds the outstanding balance of ${before.toFixed(2)}.`,
          code: 'PAYMENT_EXCEEDS_OUTSTANDING',
          details: { outstandingBalance: before.toNumber(), amount: amount.toNumber() },
        });
      }
      const after = before.minus(amount);

      await this.checkpoints.reach('BEFORE_PAYMENT', 'REPAYMENT');
      const transaction = await tx.udharTransaction.create({
        data: {
          shopId: actor.shopId,
          customerId: id,
          type: 'PAYMENT',
          amount,
          balanceBefore: before,
          balanceAfter: after,
          tender: dto.tender,
          reference: dto.reference ?? null,
          idempotencyKey: dto.idempotencyKey,
          notes: dto.notes ?? null,
          recordedById: actor.userId,
          // The drawer that took the money (roadmap 9.5): the reconciliation
          // rebuilds every shift's receipts and cash from its documents.
          shiftId,
          createdAt: now,
        },
      });

      await this.checkpoints.reach('BEFORE_CUSTOMER', 'REPAYMENT');
      const customer = await tx.customer.update({
        where: { id, shopId: actor.shopId },
        data: { outstandingBalance: after, totalPaid: { increment: amount }, lastPaymentAt: now },
      });
      await this.checkpoints.reach('AFTER_CUSTOMER', 'REPAYMENT');

      await this.checkpoints.reach('BEFORE_SHIFT', 'REPAYMENT');
      if (shiftId) {
        await tx.shift.update({
          where: { id: shiftId },
          data: {
            totalReceipts: { increment: amount },
            ...(dto.tender === 'CASH' ? { expectedCash: { increment: amount } } : {}),
          },
        });
      }

      await this.checkpoints.reach('BEFORE_LEDGER', 'REPAYMENT');
      await this.ledger.post(tx, {
        shopId: actor.shopId,
        source: { type: 'CUSTOMER_PAYMENT', id: transaction.id },
        description: `Customer payment ${rows[0].name} (${dto.tender})`,
        entries: [
          { account: dto.tender === 'CASH' ? LedgerAccount.CASH : LedgerAccount.BANK, type: LedgerEntryType.DEBIT, amount },
          { account: LedgerAccount.ACCOUNTS_RECEIVABLE, type: LedgerEntryType.CREDIT, amount },
        ],
      });

      await this.checkpoints.reach('AFTER_LEDGER', 'REPAYMENT');

      await this.checkpoints.reach('BEFORE_AUDIT', 'REPAYMENT');
      await tx.auditLog.create({
        data: {
          shopId: actor.shopId,
          userId: actor.userId,
          action: 'CUSTOMER_PAYMENT_RECORDED',
          entity: 'Customer',
          entityId: id,
          ipAddress: actor.ipAddress ?? null,
          beforeData: { outstandingBalance: before.toFixed(2) },
          afterData: { outstandingBalance: after.toFixed(2), amount: amount.toFixed(2), tender: dto.tender, reference: dto.reference ?? null, transactionId: transaction.id, shiftId, requestHash },
        },
      });
      await tx.customerAudit.create({
        data: {
          customerId: id,
          actorId: actor.userId,
          action: 'CUSTOMER_PAYMENT_RECORDED',
          ipAddress: actor.ipAddress ?? null,
          previousPayload: { outstandingBalance: before.toFixed(2) },
          newPayload: { outstandingBalance: after.toFixed(2), amount: amount.toFixed(2), tender: dto.tender },
        },
      });

      await this.checkpoints.reach('EVENT_STAGING', 'REPAYMENT');
      await this.billingHelpers.stageEvent(tx, actor, 'CUSTOMER_PAYMENT_RECORDED', id, {
        customerId: id,
        transactionId: transaction.id,
        amount: amount.toNumber(),
        tender: dto.tender,
      });

      await this.checkpoints.reach('BEFORE_COMMIT', 'REPAYMENT');
      return { customer, transaction };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })).catch(async (error) => {
      // The replay pre-check runs outside this transaction, so two concurrent
      // requests carrying the same key both pass it and serialize on the
      // customer lock; the loser hits the unique (shopId, idempotencyKey)
      // constraint here. Resolve it as the replay it is instead of a 500.
      // BillingService.createInvoice handles the same race the same way.
      if (!this.isIdempotencyRace(error)) throw error;
      const replayed = await this.replayPayment(id, dto, amount, actor);
      if (!replayed) throw error;
      return replayed;
    });

    return 'replayed' in result ? result : { ...result, replayed: false };
  }

  /**
   * Returns the stored result for an already-used idempotency key, or null when
   * the key is new. Rejects a key reused for different payment details.
   */
  private async replayPayment(id: string, dto: RecordPaymentDto, amount: Prisma.Decimal, actor: BillingActor) {
    const existing = await this.prisma.udharTransaction.findFirst({
      where: { shopId: actor.shopId, idempotencyKey: dto.idempotencyKey },
    });
    if (!existing) return null;
    if (existing.customerId !== id || !existing.amount.equals(amount) || existing.tender !== dto.tender) {
      throw new UnprocessableEntityException({ message: 'This idempotency key was already used for a different payment.', code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    const customer = await this.findOne(id);
    return { customer, transaction: existing, replayed: true as const };
  }

  private isIdempotencyRace(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      String((error.meta as { target?: unknown })?.target ?? '').includes('idempotencyKey')
    );
  }

  /**
   * The opening udhar of a customer (roadmap 9.20): what the customer owed
   * the shop (positive) or had paid in advance (negative) on the day the shop
   * started on DukaanAI. One ADJUSTMENT UdharTransaction keyed
   * `OPENING:<customerId>` (reference "Opening balance") moves the balance
   * from 0, and one OPENING_BALANCE posting carries it into the books: DR
   * ACCOUNTS_RECEIVABLE / CR OPENING_BALANCE_EQUITY, the other way round for
   * an advance. Once per customer: the same amount again is UNCHANGED,
   * another amount is 409 OPENING_BALANCE_EXISTS, and a customer whose udhar
   * already moved (a credit sale, a repayment, a balance from before) is 409
   * OPENING_BALANCE_AFTER_ACTIVITY: the difference is a repayment or a
   * credit sale, not an opening. MANAGER and above, like a credit limit.
   */
  async recordOpeningBalance(
    id: string,
    amount: number,
    actor: Pick<BillingActor, 'shopId' | 'userId' | 'role' | 'ipAddress'>,
    note?: string,
  ): Promise<{ status: 'CREATED' | 'UNCHANGED'; transactionId: string; outstandingBalance: Prisma.Decimal }> {
    if (!isManager(actor.role)) {
      throw new ForbiddenException({ message: 'Only a manager can record an opening balance.', code: 'OPENING_BALANCE_REQUIRES_MANAGER' });
    }
    if (!Number.isFinite(amount)) throw new BadRequestException({ message: 'The opening balance must be an amount in rupees.', code: 'INVALID_AMOUNT' });
    const value = money(amount);
    if (value.isZero()) throw new BadRequestException({ message: 'An opening balance of 0 needs no entry.', code: 'INVALID_AMOUNT' });
    if (value.abs().greaterThan(MAX_OPENING_BALANCE)) {
      throw new BadRequestException({ message: `An opening balance must not exceed ${MAX_OPENING_BALANCE.toFixed(2)}.`, code: 'INVALID_AMOUNT' });
    }
    const key = openingBalanceKey(id);

    return withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      // Same row lock as every credit sale and repayment of the customer.
      const rows = await tx.$queryRaw<Array<{ id: string; name: string; outstandingBalance: unknown }>>`
        SELECT id, name, outstandingBalance FROM Customer WHERE id = ${id} AND shopId = ${actor.shopId} AND isDeleted = false FOR UPDATE
      `;
      if (rows.length === 0) throw new NotFoundException({ message: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
      const { name } = rows[0];
      const balance = new Prisma.Decimal(String(rows[0].outstandingBalance));

      const recorded = await tx.udharTransaction.findFirst({ where: { shopId: actor.shopId, idempotencyKey: key } });
      if (recorded) {
        const recordedAmount = recorded.balanceAfter.minus(recorded.balanceBefore);
        if (recordedAmount.equals(value)) return { status: 'UNCHANGED' as const, transactionId: recorded.id, outstandingBalance: balance };
        throw new ConflictException({
          message: `The opening balance of ${name} is already recorded as ${recordedAmount.toFixed(2)}; record the difference as a repayment or a credit sale.`,
          code: 'OPENING_BALANCE_EXISTS',
          details: { recorded: recordedAmount.toFixed(2), requested: value.toFixed(2) },
        });
      }
      const activity = await tx.udharTransaction.count({ where: { shopId: actor.shopId, customerId: id } });
      if (activity > 0 || !balance.isZero()) {
        throw new ConflictException({
          message: `${name} already has udhar activity (balance ${balance.toFixed(2)}); an opening balance is only recorded before the first credit sale or repayment.`,
          code: 'OPENING_BALANCE_AFTER_ACTIVITY',
          details: { outstandingBalance: balance.toFixed(2), transactions: activity },
        });
      }

      const now = this.clock.now();
      const transaction = await tx.udharTransaction.create({
        data: {
          shopId: actor.shopId,
          customerId: id,
          type: 'ADJUSTMENT',
          amount: value.abs(),
          balanceBefore: 0,
          balanceAfter: value,
          reference: 'Opening balance',
          idempotencyKey: key,
          notes: note ?? null,
          recordedById: actor.userId,
          createdAt: now,
        },
      });
      const customer = await tx.customer.update({ where: { id, shopId: actor.shopId }, data: { outstandingBalance: value } });

      const owed = value.greaterThan(0);
      await this.ledger.post(tx, {
        shopId: actor.shopId,
        source: { type: 'OPENING_BALANCE', id: transaction.id },
        description: `Opening balance ${name}`,
        entries: [
          { account: owed ? LedgerAccount.ACCOUNTS_RECEIVABLE : LedgerAccount.OPENING_BALANCE_EQUITY, type: LedgerEntryType.DEBIT, amount: value.abs() },
          { account: owed ? LedgerAccount.OPENING_BALANCE_EQUITY : LedgerAccount.ACCOUNTS_RECEIVABLE, type: LedgerEntryType.CREDIT, amount: value.abs() },
        ],
      });

      await tx.auditLog.create({
        data: {
          shopId: actor.shopId,
          userId: actor.userId,
          action: 'CUSTOMER_OPENING_BALANCE_RECORDED',
          entity: 'Customer',
          entityId: id,
          ipAddress: actor.ipAddress ?? null,
          beforeData: { outstandingBalance: balance.toFixed(2) },
          afterData: { outstandingBalance: value.toFixed(2), transactionId: transaction.id, note: note ?? null },
        },
      });
      await this.auditService.logAction(
        {
          customerId: id,
          actorId: actor.userId,
          ipAddress: actor.ipAddress,
          action: 'CUSTOMER_OPENING_BALANCE_RECORDED',
          previousPayload: { outstandingBalance: balance.toFixed(2) },
          newPayload: { outstandingBalance: value.toFixed(2) },
        },
        tx,
      );
      return { status: 'CREATED' as const, transactionId: transaction.id, outstandingBalance: customer.outstandingBalance };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
  }

  async softDelete(id: string, actor?: Pick<BillingActor, 'userId' | 'ipAddress'>) {
    const shopId = this.tenantContext.getShopId();
    // The balance check and the delete share one transaction and the same row
    // lock the credit path takes, so a sale or repayment cannot land between
    // them and leave a deleted customer holding udhar.
    const deleted = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ outstandingBalance: unknown }>>`
        SELECT outstandingBalance FROM Customer WHERE id = ${id} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
      `;
      if (rows.length === 0) throw new NotFoundException({ message: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
      const outstandingBalance = new Prisma.Decimal(String(rows[0].outstandingBalance));
      if (!outstandingBalance.isZero()) {
        throw new ConflictException({
          message: 'Settle the outstanding balance before deleting this customer.',
          code: 'CUSTOMER_HAS_BALANCE',
          details: { outstandingBalance: outstandingBalance.toNumber() },
        });
      }
      const row = await tx.customer.update({ where: { id, shopId }, data: { isDeleted: true, deletedAt: new Date(), isActive: false } });
      // The audit row commits with the delete (audit P2-4): a crash in between cannot lose it.
      await this.auditService.logAction({ customerId: id, actorId: actor?.userId, ipAddress: actor?.ipAddress, action: 'CUSTOMER_DELETED' }, tx);
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return deleted;
  }
  /** Only MANAGER and above may set or change a credit limit (roadmap 3.4, audit P1-11). */
  private assertCreditLimitAuthority(creditLimit: number | undefined, actor?: Pick<BillingActor, 'role'>): void {
    if (creditLimit === undefined) return;
    if (!actor || !isManager(actor.role)) {
      throw new ForbiddenException({ message: 'Only a manager can set a customer credit limit.', code: 'CREDIT_LIMIT_REQUIRES_MANAGER' });
    }
  }

}
