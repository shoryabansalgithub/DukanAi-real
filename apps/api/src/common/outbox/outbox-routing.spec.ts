import {
  DOMAIN_RELAY_TYPE_PREFIXES,
  PURCHASE_RELAY_TYPE_PREFIXES,
  buildPurchaseEventsTypePredicate,
  buildSystemEventJob,
  buildSystemEventsTypePredicate,
  isDomainRelayOwnedType,
  isPurchaseRelayType,
  parseOutboxPayload,
} from './outbox-routing';

describe('outbox routing', () => {
  describe('purchase relay family (roadmap 4.2)', () => {
    it('owns every event the procurement repositories publish and nothing of the sales or POS families', () => {
      for (const type of ['PurchaseOrderApproved', 'GRNCompleted', 'VendorBillPaid', 'SupplierCreditAllocated', 'GoodsAccepted', 'InspectionCompleted', 'OutstandingReduced']) {
        expect(isPurchaseRelayType(type)).toBe(true);
        expect(isDomainRelayOwnedType(type)).toBe(true);
      }
      for (const type of ['InvoiceIssued', 'ReturnCreated', 'INVOICE_CREATED', 'CUSTOMER_PAYMENT_RECORDED']) {
        expect(isPurchaseRelayType(type)).toBe(false);
      }
    });

    it('emits one parameterised LIKE BINARY clause per prefix, OR-ed', () => {
      const predicate = buildPurchaseEventsTypePredicate();
      expect(predicate.sql.match(/type LIKE BINARY \?/g)).toHaveLength(PURCHASE_RELAY_TYPE_PREFIXES.length);
      expect(predicate.sql).toContain(' OR ');
      expect(predicate.sql).not.toContain('NOT LIKE');
      expect(predicate.values).toEqual(PURCHASE_RELAY_TYPE_PREFIXES.map((p) => `${p}%`));
    });
  });

  describe('isDomainRelayOwnedType', () => {
    it('routes SCREAMING_CASE POS events to the system-events relay', () => {
      for (const type of ['INVOICE_CREATED', 'INVOICE_RETURNED', 'INVOICE_CANCELLED', 'CUSTOMER_PAYMENT_RECORDED', 'BILL_SCANNED']) {
        expect(isDomainRelayOwnedType(type)).toBe(false);
      }
    });

    it('leaves PascalCase domain events to their domain relays', () => {
      for (const prefix of DOMAIN_RELAY_TYPE_PREFIXES) {
        expect(isDomainRelayOwnedType(`${prefix}Created`)).toBe(true);
      }
      // The sales family has no relay any more (roadmap 4.7): its stray rows reach the system-events worker.
      expect(isDomainRelayOwnedType('InvoiceIssued')).toBe(false);
      expect(isDomainRelayOwnedType('OrderConfirmed')).toBe(false);
      expect(isDomainRelayOwnedType('ProductCreated')).toBe(true);
      expect(isDomainRelayOwnedType('InventoryReversed')).toBe(true);
    });
  });

  describe('buildSystemEventsTypePredicate', () => {
    it('emits one case-sensitive NOT LIKE BINARY clause per domain prefix, parameterised', () => {
      const predicate = buildSystemEventsTypePredicate();
      const clauses = predicate.sql.match(/type NOT LIKE BINARY \?/g) ?? [];
      expect(clauses).toHaveLength(DOMAIN_RELAY_TYPE_PREFIXES.length);
      expect(predicate.sql.startsWith('(')).toBe(true);
      expect(predicate.sql.trimEnd().endsWith(')')).toBe(true);
      expect(predicate.sql).not.toMatch(/ LIKE '/);
      expect(predicate.values).toEqual(DOMAIN_RELAY_TYPE_PREFIXES.map((p) => `${p}%`));
    });
  });

  describe('parseOutboxPayload', () => {
    it('accepts objects, parses JSON strings and rejects everything else', () => {
      expect(parseOutboxPayload({ a: 1 })).toEqual({ a: 1 });
      expect(parseOutboxPayload('{"a":1}')).toEqual({ a: 1 });
      expect(parseOutboxPayload('not json')).toEqual({});
      expect(parseOutboxPayload(null)).toEqual({});
      expect(parseOutboxPayload([1, 2])).toEqual({});
    });
  });

  describe('buildSystemEventJob', () => {
    it('puts shopId from the row column at the top level and uses the row id as jobId', () => {
      const job = buildSystemEventJob({
        id: 'evt-1',
        shopId: 'shop-1',
        type: 'INVOICE_CREATED',
        payload: { shopId: 'shop-1', userId: 'user-1', correlationId: 'corr-1', invoiceId: 'inv-1' },
        correlationId: null,
        actorId: null,
      });
      expect(job).toEqual({
        name: 'INVOICE_CREATED',
        data: {
          eventId: 'evt-1',
          correlationId: 'corr-1',
          shopId: 'shop-1',
          userId: 'user-1',
          payload: { shopId: 'shop-1', userId: 'user-1', correlationId: 'corr-1', invoiceId: 'inv-1' },
        },
        opts: { jobId: 'evt-1' },
      });
    });

    it('falls back to payload.shopId, the actorId column and the legacy correlation id', () => {
      const job = buildSystemEventJob({
        id: 'evt-2',
        shopId: null,
        type: 'CUSTOMER_PAYMENT_RECORDED',
        payload: JSON.stringify({ shopId: 'shop-2', customerId: 'c-1' }),
        correlationId: null,
        actorId: 'actor-1',
      });
      expect(job.data.shopId).toBe('shop-2');
      expect(job.data.userId).toBe('actor-1');
      expect(job.data.correlationId).toBe('legacy-event');
      expect(job.data.payload).toEqual({ shopId: 'shop-2', customerId: 'c-1' });
    });

    it('leaves shopId undefined when neither the column nor the payload carries one', () => {
      const job = buildSystemEventJob({ id: 'evt-3', shopId: null, type: 'X', payload: {}, correlationId: 'c', actorId: null });
      expect(job.data.shopId).toBeUndefined();
      expect(job.data.userId).toBeUndefined();
    });
  });
});
