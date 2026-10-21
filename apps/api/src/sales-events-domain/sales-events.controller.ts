import { Controller, Get, Post, Param, Body, NotFoundException, ConflictException, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SalesFeatureConfig } from '../config/domains/features/sales-feature.config';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { OutboxClaimService } from '../common/outbox/outbox-claim.service';

export class RetryOutboxEventDto {
  @IsString()
  @MaxLength(64)
  eventId: string;
}

export class ListOutboxEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  status?: string;
}

/**
 * Operator view of a shop's outbox rows (roadmap 4.7): list, inspect and
 * retry. A retry only applies to a FAILED row and hands it back to whichever
 * relay owns its type under a fresh job id.
 */
@Controller('sales/events')
export class SalesEventsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salesFeatureConfig: SalesFeatureConfig,
    private readonly claims: OutboxClaimService,
  ) {}

  @Get()
  async getEvents(@CurrentShop() shopId: string, @Query() query: ListOutboxEventsQueryDto) {
    return this.prisma.outboxEvent.findMany({
      where: { shopId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: this.salesFeatureConfig.recentEventsLimit,
    });
  }

  @Get(':id')
  async getEventById(@CurrentShop() shopId: string, @Param('id') id: string) {
    const event = await this.prisma.outboxEvent.findFirst({ where: { id, shopId } });
    if (!event) throw new NotFoundException({ message: 'Event not found', code: 'OUTBOX_EVENT_NOT_FOUND' });
    return event;
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('retry')
  async retryEvent(@CurrentShop() shopId: string, @Body() body: RetryOutboxEventDto) {
    const event = await this.prisma.outboxEvent.findFirst({ where: { id: body.eventId, shopId }, select: { id: true, status: true } });
    if (!event) throw new NotFoundException({ message: 'Event not found', code: 'OUTBOX_EVENT_NOT_FOUND' });
    if (event.status !== 'FAILED') {
      throw new ConflictException({ message: `Only a FAILED event can be retried; this one is ${event.status}.`, code: 'OUTBOX_EVENT_NOT_FAILED', details: { status: event.status } });
    }
    const retried = await this.claims.retryFailed(shopId, event.id);
    if (!retried) throw new ConflictException({ message: 'The event changed state before it could be retried.', code: 'OUTBOX_EVENT_NOT_FAILED' });
    return { message: 'Event reset to PENDING; its relay will pick it up.' };
  }
}
