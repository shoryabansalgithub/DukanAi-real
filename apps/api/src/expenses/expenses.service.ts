import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Expense, LedgerEntryType, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { StoragePathBuilder } from '../storage/storage-path.builder';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { ListQueryDto, pageArgs, PagedResult } from '../common/pagination';
import { safeTimeZone, toZonedParts, zonedDateToUtc } from '../common/time/business-day';
import { Clock } from '../common/time/clock';
import { withSerializationRetry } from '../common/db/serialization-retry';
import { LedgerEntryInput, LedgerPostingService } from '../ledger/ledger-posting.service';
import { applyCashPayout, lockShiftForCashPayout, reverseCashPayout } from '../shifts/cash-payout';
import { CASH_MODE, EXPENSE_SOURCES, ExpenseBooks, expenseAdjustmentSourceId, expenseCashOut, expenseLedgerState } from './expense-books';

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
  /** How it was paid, `Unpaid` while pending (the list's "Date & Mode" column). */
  mode: string;
  /** The stored payment mode, also on a pending expense when one was chosen (what "Mark as Paid" records). */
  paymentMode: string | null;
  date: string;
  /** A receipt photo or PDF is attached (`GET /expenses/:id/receipt`). */
  hasReceipt: boolean;
  /** Its content type, null without one. */
  receiptType: string | null;
}

/** An attached receipt, ready to stream. */
export interface ExpenseReceiptFile {
  absolutePath: string;
  mimeType: string;
  fileName: string;
  size: number;
}

/** The file extension a receipt is stored under, by its (sniffed and declared) content type. */
const RECEIPT_EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };

/** Who records an expense: the shop, the user (whose open drawer pays a cash expense) and the request address. */
export interface ExpenseActor {
  shopId: string;
  userId: string;
  ipAddress?: string | null;
}

const ZERO = new Prisma.Decimal(0);

/** The audit snapshot of an expense (AuditLog before/after); the reconciliation reads a shift's payouts at its close from it. */
function auditSnapshot(expense: Expense): Prisma.InputJsonObject {
  return {
    description: expense.description,
    category: expense.category,
    amount: expense.amount.toFixed(2),
    isPaid: expense.isPaid,
    paymentMode: expense.paymentMode,
    expenseDate: expense.expenseDate.toISOString(),
    shiftId: expense.shiftId,
    isDeleted: expense.isDeleted,
    receiptAttached: expense.receiptPath !== null,
  };
}

function toView(expense: Expense): ExpenseView {
  return {
    id: expense.id,
    description: expense.description,
    category: expense.category,
    amount: Number(expense.amount),
    status: expense.isPaid ? 'Paid' : 'Pending',
    mode: expense.isPaid ? (expense.paymentMode ?? CASH_MODE) : 'Unpaid',
    paymentMode: expense.paymentMode,
    date: expense.expenseDate.toISOString(),
    hasReceipt: expense.receiptPath !== null,
    receiptType: expense.receiptPath !== null ? expense.receiptMimeType : null,
  };
}

/**
 * Shop expenses (roadmap 6.7, release audit L6). An expense reaches the books
 * and the drawer:
 *
 *  - Ledger: a paid expense posts DR EXPENSES / CR CASH (mode Cash) or CR BANK
 *    (UPI, Card, Bank Transfer), source `EXPENSE` (the expense id). Ledger
 *    rows are immutable, so every later change that moves money (amount,
 *    mode, paid, deleted) posts the difference between what the expense's
 *    postings already hold and what the expense now implies, source
 *    `EXPENSE_ADJUSTMENT` `<id>:<n>`. The sum of an expense's postings is
 *    always `expenseLedgerState(expense)`; the reconciliation checks it.
 *  - Drawer: cash paid by a user with an open shift leaves that shift
 *    (`lockShiftForCashPayout` / `applyCashPayout`, `Expense.shiftId`). While
 *    that shift is open an edit or a delete moves its payout with it
 *    (`reverseCashPayout` / `applyCashPayout`; `shiftId` is cleared when the
 *    expense no longer takes cash from it); once it has closed, its counted
 *    drawer is history and is left alone.
 *  - Audit: an AuditLog row per create, update, delete and receipt, in the
 *    same transaction.
 *  - Receipt: one photo or PDF per expense under the shop's storage root
 *    (`Expenses/<id>/receipt-<stamp>.<ext>`, written with `wx`, never in
 *    place); attaching another moves the earlier file to the shop's
 *    `Deleted/` folder, so a receipt is never destroyed by a replacement.
 *
 * Lock order: the expense row (edits), then the Shift, then the ledger
 * balances (inside `LedgerPostingService.post`).
 */
@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly ledger: LedgerPostingService,
    private readonly clock: Clock,
    private readonly paths: StoragePathBuilder,
  ) {}

  async summary(): Promise<ExpenseSummary> {
    const shopId = this.tenantContext.getShopId();
    const settings = await this.prisma.shopSettings.findUnique({ where: { shopId }, select: { timezone: true } });
    const timeZone = safeTimeZone(settings?.timezone);
    const parts = toZonedParts(this.clock.now(), timeZone);
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

  async create(dto: CreateExpenseDto, actor: ExpenseActor): Promise<ExpenseView> {
    const isPaid = dto.isPaid ?? true;
    // A pending expense keeps the mode it will be paid with, when one was chosen.
    const paymentMode = dto.paymentMode ?? (isPaid ? CASH_MODE : null);
    const amount = new Prisma.Decimal(dto.amount).toDecimalPlaces(2);
    const expense = await this.transaction(async (tx) => {
      const now = this.clock.now();
      // Cash paid now leaves the recorder's open drawer: the Shift lock comes first.
      const shiftId = isPaid && paymentMode === CASH_MODE ? await lockShiftForCashPayout(tx, actor.shopId, actor.userId) : null;
      const created = await tx.expense.create({
        data: {
          // Scalar shopId (not shop.connect): the tenant Prisma extension
          // validates/injects shopId for tenant-owned models.
          shopId: actor.shopId,
          description: dto.description,
          category: dto.category,
          amount,
          isPaid,
          paymentMode,
          shiftId,
          expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : now,
          createdAt: now,
        },
      });
      await applyCashPayout(tx, shiftId, expenseCashOut(created));
      await this.syncLedger(tx, actor.shopId, created);
      await this.audit(tx, actor, 'EXPENSE_CREATED', created.id, null, created, now);
      return created;
    });
    return toView(expense);
  }

  async update(id: string, dto: UpdateExpenseDto, actor: ExpenseActor): Promise<ExpenseView> {
    const expense = await this.transaction(async (tx) => {
      const before = await this.lockExpense(tx, actor.shopId, id);
      const isPaid = dto.isPaid ?? before.isPaid;
      const next: ExpenseBooks = {
        amount: dto.amount !== undefined ? new Prisma.Decimal(dto.amount).toDecimalPlaces(2) : before.amount,
        isPaid,
        // The mode survives a switch to pending (it is what "Mark as Paid" records); a paid expense always has one.
        paymentMode: dto.paymentMode ?? before.paymentMode ?? (isPaid ? CASH_MODE : null),
        isDeleted: false,
      };
      const now = this.clock.now();
      const shiftId = await this.moveDrawer(tx, actor, before, next);
      const updated = await tx.expense.update({
        where: { id },
        data: {
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.expenseDate !== undefined ? { expenseDate: new Date(dto.expenseDate) } : {}),
          amount: next.amount,
          isPaid: next.isPaid,
          paymentMode: next.paymentMode,
          shiftId,
          updatedAt: now,
        },
      });
      await this.syncLedger(tx, actor.shopId, updated);
      await this.audit(tx, actor, 'EXPENSE_UPDATED', id, before, updated, now);
      return updated;
    });
    return toView(expense);
  }

  async softDelete(id: string, actor: ExpenseActor): Promise<void> {
    await this.transaction(async (tx) => {
      const before = await this.lockExpense(tx, actor.shopId, id);
      const now = this.clock.now();
      const shiftId = await this.moveDrawer(tx, actor, before, { ...before, isDeleted: true });
      const deleted = await tx.expense.update({ where: { id }, data: { isDeleted: true, deletedAt: now, shiftId, updatedAt: now } });
      // A paid expense taken back: the reversal of its postings.
      await this.syncLedger(tx, actor.shopId, deleted);
      await this.audit(tx, actor, 'EXPENSE_DELETED', id, before, deleted, now);
    });
  }

  /**
   * `POST /expenses/:id/receipt`: stores the (already validated) photo or PDF
   * and points the expense at it. The file is written first under a new name
   * (`wx`), the row second under the expense lock; a failed row update
   * removes the new file, a full volume answers 507 with nothing kept. The
   * receipt it replaces is moved to `Deleted/`, never removed.
   */
  async attachReceipt(id: string, file: Pick<Express.Multer.File, 'buffer' | 'mimetype'>, actor: ExpenseActor): Promise<ExpenseView> {
    const extension = RECEIPT_EXTENSIONS[file.mimetype];
    if (!extension) throw new BadRequestException({ message: `Unsupported receipt type ${file.mimetype}`, code: 'EXPENSE_RECEIPT_TYPE' });
    // 404 before anything is written for an unknown, deleted or foreign expense.
    const live = await this.prisma.expense.findFirst({ where: { id, shopId: actor.shopId, isDeleted: false }, select: { id: true } });
    if (!live) throw new NotFoundException({ message: `Expense ${id} not found`, code: 'EXPENSE_NOT_FOUND' });

    const now = this.clock.now();
    const directory = this.paths.getExpenseDirectory(actor.shopId, id);
    const target = path.join(directory, `receipt-${now.getTime()}-${randomBytes(4).toString('hex')}${extension}`);
    await fs.ensureDir(directory);
    try {
      await fs.writeFile(target, file.buffer, { flag: 'wx' });
    } catch (error) {
      await fs.remove(target).catch(() => undefined);
      throw error;
    }

    const relative = this.paths.relativeToShop(actor.shopId, target);
    let attached: { row: Expense; replaced: string | null };
    try {
      attached = await this.transaction(async (tx) => {
        const before = await this.lockExpense(tx, actor.shopId, id);
        const row = await tx.expense.update({ where: { id }, data: { receiptPath: relative, receiptMimeType: file.mimetype, updatedAt: now } });
        await this.audit(tx, actor, 'EXPENSE_RECEIPT_ATTACHED', id, before, row, now);
        return { row, replaced: before.receiptPath };
      });
    } catch (error) {
      await fs.remove(target).catch(() => undefined);
      throw error;
    }
    if (attached.replaced && attached.replaced !== relative) await this.retireReceipt(actor.shopId, attached.replaced);
    return toView(attached.row);
  }

  /** `GET /expenses/:id/receipt`: the attached file of a live expense of this shop; 404 otherwise. */
  async receipt(id: string): Promise<ExpenseReceiptFile> {
    const shopId = this.tenantContext.getShopId();
    const expense = await this.prisma.expense.findFirst({ where: { id, shopId, isDeleted: false }, select: { receiptPath: true, receiptMimeType: true } });
    if (!expense) throw new NotFoundException({ message: `Expense ${id} not found`, code: 'EXPENSE_NOT_FOUND' });
    if (!expense.receiptPath) throw new NotFoundException({ message: 'No receipt is attached to this expense', code: 'EXPENSE_RECEIPT_NOT_FOUND' });
    const absolutePath = this.paths.fromShopRelative(shopId, expense.receiptPath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      // The row survived but the file did not (a database restored without the documents volume).
      throw new NotFoundException({ message: 'The receipt file is missing from storage', code: 'EXPENSE_RECEIPT_MISSING' });
    }
    const mimeType = expense.receiptMimeType ?? 'application/octet-stream';
    return { absolutePath, mimeType, fileName: `receipt-${id}${RECEIPT_EXTENSIONS[mimeType] ?? path.extname(absolutePath)}`, size: stat.size };
  }

  /** Moves a replaced receipt to the shop's `Deleted/` folder; a failure is logged, the new receipt stands. */
  private async retireReceipt(shopId: string, relativePath: string): Promise<void> {
    try {
      const source = this.paths.fromShopRelative(shopId, relativePath);
      if (!(await fs.pathExists(source))) return;
      const target = this.paths.getDeletedFileTarget(shopId, path.basename(source));
      await fs.ensureDir(path.dirname(target));
      await fs.move(source, target);
    } catch (error) {
      this.logger.warn(`Could not move the replaced receipt ${relativePath} of shop ${shopId} to Deleted/: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withSerializationRetry(() => this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
  }

  /** The live expense, locked (`FOR UPDATE`) so two edits of it apply one after the other; 404 otherwise. */
  private async lockExpense(tx: Prisma.TransactionClient, shopId: string, id: string): Promise<Expense> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM Expense WHERE id = ${id} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
    `;
    const expense = rows.length > 0 ? await tx.expense.findFirst({ where: { id, shopId } }) : null;
    if (!expense) throw new NotFoundException({ message: `Expense ${id} not found`, code: 'EXPENSE_NOT_FOUND' });
    return expense;
  }

  /**
   * Keeps the drawer in step with an edit or a delete and returns the
   * expense's `shiftId` afterwards. The shift that paid it, while still
   * open, gives back the old payout and takes the new one (none: the
   * expense leaves it). A closed shift is left alone. An expense that was not
   * a cash payment and now is one (marked paid in cash, switched to cash) is
   * paid now, from the actor's open drawer.
   */
  private async moveDrawer(tx: Prisma.TransactionClient, actor: ExpenseActor, before: Expense, next: ExpenseBooks): Promise<string | null> {
    const oldCash = expenseCashOut(before);
    const newCash = expenseCashOut(next);
    if (before.shiftId) {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM Shift WHERE id = ${before.shiftId} AND shopId = ${actor.shopId} FOR UPDATE
      `;
      if (rows[0]?.status !== 'OPEN') return before.shiftId;
      await reverseCashPayout(tx, before.shiftId, oldCash);
      if (!newCash.greaterThan(0)) return null;
      await applyCashPayout(tx, before.shiftId, newCash);
      return before.shiftId;
    }
    if (newCash.greaterThan(0) && !oldCash.greaterThan(0)) {
      const shiftId = await lockShiftForCashPayout(tx, actor.shopId, actor.userId);
      await applyCashPayout(tx, shiftId, newCash);
      return shiftId;
    }
    return null;
  }

  /**
   * Posts whatever the expense's ledger postings still lack: the difference
   * between `expenseLedgerState(expense)` and the sum of every posting of the
   * expense so far. The first posting is `EXPENSE` (the expense id), each
   * later one `EXPENSE_ADJUSTMENT` `<id>:<n>`; nothing is posted when the two
   * agree (a description or date edit). An expense recorded before expenses
   * were posted is brought into the books by its first money-relevant write.
   */
  private async syncLedger(tx: Prisma.TransactionClient, shopId: string, expense: Expense): Promise<void> {
    const postings = await tx.ledgerPosting.findMany({
      where: {
        shopId,
        OR: [
          { sourceType: EXPENSE_SOURCES.posted, sourceId: expense.id },
          { sourceType: EXPENSE_SOURCES.adjusted, sourceId: { startsWith: `${expense.id}:` } },
        ],
      },
      include: { transactions: true },
    });
    const delta = expenseLedgerState(expense);
    for (const t of postings.flatMap((p) => p.transactions)) {
      const signed = t.type === LedgerEntryType.DEBIT ? t.amount : t.amount.neg();
      delta.set(t.account, (delta.get(t.account) ?? ZERO).minus(signed));
    }
    const entries: LedgerEntryInput[] = [...delta.entries()]
      .filter(([, amount]) => !amount.isZero())
      .map(([account, amount]) => ({ account, type: amount.greaterThan(0) ? LedgerEntryType.DEBIT : LedgerEntryType.CREDIT, amount: amount.abs() }));
    if (entries.length === 0) return;

    const first = !postings.some((p) => p.sourceType === EXPENSE_SOURCES.posted);
    const adjustments = postings.filter((p) => p.sourceType === EXPENSE_SOURCES.adjusted).length;
    await this.ledger.post(tx, {
      shopId,
      source: first ? { type: EXPENSE_SOURCES.posted, id: expense.id } : { type: EXPENSE_SOURCES.adjusted, id: expenseAdjustmentSourceId(expense.id, adjustments + 1) },
      // No description or category: LedgerTransaction is immutable, so free text could never be erased (roadmap 9.24).
      description: first ? `Expense (${expense.paymentMode ?? CASH_MODE})` : 'Expense adjustment',
      entries,
    });
  }

  private async audit(tx: Prisma.TransactionClient, actor: ExpenseActor, action: string, id: string, before: Expense | null, after: Expense, now: Date): Promise<void> {
    await tx.auditLog.create({
      data: {
        shopId: actor.shopId,
        userId: actor.userId,
        action,
        entity: 'Expense',
        entityId: id,
        ipAddress: actor.ipAddress ?? null,
        beforeData: before ? auditSnapshot(before) : undefined,
        afterData: auditSnapshot(after),
        createdAt: now,
      },
    });
  }
}
