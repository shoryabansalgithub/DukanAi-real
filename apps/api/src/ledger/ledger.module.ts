import { Global, Module } from '@nestjs/common';
import { LedgerPostingService } from './ledger-posting.service';

/**
 * Double-entry posting authority. Global so that every domain that moves money
 * or stock value (billing, customers, goods receipts, purchase returns,
 * inventory adjustments) posts through the same balanced, row-locked service.
 */
@Global()
@Module({
  providers: [LedgerPostingService],
  exports: [LedgerPostingService],
})
export class LedgerModule {}
