import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingHelpers } from './billing.helpers';
import { BillingController } from './billing.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryDomainModule } from '../inventory-domain/inventory-domain.module';
import { InvoiceNumberService } from './services/invoice-number.service';
import { InvoiceReversalService } from './services/invoice-reversal.service';
import { InvoiceQueryService } from './services/invoice-query.service';
import { BillingCheckpoints } from './billing-checkpoints';

@Module({
  imports: [InventoryModule, InventoryDomainModule],
  controllers: [BillingController],
  providers: [BillingService, BillingHelpers, BillingCheckpoints, InvoiceNumberService, InvoiceReversalService, InvoiceQueryService],
  exports: [BillingService, BillingHelpers, BillingCheckpoints, InvoiceNumberService, InvoiceReversalService, InvoiceQueryService],
})
export class BillingModule {}
