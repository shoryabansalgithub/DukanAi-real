import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Supplier, TenderType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateSupplierDto, RecordSupplierPaymentDto, UpdateSupplierDto } from './dto/supplier.dto';
import { SupplierPayablesService } from '../ledger/supplier-payables.service';
import { ListQueryDto, pageArgs, PagedResult } from '../common/pagination';

/** Shape the suppliers page renders. */
export interface SupplierView {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string | null;
  gstin: string | null;
  address: string | null;
  pendingPayables: number;
  lastDelivery: string | null;
  status: 'Active' | 'Inactive';
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

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly payables: SupplierPayablesService,
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

  async create(dto: CreateSupplierDto): Promise<SupplierView> {
    const { openingBalance, ...rest } = dto;
    const supplier = await this.prisma.supplier.create({
      data: {
        ...rest,
        // Scalar shopId (not shop.connect): the tenant Prisma extension
        // validates/injects shopId for tenant-owned models.
        shopId: this.tenantContext.getShopId(),
        pendingPayables: new Prisma.Decimal(openingBalance ?? 0),
        openingPayables: new Prisma.Decimal(openingBalance ?? 0),
      },
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
   * CR CASH|BANK posting, in one transaction.
   */
  async recordPayment(id: string, dto: RecordSupplierPaymentDto, recordedById?: string): Promise<SupplierView & { payment: { id: string; amount: number; tender: TenderType; replayed: boolean } }> {
    await this.ensureExists(id);
    const shopId = this.tenantContext.getShopId();
    const outcome = await this.prisma.$transaction((tx) =>
      this.payables.pay(tx, { shopId, supplierId: id, amount: dto.amount, tender: dto.tender, reference: dto.reference, idempotencyKey: dto.idempotencyKey, notes: dto.notes, recordedById }),
    );
    const supplier = await this.prisma.supplier.findFirstOrThrow({ where: { id, shopId } });
    return { ...toView(supplier), payment: { id: outcome.payment.id, amount: outcome.payment.amount.toNumber(), tender: outcome.payment.tender, replayed: outcome.replayed } };
  }

  async softDelete(id: string): Promise<void> {
    await this.ensureExists(id);
    await this.prisma.supplier.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), isActive: false },
    });
  }

  private async ensureExists(id: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findFirst({ where: { id, isDeleted: false } });
    if (!supplier) {
      throw new NotFoundException(`Supplier ${id} not found`);
    }
    return supplier;
  }
}
