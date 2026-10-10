import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';

/**
 * Purchase-order numbers `PO-YYYYMM-00001` from the shared gapless
 * `NumberSequence` row (roadmap 4.2). The former max+1 scan had no lock and
 * relied on SERIALIZABLE isolation to avoid duplicates.
 */
@Injectable()
export class PurchaseNumberEngine {
  constructor(private readonly sequences: NumberSequenceService) {}

  async generateNextOrderNumber(tx: Prisma.TransactionClient, shopId: string, prefix = 'PO'): Promise<string> {
    const today = new Date();
    const period = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
    const { number } = await this.sequences.next(tx, shopId, 'PURCHASE_ORDER', `${prefix}-${period}-`, 5);
    return number;
  }
}
