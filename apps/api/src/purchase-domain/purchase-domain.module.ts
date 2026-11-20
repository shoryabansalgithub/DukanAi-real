import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesEventsDomainModule } from '../sales-events-domain/sales-events-domain.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentModule } from '../common/document/document.module';
import { PurchaseNumberEngine } from './services/purchase-number-engine.service';
import { PurchaseLifecycleService } from './services/purchase-lifecycle.service';
import { PurchaseValidationService } from './services/purchase-validation.service';
import { PurchaseAuditService } from './services/purchase-audit.service';
import { PurchaseRepository } from './repositories/purchase.repository';
import { PurchaseDraftService } from './services/purchase-draft.service';
import { PurchaseApprovalService } from './services/purchase-approval.service';
import { PurchasePricingService } from './services/purchase-pricing.service';
import { PurchaseTaxService } from './services/purchase-tax.service';
import { PurchaseController } from './purchase.controller';
import { PurchaseReceiptService } from './services/purchase-receipt.service';

@Module({
  imports: [
    PrismaModule,
    SalesEventsDomainModule,
    StorageModule,
    DocumentModule
  ],
  controllers: [PurchaseController],
  providers: [
    PurchaseNumberEngine,
    PurchaseLifecycleService,
    PurchaseValidationService,
    PurchaseAuditService,
    PurchaseDraftService,
    PurchaseApprovalService,
    PurchasePricingService,
    PurchaseTaxService,
    PurchaseReceiptService,
    PurchaseRepository
  ],
  exports: [PurchaseRepository, PurchaseReceiptService, PurchaseLifecycleService]
})
export class PurchaseDomainModule {}
