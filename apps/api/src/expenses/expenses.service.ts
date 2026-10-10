import { Injectable, NotFoundException } from '@nestjs/common';
import { Expense, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { ListQueryDto, pageArgs, PagedResult } from '../common/pagination';
import { safeTimeZone, toZonedParts, zonedDateToUtc } from '../common/time/business-day';

/** `GET /expenses/summary` (roadmap 6.7). Money as numbers with 2 decimals. */
export interface ExpenseSummary {
  /** `YYYY-MM` of the shop's current business month. */
  month: string;
  /** Paid expenses dated in this month. */
  paidThisMonth: number;
  /** Every unpaid expense, whatever its date (a due is a due until it is settled). */
  pendingTotal: number;
  /** Largest category of this month (paid or pending), or null without expenses. */
  largestCategory: { category: string; amount: number } | null;
  countThisMonth: number;
}

/** Shape the expenses page renders. */
export interface ExpenseView {
  id: string;
  description: string;
  category: string;
  amount: number;
  status: 'Paid' | 'Pending';
  mode: string;
  date: string;
}

function toView(expense: Expense): ExpenseView {
  return {
    id: expense.id,
    description: expense.description,
    category: expense.category,
    amount: Number(expense.amount),
    status: expense.isPaid ? 'Paid' : 'Pending',
    mode: expense.isPaid ? (expense.paymentMode ?? 'Cash') : 'Unpaid',
    date: expense.expenseDate.toISOString(),
  };
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async summary(): Promise<ExpenseSummary> {
    const shopId = this.tenantContext.getShopId();
    const settings = await this.prisma.shopSettings.findUnique({ where: { shopId }, select: { timezone: true } });
    const timeZone = safeTimeZone(settings?.timezone);
    const parts = toZonedParts(new Date(), timeZone);
    const start = zonedDateToUtc(parts.year, parts.month, 1, timeZone);
    const end = parts.month === 12 ? zonedDateToUtc(parts.year + 1, 1, 1, timeZone) : zonedDateToUtc(parts.year, parts.month + 1, 1, timeZone);
    const inMonth = { isDeleted: false, expenseDate: { gte: start, lt: end } };

    const [paid, pending, byCategory, countThisMonth] = await Promise.all([
      this.prisma.expense.aggregate({ where: { ...inMonth, isPaid: true }, _sum: { amount: true } }),
      this.prisma.expense.aggregate({ where: { isDeleted: false, isPaid: false }, _sum: { amount: true } }),
      this.prisma.expense.groupBy({ by: ['category'], where: inMonth, _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 1 }),
      this.prisma.expense.count({ where: inMonth }),
    ]);
    const money = (value: Prisma.Decimal | null | undefined) => Number((value ?? new Prisma.Decimal(0)).toFixed(2));
    const top = byCategory[0];
    return {
      month: `${parts.year}-${String(parts.month).padStart(2, '0')}`,
      paidThisMonth: money(paid._sum.amount),
      pendingTotal: money(pending._sum.amount),
      largestCategory: top ? { category: top.category, amount: money(top._sum.amount) } : null,
      countThisMonth,
    };
  }

  /** Newest first, hard-capped page (roadmap 5.6). */
  async findAll(query?: ListQueryDto): Promise<PagedResult<ExpenseView>> {
    // shopId is injected by the tenant Prisma extension.
    const { skip, take } = pageArgs(query);
    const where = { isDeleted: false };
    const [expenses, total] = await Promise.all([
      this.prisma.expense.findMany({ where, orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }], skip, take }),
      this.prisma.expense.count({ where }),
    ]);
    return { items: expenses.map(toView), total, skip, take };
  }

  async create(dto: CreateExpenseDto): Promise<ExpenseView> {
    const isPaid = dto.isPaid ?? true;
    const expense = await this.prisma.expense.create({
      data: {
        // Scalar shopId (not shop.connect): the tenant Prisma extension
        // validates/injects shopId for tenant-owned models.
        shopId: this.tenantContext.getShopId(),
        description: dto.description,
        category: dto.category,
        amount: new Prisma.Decimal(dto.amount),
        isPaid,
        paymentMode: isPaid ? (dto.paymentMode ?? 'Cash') : null,
        expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : new Date(),
      },
    });
    return toView(expense);
  }

  async update(id: string, dto: UpdateExpenseDto): Promise<ExpenseView> {
    await this.ensureExists(id);
    const data: Prisma.ExpenseUpdateInput = {};
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.expenseDate !== undefined) data.expenseDate = new Date(dto.expenseDate);
    if (dto.isPaid !== undefined) {
      data.isPaid = dto.isPaid;
      data.paymentMode = dto.isPaid ? (dto.paymentMode ?? 'Cash') : null;
    } else if (dto.paymentMode !== undefined) {
      data.paymentMode = dto.paymentMode;
    }
    const expense = await this.prisma.expense.update({ where: { id }, data });
    return toView(expense);
  }

  async softDelete(id: string): Promise<void> {
    await this.ensureExists(id);
    await this.prisma.expense.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date() },
    });
  }

  private async ensureExists(id: string): Promise<Expense> {
    const expense = await this.prisma.expense.findFirst({ where: { id, isDeleted: false } });
    if (!expense) {
      throw new NotFoundException(`Expense ${id} not found`);
    }
    return expense;
  }
}
