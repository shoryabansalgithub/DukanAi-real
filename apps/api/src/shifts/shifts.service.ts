import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Shift } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillingActor, isManager, money } from '../billing/billing.types';
import { BillingHelpers } from '../billing/billing.helpers';
import { CloseShiftDto, ListShiftsDto, OpenShiftDto } from './dto/shift.dto';

const SHIFT_INCLUDE = {
  openedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
} satisfies Prisma.ShiftInclude;

export type ShiftView = Shift & { openedBy: { id: string; name: string }; closedBy: { id: string; name: string } | null; variance: Prisma.Decimal | null };

/**
 * Cash-drawer sessions. `expectedCash` starts at the opening float and is
 * moved by every cash sale, cash refund and cash receipt inside the billing
 * and customer transactions, so closing a shift is a pure comparison.
 */
@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService, private readonly helpers: BillingHelpers) {}

  private view(shift: Shift & { openedBy: { id: string; name: string }; closedBy: { id: string; name: string } | null }): ShiftView {
    return { ...shift, variance: shift.closingCash ? shift.closingCash.minus(shift.expectedCash) : null };
  }

  async current(actor: BillingActor): Promise<ShiftView | null> {
    const shift = await this.prisma.shift.findFirst({
      where: { shopId: actor.shopId, openedById: actor.userId, status: 'OPEN', isDeleted: false },
      include: SHIFT_INCLUDE,
      orderBy: { openedAt: 'desc' },
    });
    return shift ? this.view(shift) : null;
  }

  async open(dto: OpenShiftDto, actor: BillingActor): Promise<ShiftView> {
    const shift = await this.prisma.$transaction(async (tx) => {
      const open = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM Shift WHERE shopId = ${actor.shopId} AND openedById = ${actor.userId} AND status = 'OPEN' AND isDeleted = false FOR UPDATE
      `;
      if (open.length > 0) {
        throw new ConflictException({ message: 'You already have an open shift. Close it before opening another.', code: 'SHIFT_ALREADY_OPEN', details: { shiftId: open[0].id } });
      }
      const created = await tx.shift.create({
        data: {
          shopId: actor.shopId,
          openedById: actor.userId,
          openingCash: money(dto.openingCash),
          expectedCash: money(dto.openingCash),
          notes: dto.notes ?? null,
          status: 'OPEN',
        },
        include: SHIFT_INCLUDE,
      });
      await tx.auditLog.create({
        data: {
          shopId: actor.shopId,
          userId: actor.userId,
          action: 'SHIFT_OPENED',
          entity: 'Shift',
          entityId: created.id,
          ipAddress: actor.ipAddress ?? null,
          afterData: { openingCash: created.openingCash.toFixed(2) },
        },
      });
      return created;
    });
    return this.view(shift);
  }

  async close(dto: CloseShiftDto, actor: BillingActor, shiftId?: string): Promise<ShiftView> {
    const shift = await this.prisma.$transaction(async (tx) => {
      const rows = shiftId
        ? await tx.$queryRaw<Array<{ id: string; openedById: string }>>`
            SELECT id, openedById FROM Shift WHERE id = ${shiftId} AND shopId = ${actor.shopId} AND status = 'OPEN' AND isDeleted = false FOR UPDATE`
        : await tx.$queryRaw<Array<{ id: string; openedById: string }>>`
            SELECT id, openedById FROM Shift WHERE shopId = ${actor.shopId} AND openedById = ${actor.userId} AND status = 'OPEN' AND isDeleted = false
            ORDER BY openedAt DESC LIMIT 1 FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException({ message: 'No open shift to close.', code: 'SHIFT_NOT_FOUND' });
      if (rows[0].openedById !== actor.userId && !isManager(actor.role)) {
        throw new ForbiddenException({ message: 'Only the cashier who opened the shift or a manager can close it.', code: 'SHIFT_FORBIDDEN' });
      }
      const before = await tx.shift.findUniqueOrThrow({ where: { id: rows[0].id } });
      const closingCash = money(dto.closingCash);
      const updated = await tx.shift.update({
        where: { id: rows[0].id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closedById: actor.userId,
          closingCash,
          notes: dto.notes ? (before.notes ? `${before.notes} | ${dto.notes}` : dto.notes) : before.notes,
        },
        include: SHIFT_INCLUDE,
      });
      await tx.auditLog.create({
        data: {
          shopId: actor.shopId,
          userId: actor.userId,
          action: 'SHIFT_CLOSED',
          entity: 'Shift',
          entityId: updated.id,
          ipAddress: actor.ipAddress ?? null,
          beforeData: { expectedCash: before.expectedCash.toFixed(2), totalSales: before.totalSales.toFixed(2) },
          afterData: {
            closingCash: closingCash.toFixed(2),
            variance: closingCash.minus(before.expectedCash).toFixed(2),
            cashSales: before.cashSales.toFixed(2),
            upiSales: before.upiSales.toFixed(2),
            cardSales: before.cardSales.toFixed(2),
            udharSales: before.udharSales.toFixed(2),
            totalReceipts: before.totalReceipts.toFixed(2),
          },
        },
      });
      return updated;
    });
    return this.view(shift);
  }

  async list(query: ListShiftsDto, actor: BillingActor) {
    const where: Prisma.ShiftWhereInput = { shopId: actor.shopId, isDeleted: false };
    if (!isManager(actor.role)) where.openedById = actor.userId;
    const take = query.take ?? 25;
    const skip = query.skip ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.shift.findMany({ where, include: SHIFT_INCLUDE, orderBy: { openedAt: 'desc' }, skip, take }),
      this.prisma.shift.count({ where }),
    ]);
    return { items: rows.map((s) => this.view(s)), total, skip, take };
  }

  async get(id: string, actor: BillingActor): Promise<ShiftView> {
    const shift = await this.prisma.shift.findFirst({ where: { id, shopId: actor.shopId, isDeleted: false }, include: SHIFT_INCLUDE });
    if (!shift) throw new NotFoundException({ message: 'Shift not found.', code: 'SHIFT_NOT_FOUND' });
    if (shift.openedById !== actor.userId && !isManager(actor.role)) {
      throw new ForbiddenException({ message: 'You can only view your own shifts.', code: 'SHIFT_FORBIDDEN' });
    }
    return this.view(shift);
  }
}
