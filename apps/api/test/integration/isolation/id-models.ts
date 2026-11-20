import { Prisma } from '@prisma/client';

/**
 * Which model a route parameter or a body field names, for the cross-shop
 * suite: the attacker's request carries its own row of that model in every
 * place but the one under attack, which gets the victim's.
 *
 * A name not listed here still gets attacked: the suite tries one victim row
 * of every model there (`undefined` = "unknown, brute force").
 */

const MODELS = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));

/** A path parameter or body field that is not a row at all. */
export const NOT_A_ROW = new Set(['kind', 'billId', 'correlationId', 'code', 'entityId', 'referenceId', 'serialId', 'departmentId']);

const FIELD_MODELS: Record<string, string> = {
  variantId: 'ProductVariant',
  binId: 'Location',
  locationId: 'Location',
  fromLocationId: 'Location',
  toLocationId: 'Location',
  userId: 'User',
  assignedToUserId: 'User',
  delegateUserId: 'User',
  approverId: 'User',
  newOwnerId: 'User',
  grnLineId: 'GoodsReceiptLine',
  purchaseOrderLineId: 'PurchaseOrderItem',
  purchaseOrderItemId: 'PurchaseOrderItem',
  countItemId: 'StockCountItem',
  invoiceItemId: 'InvoiceItem',
  assetId: 'MediaAsset',
  eventId: 'OutboxEvent',
  aggregateId: 'PurchaseOrder',
  referenceIds: 'MediaReference',
  revId: 'ProductRevision',
  revA: 'ProductRevision',
  revB: 'ProductRevision',
  sessionId: 'StockCountSession',
  taskId: 'WorkflowTask',
};

/** The model the `:id` after a path segment names. */
const SEGMENT_MODELS: Record<string, string> = {
  categories: 'Category',
  customers: 'Customer',
  expenses: 'Expense',
  invitations: 'Invitation',
  products: 'Product',
  product: 'Product',
  variant: 'ProductVariant',
  variants: 'ProductVariant',
  suppliers: 'Supplier',
  users: 'User',
  webhooks: 'WebhookEndpoint',
  invoices: 'Invoice',
  grn: 'GoodsReceipt',
  jobs: 'ImportJob',
  'inventory-domain': 'InventoryItem',
  assets: 'MediaAsset',
  'purchase-returns': 'PurchaseReturn',
  purchases: 'PurchaseOrder',
  runs: 'ReconciliationRun',
  events: 'OutboxEvent',
  shifts: 'Shift',
  'supplier-credit-notes': 'SupplierCreditNote',
  'vendor-bills': 'VendorBill',
  warehouses: 'Warehouse',
  notifications: 'Notification',
  reservations: 'StockReservation',
  adjustments: 'AdjustmentRequest',
  retry: 'PurchaseDeadLetter',
  sessions: 'RefreshToken',
};

/** The model a body field names (`items.0.productId` -> Product), or undefined when unknown. */
export function modelOfField(field: string, routePath = ''): string | undefined {
  const name = field.split('.').pop() ?? field;
  if (NOT_A_ROW.has(name)) return undefined;
  if (name === 'parentId') return routePath.includes('categories') ? 'Category' : 'Location';
  if (name === 'id') return routePath.includes('/grn/') ? 'GoodsReceiptLine' : undefined;
  const mapped = FIELD_MODELS[name];
  if (mapped) return mapped;
  const base = name.replace(/Ids?$/, '');
  const candidate = base.charAt(0).toUpperCase() + base.slice(1);
  return MODELS.has(candidate) ? candidate : undefined;
}

/** The model each path parameter of `path` names (null for a parameter that is not a row). */
export function modelsOfPath(path: string): Array<{ param: string; model: string | null }> {
  const segments = path.split('/');
  return segments.flatMap((segment, i) => {
    if (!segment.startsWith(':')) return [];
    const param = segment.slice(1);
    if (NOT_A_ROW.has(param)) return [{ param, model: null }];
    if (param !== 'id') return [{ param, model: modelOfField(param, path) ?? null }];
    return [{ param, model: SEGMENT_MODELS[segments[i - 1]] ?? null }];
  });
}
