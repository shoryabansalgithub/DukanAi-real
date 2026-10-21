import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesEventsDomainModule } from '../sales-events-domain/sales-events-domain.module';
import { StockLedgerModule } from '../stock-ledger-domain/stock-ledger.module';
import { ProductEventsModule } from '../product-events/product-events.module';

import { GrnController } from './grn.controller';
import { GrnRepository } from './repositories/grn.repository';
import { GrnLifecycleService } from './services/grn-lifecycle.service';
import { GrnApprovalService } from './services/grn-approval.service';
import { GrnInspectionService } from './services/grn-inspection.service';
import { GrnVarianceService } from './services/grn-variance.service';
import { GrnIntegrationService } from './services/grn-integration.service';
import { PurchaseEventsDomainModule } from '../purchase-events-domain/purchase-events-domain.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentModule } from '../common/document/document.module';
import { InventoryDomainModule } from '../inventory-domain/inventory-domain.module';
import { PurchaseDomainModule } from '../purchase-domain/purchase-domain.module';

@Module({
  imports: [
    PrismaModule,
    SalesEventsDomainModule,
    StockLedgerModule,
    ProductEventsModule,
    PurchaseEventsDomainModule,
    StorageModule,
    DocumentModule,
    InventoryDomainModule,
    PurchaseDomainModule
  ],
  controllers: [GrnController],
  providers: [
    GrnRepository,
    GrnLifecycleService,
    GrnApprovalService,
    GrnInspectionService,
    GrnVarianceService,
    GrnIntegrationService
  ],
  exports: [GrnRepository]
})
export class GrnDomainModule {}
