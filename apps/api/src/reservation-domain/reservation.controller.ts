import { Controller, Post, Body, Param } from '@nestjs/common';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { ReservationService } from './services/reservation.service';
import { ReservationExpiryService } from './services/reservation-expiry.service';
import { CreateReservationDto } from './dto/reservation.dto';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { ADMIN_ROLES, MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';

@Controller('reservations')
export class ReservationController {
  constructor(
    private readonly reservationService: ReservationService,
    private readonly expiryService: ReservationExpiryService,
    private readonly tenantContext: TenantContextService
  ) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createReservation(@Body() dto: CreateReservationDto) {
    const shopId = this.tenantContext.getShopId();
    return this.reservationService.createReservation(shopId, dto);
  }

  /** Abandons an active reservation and frees its stock (roadmap 3.8). */
  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/cancel')
  async cancelReservation(@Param('id') id: string, @CurrentUser() user: SafeUserDto) {
    return this.expiryService.releaseReservation(this.tenantContext.getShopId(), id, 'CANCELLED', user.id);
  }

  /** Releases the hold of an active reservation without cancelling the business intent. */
  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/release')
  async releaseReservation(@Param('id') id: string, @CurrentUser() user: SafeUserDto) {
    return this.expiryService.releaseReservation(this.tenantContext.getShopId(), id, 'RELEASED', user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Post('sweep')
  async runExpirySweep() {
    // Sweeps the caller's shop only; the global sweep is the locked cron (ReservationExpirySweepScheduler).
    const count = await this.expiryService.releaseExpiredReservations(this.tenantContext.getShopId());
    return { status: 'SUCCESS', releasedCount: count };
  }
}
