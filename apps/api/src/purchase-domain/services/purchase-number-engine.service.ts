import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';
import { Clock } from '../../common/time/clock';
import { toZonedParts } from '../../common/time/business-day';
import { shopTimeZone } from '../procurement-support';

/**
 * Purchase-order numbers `PO-YYYYMM-00001` from the shared gapless
 * `NumberSequence` row (roadmap 4.2). The former max+1 scan had no lock and
 * relied on SERIALIZABLE isolation to avoid duplicates. The month is the
 * shop's (ShopSettings.timezone) on the application clock, not the server's
 * UTC month (release audit #26).
 */
@Injectable()
export class PurchaseNumberEngine {
  constructor(
    private readonly sequences: NumberSequenceService,
    private readonly clock: Clock,
  ) {}

  async generateNextOrderNumber(tx: Prisma.TransactionClient, shopId: string, prefix = 'PO'): Promise<string> {
    const { year, month } = toZonedParts(this.clock.now(), await shopTimeZone(tx, shopId));
    const period = `${year}${String(month).padStart(2, '0')}`;
    const { number } = await this.sequences.next(tx, shopId, 'PURCHASE_ORDER', `${prefix}-${period}-`, 5);
    return number;
  }
}
