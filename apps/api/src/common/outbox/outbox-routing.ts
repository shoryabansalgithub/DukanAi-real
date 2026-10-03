import { Prisma } from '@prisma/client';

/**
 * OutboxEvent.type prefixes owned by the purchase-events relay (roadmap 4.2):
 * every event the procurement repositories publish. `Goods*` (GoodsAccepted),
 * `Inspection*` and `Outstanding*` (OutstandingReduced) are procurement
 * document events too; before they were listed here no relay ever picked
 * them up and the rows stayed PENDING for good.
 */
export const PURCHASE_RELAY_TYPE_PREFIXES: readonly string[] = Object.freeze([
  'Purchase',
  'GRN',
  'VendorBill',
  'SupplierCredit',
  'Goods',
  'Inspection',
  'Outstanding',
]);

/** OutboxEvent.type prefixes owned by the product-events relay (`OutboxProcessorWorker`). */
export const PRODUCT_RELAY_TYPE_PREFIXES: readonly string[] = Object.freeze(['Product', 'Inventory', 'Category', 'Brand']);

/**
 * OutboxEvent.type prefixes owned by a domain relay:
 *  - purchase-events-domain : PURCHASE_RELAY_TYPE_PREFIXES above
 *  - product-events         : PRODUCT_RELAY_TYPE_PREFIXES above
 *
 * The system-events relay (common/outbox) owns everything else, notably the
 * SCREAMING_CASE POS/billing events of docs/POS_BILLING_CONTRACT.md §7
 * (INVOICE_CREATED, INVOICE_RETURNED, INVOICE_CANCELLED, CUSTOMER_PAYMENT_RECORDED).
 * The former sales relay (Order*, Invoice*, Payment*, Return*, Exchange*) is
 * gone with the stacks that staged those types (roadmap 4.5, 4.7): a stray
 * row of such a type now reaches the system-events worker, which records it
 * as ignored-unknown instead of leaving it PENDING forever.
 *
 * Matching is case-sensitive on purpose: 'Invoice%' (PascalCase) were the
 * EnterpriseInvoice domain events while 'INVOICE_%' are POS events. MySQL LIKE
 * is case-insensitive, so every relay predicate must use LIKE BINARY.
 */
export const DOMAIN_RELAY_TYPE_PREFIXES: readonly string[] = Object.freeze([...PURCHASE_RELAY_TYPE_PREFIXES, ...PRODUCT_RELAY_TYPE_PREFIXES]);

/** TypeScript mirror of the SQL predicate (case-sensitive prefix match). */
export function isDomainRelayOwnedType(type: string): boolean {
  return DOMAIN_RELAY_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** True when the purchase-events relay owns rows of this type. */
export function isPurchaseRelayType(type: string): boolean {
  return PURCHASE_RELAY_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** `(type LIKE BINARY 'Purchase%' OR type LIKE BINARY 'GRN%' OR ...)` for the purchase-events relay. */
export function buildPurchaseEventsTypePredicate(prefixes: readonly string[] = PURCHASE_RELAY_TYPE_PREFIXES): Prisma.Sql {
  return buildOwnedTypePredicate(prefixes);
}

/** `(type LIKE BINARY 'Product%' OR ...)` for the product-events relay. */
export function buildProductEventsTypePredicate(prefixes: readonly string[] = PRODUCT_RELAY_TYPE_PREFIXES): Prisma.Sql {
  return buildOwnedTypePredicate(prefixes);
}

function buildOwnedTypePredicate(prefixes: readonly string[]): Prisma.Sql {
  const clauses = prefixes.map((prefix) => Prisma.sql`type LIKE BINARY ${`${prefix}%`}`);
  return Prisma.join(clauses, ' OR ', '(', ')');
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
