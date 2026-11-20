import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma, Supplier, TenderType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateSupplierDto, RecordSupplierPaymentDto, UpdateSupplierDto } from './dto/supplier.dto';
import { SupplierPayablesService } from '../ledger/supplier-payables.service';
import { LedgerPostingService } from '../ledger/ledger-posting.service';
import { ListQueryDto, pageArgs, PagedResult } from '../common/pagination';
import { withSerializationRetry } from '../common/db/serialization-retry';

/** Shape the suppliers page renders. */
export interface SupplierView {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string | null;
  gstin: string | null;
  address: string | null;
  /** What the shop owes the supplier; below zero is an advance the supplier holds (goods returned after payment). */
  pendingPayables: number;
  lastDelivery: string | null;
  status: 'Active' | 'Inactive';
}

/** `GET /suppliers/summary`: totals over every live supplier, not one page of them. */
export interface SuppliersSummary {
  /** Σ pendingPayables (Decimal, 2 dp, as a string), advances included as negatives. */
  totalPayables: string;
  count: number;
  activeCount: number;
}

function toView(supplier: Supplier & { purchaseOrders?: { updatedAt: Date }[] }): SupplierView {
  return {
    id: supplier.id,
    name: supplier.name,
    contactPerson: supplier.contactPerson ?? 'N/A',
    phone: supplier.phone,
    email: supplier.email,
    gstin: supplier.gstin,
    address: supplier.address,
    pendingPayables: Number(supplier.pendingPayables),
    lastDelivery: supplier.purchaseOrders?.[0]?.updatedAt.toISOString() ?? null,
    status: supplier.isActive ? 'Active' : 'Inactive',
  };
}

/** Payment transactions: READ COMMITTED (the replay lookup must see a twin's committed row) with a deadlock retry. */
const PAYMENT_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000, maxWait: 15_000 };

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly payables: SupplierPayablesService,
    private readonly ledger: LedgerPostingService,
  ) {}

  /** By name, hard-capped page (roadmap 5.6). */
  async findAll(query?: ListQueryDto): Promise<PagedResult<SupplierView>> {
    // shopId is injected by the tenant Prisma extension.
    const { skip, take } = pageArgs(query);
    const where = { isDeleted: false };
    const [suppliers, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take,
        include: {
          purchaseOrders: {
            orderBy: { updatedAt: 'desc' },
            take: 1,
            select: { updatedAt: true },
          },
        },
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return { items: suppliers.map(toView), total, skip, take };
  }

  /** The page's tiles: one aggregate over every live supplier (the list is a capped page). */
  async summary(): Promise<SuppliersSummary> {
    const where = { isDeleted: false };
    const [sum, count, activeCount] = await Promise.all([
      this.prisma.supplier.aggregate({ where, _sum: { pendingPayables: true } }),
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.count({ where: { ...where, isActive: true } }),
    ]);
    return { totalPayables: (sum._sum.pendingPayables ?? new Prisma.Decimal(0)).toFixed(2), count, activeCount };
  }

  /**
   * A new supplier; an opening balance (what the shop owed before it started
   * using the app) is posted in the same transaction: DR
   * OPENING_BALANCE_EQUITY / CR ACCOUNTS_PAYABLE, source
   * `SUPPLIER_OPENING_BALANCE` (the supplier id), so the ledger's payables
   * equal the suppliers' balances from the first day.
   */
  async create(dto: CreateSupplierDto): Promise<SupplierView> {
    const { openingBalance, ...rest } = dto;
    const shopId = this.tenantContext.getShopId();
    const opening = new Prisma.Decimal(openingBalance ?? 0).toDecimalPlaces(2);
    const supplier = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: {
          ...rest,
          // Scalar shopId (not shop.connect): the tenant Prisma extension
          // validates/injects shopId for tenant-owned models.
          shopId,
          pendingPayables: opening,
          openingPayables: opening,
        },
      });
      if (opening.greaterThan(0)) {
        await this.ledger.post(tx, {
          shopId,
          source: { type: 'SUPPLIER_OPENING_BALANCE', id: created.id },
          description: 'Supplier opening balance',
          entries: [
            { account: LedgerAccount.OPENING_BALANCE_EQUITY, type: LedgerEntryType.DEBIT, amount: opening },
            { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.CREDIT, amount: opening },
          ],
        });
      }
      return created;
    });
    return toView(supplier);
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierView> {
    await this.ensureExists(id);
    const supplier = await this.prisma.supplier.update({ where: { id }, data: dto });
    return toView(supplier);
  }

  /**
   * Records a payment made to the supplier (roadmap 3.11): a SupplierPayment
   * row, a guarded decrement of the payable and a DR ACCOUNTS_PAYABLE /
   * CR CASH|BANK posting, in one transaction. The idempotency key is
   * required: a retried or double-clicked payment replays the first one.
   */
  async recordPayment(id: string, dto: RecordSupplierPaymentDto, recordedById?: string): Promise<SupplierView & { payment: { id: string; amount: number; tender: TenderType; replayed: boolean } }> {
    await this.ensureExists(id);
    const shopId = this.tenantContext.getShopId();
    const outcome = await withSerializationRetry(() =>
      this.prisma.$transaction(
        (tx) =>
          this.payables.pay(tx, { shopId, supplierId: id, amount: dto.amount, tender: dto.tender, reference: dto.reference, idempotencyKey: dto.idempotencyKey, notes: dto.notes, recordedById }),
        PAYMENT_TX,
      ),
    );
    const supplier = await this.prisma.supplier.findFirstOrThrow({ where: { id, shopId } });
    return { ...toView(supplier), payment: { id: outcome.payment.id, amount: outcome.payment.amount.toNumber(), tender: outcome.payment.tender, replayed: outcome.replayed } };
  }

  /**
   * Soft delete. A supplier the shop still owes (or who holds an advance) is
   * refused with 409 SUPPLIER_HAS_BALANCE: the balance is checked under the
   * row lock every payable writer takes, so a receipt cannot land in between.
   */
  async softDelete(id: string): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    await this.prisma.$transaction(async (tx) => {
      const supplier = await this.payables.lockSupplier(tx, shopId, id);
      if (!supplier.pendingPayables.isZero()) {
        throw new ConflictException({
          message: `This supplier still has a balance of ₹${supplier.pendingPayables.toFixed(2)}; settle it before deleting the supplier.`,
          code: 'SUPPLIER_HAS_BALANCE',
          details: { pendingPayables: supplier.pendingPayables.toFixed(2) },
        });
      }
      await tx.supplier.update({ where: { id }, data: { isDeleted: true, deletedAt: new Date(), isActive: false } });
    });
  }

  private async ensureExists(id: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findFirst({ where: { id, isDeleted: false } });
    if (!supplier) {
      throw new NotFoundException({ message: `Supplier ${id} not found`, code: 'SUPPLIER_NOT_FOUND' });
    }
    return supplier;
  }
}
