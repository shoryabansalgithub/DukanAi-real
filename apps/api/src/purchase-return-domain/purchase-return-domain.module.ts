import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesEventsDomainModule } from '../sales-events-domain/sales-events-domain.module';
import { StockLedgerModule } from '../stock-ledger-domain/stock-ledger.module';
import { ProductEventsModule } from '../product-events/product-events.module';

import { PurchaseReturnController } from './purchase-return.controller';
import { PurchaseReturnRepository } from './repositories/purchase-return.repository';
import { PurchaseReturnLifecycleService } from './services/purchase-return-lifecycle.service';
import { PurchaseReturnValidationService } from './services/purchase-return-validation.service';
import { PurchaseReturnInventoryService } from './services/purchase-return-inventory.service';
import { PurchaseReturnFinancialService } from './services/purchase-return-financial.service';
import { PurchaseReturnShipmentService } from './services/purchase-return-shipment.service';
import { PurchaseReturnApprovalService } from './services/purchase-return-approval.service';
import { PurchaseReturnReplacementService } from './services/purchase-return-replacement.service';
import { PurchaseEventsDomainModule } from '../purchase-events-domain/purchase-events-domain.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentModule } from '../common/document/document.module';
import { InventoryDomainModule } from '../inventory-domain/inventory-domain.module';

@Module({
  imports: [
    PrismaModule, 
    SalesEventsDomainModule,
    StockLedgerModule,
    ProductEventsModule,
    PurchaseEventsDomainModule,
    StorageModule,
    DocumentModule,
    InventoryDomainModule
  ],
  controllers: [PurchaseReturnController],
  providers: [
    PurchaseReturnRepository,
    PurchaseReturnLifecycleService,
    PurchaseReturnValidationService,
    PurchaseReturnInventoryService,
    PurchaseReturnFinancialService,
    PurchaseReturnShipmentService,
    PurchaseReturnApprovalService,
    PurchaseReturnReplacementService
  ],
  exports: [PurchaseReturnRepository]
})
export class PurchaseReturnDomainModule {}
