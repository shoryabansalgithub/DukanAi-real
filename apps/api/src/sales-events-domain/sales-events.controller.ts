import { Controller, Get, Post, Param, Body, UseGuards, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../iam/guards/tenant.guard';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SalesFeatureConfig } from '../config/domains/features/sales-feature.config';
import { SALES_EVENT_JOB_ID_PREFIX } from './workers/sales-outbox-relay.cron';

@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('sales/events')
export class SalesEventsController {
  private readonly logger = new Logger(SalesEventsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesFeatureConfig: SalesFeatureConfig,
    @InjectQueue('sales-events') private readonly salesEventsQueue: Queue
  ) {}

  @Get()
  async getEvents(@CurrentShop() shopId: string) {
    return this.prisma.outboxEvent.findMany({
      where: { shopId, type: { startsWith: 'Order' } }, // Simple filter for demo
      orderBy: { createdAt: 'desc' },
      take: this.salesFeatureConfig.recentEventsLimit
    });
  }

  @Get(':id')
  async getEventById(@CurrentShop() shopId: string, @Param('id') id: string) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id }
    });

    if (!event || event.shopId !== shopId) {
      throw new NotFoundException('Event not found');
    }

    return event;
  }

  /**
   * Re-queues an event by flipping the row back to PENDING. The relay cron then
   * re-enqueues it under its deterministic jobId, so exactly one job exists per
   * event. A stale BullMQ job under that id (failed, or completed and retained)
   * would make the relay's addBulk a silent no-op, so it is removed first.
   */
  @Post('retry')
  async retryEvent(@CurrentShop() shopId: string, @Body('eventId') eventId: string) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId }
    });

    if (!event || event.shopId !== shopId) {
      throw new NotFoundException('Event not found');
    }

    if (event.status === 'DONE') {
      throw new BadRequestException('Event is already processed successfully.');
    }

    const jobId = `${SALES_EVENT_JOB_ID_PREFIX}${event.id}`;
    try {
      const removed = await this.salesEventsQueue.remove(jobId);
      if (removed) {
        this.logger.debug(`Removed stale BullMQ job ${jobId} before retry`);
      }
    } catch (error: any) {
      // Best-effort: an active job cannot be removed; the relay will then skip the duplicate.
      this.logger.warn(`Could not remove BullMQ job ${jobId} before retry: ${error.message}`);
    }

    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: { status: 'PENDING', error: null, retryCount: 0 }
    });

    return { message: 'Event reset to PENDING; the relay will re-enqueue it.' };
  }

  @Get('status/queue')
  async getQueueStatus() {
    const waiting = await this.salesEventsQueue.getWaitingCount();
    const active = await this.salesEventsQueue.getActiveCount();
    const failed = await this.salesEventsQueue.getFailedCount();

    return {
      queue: 'sales-events',
      metrics: { waiting, active, failed }
    };
  }
}
