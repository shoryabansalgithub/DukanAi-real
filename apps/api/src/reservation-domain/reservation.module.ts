import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ReservationService } from './services/reservation.service';
import { AllocationService } from './services/allocation.service';
import { ReservationValidationService } from './services/reservation-validation.service';
import { ReservationExpiryService } from './services/reservation-expiry.service';
import { ReservationExpirySweepScheduler } from './services/reservation-expiry-sweep.scheduler';
import { ReservationController } from './reservation.controller';
import { InventoryDomainModule } from '../inventory-domain/inventory-domain.module';

@Module({
  imports: [PrismaModule, InventoryDomainModule],
  controllers: [ReservationController],
  providers: [
    ReservationService,
    AllocationService,
    ReservationValidationService,
    ReservationExpiryService,
    ReservationExpirySweepScheduler
  ],
  exports: [
    ReservationService,
    AllocationService
  ]
})
export class ReservationModule {}
