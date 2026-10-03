import { Controller, Get, Post, Delete, Param, Body, NotFoundException, BadRequestException, Query } from '@nestjs/common';
import { ListQueryDto, PagedList, pageArgs } from '../../../common/pagination';
import { OutboundUrlBlockedError, OutboundUrlGuard } from '../../../common/net/outbound-url-guard';
import { PrismaService } from '../../../prisma/prisma.service';
import { CurrentShop } from '../../../iam/decorators';
import { EventsFeatureConfig } from '../../../config/domains/features/events-feature.config';
import { MANAGEMENT_ROLES } from '../../../auth/role-sets';
import { Roles } from '../../../auth/roles.decorator';
import { randomBytes } from 'crypto';
import { CreateWebhookEndpointDto } from '../../dto/webhook-endpoint.dto';

/** Fields of an endpoint that may leave the API: never the signing secret. */
const ENDPOINT_SELECT = { id: true, shopId: true, url: true, events: true, description: true, isActive: true, createdAt: true, updatedAt: true } as const;

/**
 * Webhook endpoints (roadmap 4.1). Reads and writes are MANAGER+ (an
 * endpoint receives the shop's business events). The HMAC secret is shown
 * exactly once, in the create response, and only when the server generated
 * it; it is never returned by any later read.
 */
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsFeatureConfig: EventsFeatureConfig,
    private readonly urlGuard: OutboundUrlGuard,
  ) {}

  /**
   * Registration vets the URL the same way a delivery does (scheme, no
   * credentials, DNS-resolved public address; roadmap 4.8). The send-time
   * check remains authoritative: a host can change what it resolves to.
   */
  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createEndpoint(@Body() dto: CreateWebhookEndpointDto, @CurrentShop() shopId: string) {
    try {
      await this.urlGuard.resolve(dto.url, this.eventsFeatureConfig.webhookAllowHttp);
    } catch (error) {
      if (error instanceof OutboundUrlBlockedError) throw new BadRequestException({ message: error.message, code: error.code });
      throw error;
    }
    const generated = dto.secret === undefined;
    const secret = dto.secret ?? randomBytes(32).toString('hex');
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: { shopId, url: dto.url, secret, events: dto.events || ['*'], description: dto.description },
      select: ENDPOINT_SELECT,
    });
    return generated ? { ...endpoint, secret } : endpoint;
  }

  @Roles(...MANAGEMENT_ROLES)
  @Get()
  @PagedList()
  async getEndpoints(@CurrentShop() shopId: string, @Query() query: ListQueryDto) {
    const { skip, take } = pageArgs(query);
    const [items, total] = await Promise.all([
      this.prisma.webhookEndpoint.findMany({ where: { shopId }, select: ENDPOINT_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.webhookEndpoint.count({ where: { shopId } }),
    ]);
    return { items, total, skip, take };
  }

  @Roles(...MANAGEMENT_ROLES)
  @Get(':id/deliveries')
  async getDeliveries(@Param('id') id: string, @CurrentShop() shopId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({ where: { id, shopId }, select: { id: true } });
    if (!endpoint) throw new NotFoundException({ message: 'Webhook endpoint not found', code: 'WEBHOOK_NOT_FOUND' });
    return this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { createdAt: 'desc' },
      take: this.eventsFeatureConfig.webhookDeliveryLimit,
    });
  }

  @Roles(...MANAGEMENT_ROLES)
  @Delete(':id')
  async deleteEndpoint(@Param('id') id: string, @CurrentShop() shopId: string) {
    const deleted = await this.prisma.webhookEndpoint.deleteMany({ where: { id, shopId } });
    if (deleted.count === 0) throw new NotFoundException({ message: 'Webhook endpoint not found', code: 'WEBHOOK_NOT_FOUND' });
    return { deleted: true };
  }
}
