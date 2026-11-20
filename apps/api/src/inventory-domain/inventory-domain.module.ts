import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductEventsModule } from '../product-events/product-events.module';
import { InventoryDomainService } from './services/inventory-domain.service';
import { InventoryValidationService } from './services/inventory-validation.service';
import { InventoryCalculationService } from './services/inventory-calculation.service';
import { InventoryMutationEngine } from './services/inventory-mutation.engine';
import { InventoryLocationService } from './services/inventory-location.service';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryDomainController } from './inventory-domain.controller';

@Module({
  imports: [PrismaModule, ProductEventsModule, InventoryModule],
  controllers: [InventoryDomainController],
  providers: [
    InventoryDomainService,
    InventoryValidationService,
    InventoryCalculationService,
    InventoryMutationEngine,
    InventoryLocationService,
  ],
  exports: [InventoryDomainService, InventoryCalculationService, InventoryMutationEngine, InventoryLocationService],
})
export class InventoryDomainModule {}
