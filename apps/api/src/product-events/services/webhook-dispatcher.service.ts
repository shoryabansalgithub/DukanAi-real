import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';
import { OutboundUrlBlockedError, OutboundUrlGuard } from '../../common/net/outbound-url-guard';
import { WebhookHttpClient } from './webhook-http-client';

/** OutboxEvent.error / WebhookDelivery.errorMessage are bounded; keep messages short. */
const MAX_ERROR_LENGTH = 500;
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/**
 * Signs a webhook body the way receivers must verify it: HMAC-SHA256 over
 * `<unix ms timestamp>.<body>`, presented as `t=<timestamp>,v1=<hex>`. The
 * timestamp in the signature defeats replay of a captured delivery.
 */
export function signWebhookPayload(secret: string, timestampMs: number, body: string): string {
  const digest = crypto.createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
  return `t=${timestampMs},${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

/**
 * The one webhook delivery implementation (roadmap 4.8, audit P2-18): every
 * queue that delivers webhooks (`webhook-delivery`) ends here. The target is
 * vetted and DNS-resolved at send time, the connection is pinned to that
 * address, redirects are not followed, the signature is timestamped, and
 * every attempt is recorded as a WebhookDelivery row. A blocked target is a
 * permanent failure (no retry); an unreachable or non-2xx endpoint is a
 * retryable one.
 */
@Injectable()
export class ProductWebhookDispatcherService {
  private readonly logger = new Logger(ProductWebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsConfig: EventsFeatureConfig,
    private readonly guard: OutboundUrlGuard,
    private readonly http: WebhookHttpClient,
  ) {}

  /**
   * Delivers one outbox event to one endpoint. Throws to trigger a BullMQ
   * retry; throws `UnrecoverableError` when a retry could never succeed.
   */
  async dispatch(endpointId: string, eventId: string, _payload: unknown, deliveryId?: string): Promise<void> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint || !endpoint.isActive) return; // Endpoint was deleted or disabled

    const event = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!event) return;

    const envelope = {
      eventId: event.id,
      eventType: event.type,
      tenantId: event.tenantId,
      shopId: event.shopId,
      entityId: event.entityId,
      entityType: event.entityType,
      timestamp: event.createdAt,
      correlationId: event.correlationId,
      payload: event.payload,
    };
    const body = JSON.stringify(envelope);
    const timestampMs = Date.now();
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'DukanAI-Webhooks/1.0',
      'x-dukanai-timestamp': String(timestampMs),
      'x-dukanai-signature': signWebhookPayload(endpoint.secret, timestampMs, body),
      'x-dukanai-event': event.type,
      'x-dukanai-delivery': deliveryId ?? `${endpoint.id}-${event.id}`,
    };

    const startedAt = Date.now();
    const record = async (status: 'SUCCESS' | 'FAILED', statusCode: number | null, errorMessage?: string) => {
      await this.prisma.webhookDelivery.create({
        data: { endpointId: endpoint.id, eventId, eventType: event.type, payload: envelope, status, statusCode, errorMessage: errorMessage?.slice(0, MAX_ERROR_LENGTH), latencyMs: Date.now() - startedAt },
      });
    };

    let target;
    try {
      target = await this.guard.resolve(endpoint.url, this.eventsConfig.webhookAllowHttp);
    } catch (error) {
      const message = error instanceof OutboundUrlBlockedError ? `${error.code}: ${error.message}` : (error as Error).message;
      await record('FAILED', null, message);
      this.logger.warn(`Webhook ${endpoint.id} for event ${eventId} blocked: ${message}`);
      throw new UnrecoverableError(`Webhook target blocked: ${message}`);
    }

    try {
      const response = await this.http.post({ target, body, headers, timeoutMs: this.eventsConfig.webhookTimeoutMs, maxResponseBytes: this.eventsConfig.webhookMaxResponseBytes });
      await record('SUCCESS', response.status);
    } catch (err: unknown) {
      const statusCode = (err as { response?: { status?: number } })?.response?.status ?? null;
      const message = (err as Error)?.message || 'Unknown error';
      await record('FAILED', statusCode, message);
      this.logger.error(`Webhook delivery to endpoint ${endpoint.id} failed (${statusCode ?? 'no response'}): ${message}`);
      throw new Error(`Webhook Delivery Failed: ${message}`);
    }
  }
}
