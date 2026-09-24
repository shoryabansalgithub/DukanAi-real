import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Gapless, concurrency-safe document numbering inside the caller's
 * transaction. One `NumberSequence` row per (shop, entityType, prefix) is
 * locked with `SELECT ... FOR UPDATE`, so two concurrent invoices can never
 * observe the same last number, including the first document of a period
 * (the row is upserted before it is locked).
 */
@Injectable()
export class InvoiceNumberService {
  async next(
    tx: Prisma.TransactionClient,
    shopId: string,
    entityType: 'POS_INVOICE' | 'POS_RETURN',
    prefix: string,
    pad = 6,
  ): Promise<{ number: string; sequence: number }> {
    await tx.$executeRaw`
      INSERT INTO NumberSequence (id, shopId, entityType, prefix, lastNumber, updatedAt)
      VALUES (${`${shopId}:${entityType}:${prefix}`.slice(0, 191)}, ${shopId}, ${entityType}, ${prefix}, 0, NOW(3))
      ON DUPLICATE KEY UPDATE lastNumber = lastNumber
    `;

    const rows = await tx.$queryRaw<Array<{ id: string; lastNumber: number }>>`
      SELECT id, lastNumber FROM NumberSequence
      WHERE shopId = ${shopId} AND entityType = ${entityType} AND prefix = ${prefix}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new InternalServerErrorException('Failed to acquire the invoice number sequence lock');
    }

    const sequence = Number(rows[0].lastNumber) + 1;
    await tx.$executeRaw`UPDATE NumberSequence SET lastNumber = ${sequence}, updatedAt = NOW(3) WHERE id = ${rows[0].id}`;

    return { number: `${prefix}${String(sequence).padStart(pad, '0')}`, sequence };
  }
}
