import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerCalculationService } from './services/ledger-calculation.service';
import { LedgerIntegrityService } from './services/ledger-integrity.service';
import { LedgerValidationService } from './services/ledger-validation.service';
import { StockLedgerController } from './stock-ledger.controller';

@Module({
  imports: [PrismaModule],
  controllers: [StockLedgerController],
  providers: [
    LedgerCalculationService,
    LedgerIntegrityService,
    LedgerValidationService
  ],
  exports: [
    LedgerCalculationService,
    LedgerIntegrityService,
    LedgerValidationService
  ]
})
export class StockLedgerModule {}
