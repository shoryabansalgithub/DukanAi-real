import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async logDeliverySuccess(shopId: string, outboxEventId: string, consumerName: string, latencyMs: number) {
    return this.prisma.purchaseEventDelivery.create({
      data: {
        shopId,
        outboxEventId,
        consumerName,
        status: 'SUCCESS',
        latencyMs
      }
    });
  }

  async logDeliveryFailure(shopId: string, outboxEventId: string, consumerName: string, error: string) {
    return this.prisma.purchaseEventDelivery.create({
      data: {
        shopId,
        outboxEventId,
        consumerName,
        status: 'FAILED',
        errorMessage: error
      }
    });
  }
  
  async logWebhookAttempt(shopId: string, outboxEventId: string, endpointUrl: string, httpStatus: number, payload: any, latencyMs: number, errorMessage?: string) {
    return this.prisma.purchaseWebhookDelivery.create({
       data: {
         shopId,
         outboxEventId,
         endpointUrl,
         httpStatus,
         requestPayload: payload,
         latencyMs,
         errorMessage
       }
    });
  }
}
