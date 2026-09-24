import { Prisma } from '@prisma/client';

/**
 * OutboxEvent.type prefixes owned by a domain relay:
 *  - sales-events-domain    : Order*, Invoice*, Payment*, Return*, Exchange*
 *  - purchase-events-domain : Purchase*, GRN*, VendorBill*, SupplierCredit*
 *  - product-events         : Product*, Inventory*, Category*, Brand*
 *
 * The system-events relay (common/outbox) owns everything else, notably the
 * SCREAMING_CASE POS/billing events of docs/POS_BILLING_CONTRACT.md §7
 * (INVOICE_CREATED, INVOICE_RETURNED, INVOICE_CANCELLED, CUSTOMER_PAYMENT_RECORDED).
 *
 * Matching is case-sensitive on purpose: 'Invoice%' (PascalCase) are the
 * EnterpriseInvoice domain events while 'INVOICE_%' are POS events. MySQL LIKE
 * is case-insensitive, so every relay predicate must use LIKE BINARY.
 */
export const DOMAIN_RELAY_TYPE_PREFIXES: readonly string[] = Object.freeze([
  'Order',
  'Invoice',
  'Payment',
  'Return',
  'Exchange',
  'Purchase',
  'GRN',
  'VendorBill',
  'SupplierCredit',
  'Product',
  'Inventory',
  'Category',
  'Brand',
]);

/** TypeScript mirror of the SQL predicate (case-sensitive prefix match). */
export function isDomainRelayOwnedType(type: string): boolean {
  return DOMAIN_RELAY_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Builds the parameterised fragment
 * `(type NOT LIKE BINARY 'Order%' AND type NOT LIKE BINARY 'Invoice%' AND ...)`
 * used by the system-events relay so it never picks up domain-relay rows.
 */
export function buildSystemEventsTypePredicate(
  prefixes: readonly string[] = DOMAIN_RELAY_TYPE_PREFIXES,
): Prisma.Sql {
  const clauses = prefixes.map((prefix) => Prisma.sql`type NOT LIKE BINARY ${`${prefix}%`}`);
  return Prisma.join(clauses, ' AND ', '(', ')');
}

/** Row shape selected by the system-events relay. */
export interface OutboxRelayRow {
  id: string;
  shopId: string | null;
  type: string;
  payload: unknown;
  correlationId: string | null;
  actorId: string | null;
}

/** Job data contract of the `system-events` queue: shopId lives at the top level. */
export interface SystemEventJobData {
  eventId: string;
  correlationId: string;
  shopId?: string;
  userId?: string;
  payload: Record<string, unknown>;
}

export const LEGACY_CORRELATION_ID = 'legacy-event';

/** MySQL JSON columns come back parsed from $queryRaw, but tolerate strings and garbage. */
export function parseOutboxPayload(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Pure mapping from an OutboxEvent row to a BullMQ job (jobId = row id for exactly-once enqueue). */
export function buildSystemEventJob(row: OutboxRelayRow): {
  name: string;
  data: SystemEventJobData;
  opts: { jobId: string };
} {
  const payload = parseOutboxPayload(row.payload);
  return {
    name: row.type,
    data: {
      eventId: row.id,
      correlationId:
        asOptionalString(row.correlationId) ??
        asOptionalString(payload.correlationId) ??
        LEGACY_CORRELATION_ID,
      shopId: asOptionalString(row.shopId) ?? asOptionalString(payload.shopId),
      userId: asOptionalString(payload.userId) ?? asOptionalString(row.actorId),
      payload,
    },
    opts: { jobId: row.id },
  };
}
