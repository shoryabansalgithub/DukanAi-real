import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export const CUSTOMER_DETAIL_INCLUDE = {
  profile: true,
  addresses: true,
  contacts: true,
  invoices: {
    where: { isDeleted: false },
    orderBy: { createdAt: 'desc' as const },
    take: 10,
    select: {
      id: true,
      invoiceNumber: true,
      type: true,
      status: true,
      totalAmount: true,
      paidAmount: true,
      udharAmount: true,
      paymentMode: true,
      createdAt: true,
    },
  },
  udharTransactions: {
    orderBy: { createdAt: 'desc' as const },
    take: 10,
    select: {
      id: true,
      type: true,
      amount: true,
      balanceBefore: true,
      balanceAfter: true,
      tender: true,
      reference: true,
      notes: true,
      createdAt: true,
      invoice: { select: { id: true, invoiceNumber: true } },
      recordedBy: { select: { name: true } },
    },
  },
} satisfies Prisma.CustomerInclude;

@Injectable()
export class CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.CustomerCreateInput | Prisma.CustomerUncheckedCreateInput) {
    return this.prisma.customer.create({ data });
  }

  async findById(id: string, shopId: string) {
    return this.prisma.customer.findFirst({
      where: { id, shopId, isDeleted: false },
      include: CUSTOMER_DETAIL_INCLUDE,
    });
  }

  async findAll(shopId: string, options: { q?: string; skip?: number; take?: number } = {}) {
    const where: Prisma.CustomerWhereInput = { shopId, isDeleted: false };
    if (options.q?.trim()) {
      const q = options.q.trim();
      where.OR = [{ name: { contains: q } }, { phone: { contains: q } }, { email: { contains: q } }];
    }
    const take = options.take ?? 25;
    const skip = options.skip ?? 0;
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, skip, take, include: { profile: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.customer.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async update(id: string, shopId: string, data: Prisma.CustomerUpdateInput) {
    return this.prisma.customer.update({ where: { id, shopId }, data });
  }

  async softDelete(id: string, shopId: string) {
    return this.prisma.customer.update({ where: { id, shopId }, data: { isDeleted: true, deletedAt: new Date(), isActive: false } });
  }
}
