import { Module } from '@nestjs/common';
import { ProductIdentityService } from './product-identity.service';
import { ProductIdentityController } from './product-identity.controller';
import { Gs1EngineService } from './gs1-engine.service';
import { BarcodeGeneratorService } from './barcode-generator.service';
import { IdentityAuditService } from './identity-audit.service';
import { PrintingEngineService } from './printing-engine.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * The `barcode-bulk` worker is no longer registered (roadmap 4.6): no route
 * or service ever enqueued a job for it, so it was a consumer with no producer.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProductIdentityController],
  providers: [
    ProductIdentityService,
    Gs1EngineService,
    BarcodeGeneratorService,
    IdentityAuditService,
    PrintingEngineService,
  ],
  exports: [ProductIdentityService],
})
export class ProductIdentityModule {}
