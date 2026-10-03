import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';

/**
 * POS invoice / return numbering: the shared gapless `NumberSequenceService`
 * (one locked `NumberSequence` row per shop, entity type and prefix), with
 * the POS entity types pinned so a typo cannot open a second series.
 */
@Injectable()
export class InvoiceNumberService {
  constructor(private readonly sequences: NumberSequenceService) {}

  next(tx: Prisma.TransactionClient, shopId: string, entityType: 'POS_INVOICE' | 'POS_RETURN', prefix: string, pad = 6): Promise<{ number: string; sequence: number }> {
    return this.sequences.next(tx, shopId, entityType, prefix, pad);
  }
}
