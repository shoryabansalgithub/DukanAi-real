import { Controller, Get, Post, Body } from '@nestjs/common';
import { ProductEventReplayService } from '../../services/event-replay.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CurrentShop } from '../../../iam/decorators';
import { EventsFeatureConfig } from '../../../config/domains/features/events-feature.config';
import { MANAGEMENT_ROLES } from '../../../auth/role-sets';
import { Roles } from '../../../auth/roles.decorator';
import { ReplayEventDto } from '../../dto/replay-event.dto';

/** Product event log and replay (roadmap 4.1): the shop comes from the verified session. */
@Controller('events')
export class ProductEventsController {
  constructor(
    private readonly eventReplay: ProductEventReplayService,
    private readonly prisma: PrismaService,
    private readonly eventsFeatureConfig: EventsFeatureConfig,
  ) {}

  @Get()
  async getEvents(@CurrentShop() shopId: string) {
    return this.prisma.productEventLog.findMany({
      where: { shopId },
      orderBy: { timestamp: 'desc' },
      take: this.eventsFeatureConfig.recentEventsLimit,
    });
  }

  @Get('metrics')
  async getMetrics(@CurrentShop() shopId: string) {
    return this.eventReplay.getMetrics(shopId);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('replay')
  async replayEvent(@Body() body: ReplayEventDto, @CurrentShop() shopId: string) {
    await this.eventReplay.replayEvent(body.eventId, shopId);
    return { message: `Replay queued for event ${body.eventId}` };
  }
}
