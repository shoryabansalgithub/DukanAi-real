import { Prisma } from '@prisma/client';

/**
 * The personal-data inventory in code (roadmap 9.24; the readable version is
 * docs/privacy/DATA_INVENTORY.md). Every text or JSON column of every model
 * whose name says it can hold personal data is classified here, and
 * `personal-data.spec.ts` fails on one that is not: a new `Customer.whatsapp`
 * or `Invoice.deliveryAddress` must be given a class (and so an erasure rule)
 * before it ships.
 *
 * Classes, and what an erasure does with each:
 *  - identity:  names a person or their business (name, email, phone, address,
 *               GSTIN, PAN). Erased: NULL, or `[erased]` / `erased-<rowid>`
 *               when the column is required / part of a unique key.
 *  - freeText:  typed by staff, may mention anyone (notes, remarks, reasons,
 *               comments, messages, signatures). Erased like identity.
 *  - payload:   JSON snapshots of rows or requests (audit before/after, event
 *               payloads, raw import rows, EXIF). Erased: NULL or `{}`.
 *  - network:   IP addresses and user agents. Erased: NULL.
 *  - file:      a path or URL to an uploaded file (the file is deleted too).
 *  - secret:    credentials and token hashes. Never exported; erased.
 *  - keep:      looks personal by name but is not (a product name, a hash, an
 *               internal id); the reason is recorded.
 */
export type PersonalDataClass = 'identity' | 'freeText' | 'payload' | 'network' | 'file' | 'secret' | 'keep';

/** Column names that might hold personal data; a match must be classified. */
export const CANDIDATE_FIELD = /(name|email|phone|mobile|address|street|city|pincode|zip|gstin|pan|aadhaar|note|remark|comment|description|ip|agent|contact|person|message|body|payload|query|term|token|hash|secret|password|url|path|signature|reason|metadata|data|details|location|lat|lng|reasons|terms|instructions)/i;

/** Explicit classes, `Model.field`. Checked first. */
const EXPLICIT: Record<string, PersonalDataClass> = {
  // The shop and its people
  'Shop.name': 'identity', 'Shop.address': 'identity', 'Shop.city': 'identity', 'Shop.pincode': 'identity', 'Shop.phone': 'identity', 'Shop.email': 'identity', 'Shop.logoUrl': 'file',
  'ShopSettings.gstin': 'identity',
  'User.email': 'identity', 'User.name': 'identity', 'User.phone': 'identity', 'User.password': 'secret', 'User.lastLoginIp': 'network', 'User.googleId': 'secret',
  'LoginAttempt.email': 'identity',
  'Invitation.email': 'identity', 'Invitation.token': 'secret',
  'RefreshToken.token': 'secret', 'PasswordResetToken.tokenHash': 'secret',
  // The shop's customers (the shop is their data fiduciary; DukaanAI processes for the shop)
  'Customer.name': 'identity', 'Customer.phone': 'identity', 'Customer.email': 'identity', 'Customer.address': 'identity', 'Customer.city': 'identity', 'Customer.notes': 'freeText', 'Customer.tags': 'freeText',
  'CustomerProfile.companyName': 'identity', 'CustomerProfile.displayName': 'identity', 'CustomerProfile.gstin': 'identity', 'CustomerProfile.pan': 'identity',
  'CustomerAddress.addressLine': 'identity', 'CustomerAddress.city': 'identity',
  'CustomerContact.name': 'identity', 'CustomerContact.phone': 'identity', 'CustomerContact.email': 'identity',
  // Suppliers and other businesses: a sole proprietor's trade name and contact are a person's
  'Supplier.name': 'identity', 'Supplier.contactPerson': 'identity', 'Supplier.phone': 'identity', 'Supplier.email': 'identity', 'Supplier.gstin': 'identity', 'Supplier.address': 'identity', 'Supplier.city': 'identity',
  'Manufacturer.contact': 'identity', 'Manufacturer.gstin': 'identity',
  'Warehouse.address': 'identity', 'Warehouse.city': 'identity', 'Warehouse.pincode': 'identity', 'Warehouse.contactName': 'identity', 'Warehouse.contactPhone': 'identity',
  // What people typed into search boxes
  'SearchHistory.query': 'freeText', 'SavedSearch.query': 'freeText', 'SearchAnalytics.query': 'freeText', 'SearchClick.query': 'freeText',
  // Outbound integrations of the shop
  'WebhookEndpoint.url': 'identity', 'WebhookEndpoint.secret': 'secret', 'WebhookEndpoint.description': 'freeText',
  'PurchaseWebhookDelivery.endpointUrl': 'identity', 'PurchaseWebhookDelivery.responseBody': 'freeText',
  'SalesOrderReference.externalUrl': 'identity',
  // Free text that is a description of a person's expense or a document line
  'Expense.description': 'freeText', 'SupplierCreditLine.description': 'freeText', 'EnterpriseInvoiceLine.description': 'freeText', 'PaymentLedger.description': 'freeText',
  'EnterpriseInvoice.terms': 'freeText',
  'MediaAsset.originalName': 'file', 'MediaStorage.path': 'file', 'MediaStorage.cdnUrl': 'file', 'MediaThumbnail.path': 'file', 'MediaThumbnail.cdnUrl': 'file', 'MediaVersion.path': 'file',
  'ProductImage.url': 'file', 'SalesOrderAttachment.name': 'file', 'Expense.receiptPath': 'file',
  // Child tables without a shop column (reached through their parent, `childModels`):
  // the customer's own detail rows, the import report, the webhook log
  'CustomerProfile.customFields': 'payload', 'CustomerProfile.website': 'identity', 'CustomerProfile.registrationNo': 'identity', 'CustomerProfile.profilePicture': 'file',
  'CustomerAddress.postalCode': 'identity', 'CustomerAddress.district': 'identity',
  // A report row's problems and planned changes quote the row's cells ("new customer Ramesh", '"98765" is not a phone number').
  'ImportJobRow.errors': 'payload', 'ImportJobRow.changes': 'payload',
};

/** Not personal although the name matches; each with its reason. */
export const NOT_PERSONAL: Record<string, string> = {
  'Category.name': 'a product category', 'Category.path': 'category tree ids', 'Category.imageUrl': 'catalogue art',
  'Product.name': 'a product', 'Product.description': 'a product description', 'Product.imageUrl': 'catalogue art',
  'ProductVariant.imageUrl': 'catalogue art', 'ProductAttribute.dataType': 'a type tag', 'VariantAttribute.name': 'an attribute such as Size',
  'Brand.name': 'a brand', 'Brand.logoUrl': 'a brand logo', 'Manufacturer.name': 'a manufacturing company',
  'Warehouse.name': "a store room's label", 'Location.path': 'location tree ids', 'InventoryItem.locationId': 'an id', 'LocationCapacityLog.locationId': 'an id',
  'CustomerGroup.name': 'a segment label', 'CustomerGroup.description': 'a segment description', 'CustomerCategory.name': 'a segment label', 'CustomerCategory.description': 'a segment description', 'CustomerCategory.path': 'tree ids', 'CustomerTag.name': 'a tag label',
  'InvoiceItem.productName': 'the product sold (a GST invoice field)', 'SalesOrderLine.productName': 'the product ordered',
  'LedgerTransaction.description': 'document references only since roadmap 9.24 (migration 20261011090000); immutable',
  'LedgerPosting.description': 'document references only since roadmap 9.24',
  'Invoice.requestHash': 'a hash of the request', 'ProductRevision.contentHash': 'a hash', 'ProductImage.hash': 'a content hash', 'MediaAsset.hash': 'a content hash',
  'ProductRevision.data': 'catalogue content', 'ProductRevision.commitMessage': 'catalogue change note', 'RevisionBranch.name': 'a branch label',
  'Shift.openToken': "the open-shift token 'OPEN'", 'Expense.receiptMimeType': 'a file type (image/jpeg, image/png, application/pdf)', 'ShopSettings.subscriptionPlan': 'a plan code',
  'OutboxEvent.correlationId': 'a request id', 'ProductEventLog.correlationId': 'a request id', 'InventoryAdjustment.correlationId': 'a request id', 'InventoryMovement.correlationId': 'a request id', 'StockLedgerEntry.correlationId': 'a request id',
  'GoodsReceiptLine.goodsReceiptId': 'an id', 'GoodsReceiptAttachment.goodsReceiptId': 'an id', 'GoodsReceiptAudit.goodsReceiptId': 'an id', 'GoodsReceiptStatusHistory.goodsReceiptId': 'an id', 'GoodsReceiptInspection.goodsReceiptId': 'an id', 'GoodsReceiptVersion.goodsReceiptId': 'an id', 'GoodsReceiptComment.goodsReceiptId': 'an id', 'GoodsReceiptApproval.goodsReceiptId': 'an id', 'VendorBill.goodsReceiptId': 'an id', 'PurchaseReturn.goodsReceiptId': 'an id', 'WorkflowInstance.goodsReceiptId': 'an id',
  'BarcodePrintJob.templateId': 'an id', 'WorkflowStep.escalationRoleId': 'an id', 'WorkflowTask.escalatedToRoleId': 'an id',
  'PurchaseReturn.reasonCode': 'a reason code from a list', 'CreditNote.noteNumber': 'a document number', 'DebitNote.noteNumber': 'a document number',
  'WorkflowDefinition.name': 'a workflow label', 'WorkflowDefinition.description': 'a workflow description', 'WorkflowStep.name': 'a step label',
  'BarcodeTemplate.name': 'a label template', 'QrCode.payload': 'a product code', 'MediaTag.name': 'an image tag', 'SavedSearch.name': 'a saved search label',
  'SearchSynonym.term': 'a catalogue synonym', 'SearchBoost.queryTerm': 'a catalogue boost', 'ValidationRule.description': 'a validation rule', 'ProductValidationIssue.message': 'a catalogue check message',
  'DuplicateCandidate.reasons': 'catalogue match reasons', 'InventoryRecommendation.actionData': 'reorder figures', 'InventoryRecommendation.reason': 'a generated reorder reason', 'InventoryAlert.message': 'a generated stock message', 'InventorySnapshot.snapshotReason': 'a system reason',
  'ImportMapping.name': 'a column mapping label', 'PriceList.name': 'a price list', 'PriceListVersion.versionName': 'a version label', 'PricingRule.name': 'a pricing rule', 'PricingRule.description': 'a pricing rule', 'Promotion.name': 'a promotion', 'SalesOrderTag.name': 'a tag label',
  'AnalyticsExportJob.reportName': 'a report name', 'PurchaseEventDelivery.consumerName': 'a consumer id', 'PurchaseConsumerState.consumerName': 'a consumer id',
  'PurchaseAnalyticsJob.errorMessage': 'a system error', 'AnalyticsExportJob.errorMessage': 'a system error', 'PurchaseEventDelivery.errorMessage': 'a system error',
  'BarcodeHistory.reason': 'a barcode change reason code', 'SkuHistory.reason': 'a SKU change reason code', 'BatchRecall.reason': 'a recall reason about stock',
  'PurchasePricingSnapshot.snapshotData': 'supplier prices', 'SalesOrderSnapshot.frozenData': 'prices of an order',
  'InventoryEventLog.payload': 'stock event figures', 'PurchaseEventAudit.metadata': 'event delivery metadata', 'EnterpriseInvoiceAuditLog.metadata': 'audit metadata without personal fields',
};

/** Name rules applied when no explicit entry exists. */
const RULES: ReadonlyArray<[RegExp, PersonalDataClass]> = [
  [/^deletedToken$/, 'keep'], // '' while live, the row id once soft-deleted (src/prisma/soft-delete-token.ts)
  [/^(password|secret|token|tokenHash)$/, 'secret'],
  [/^(ipAddress|userAgent|lastLoginIp)$/, 'network'],
  [/^(fileUrl|fileName|pdfUrl|errorReportUrl|cdnUrl|imageUrls)$/, 'file'],
  [/^(notes|remarks|comments|reason|returnReason|message|commitMessage|digitalSignature|deliveryTerms|paymentTerms|shippingInstructions|discountReason|cancelReason|errorMessage|failureReason)$/, 'freeText'],
  [/^(beforeData|afterData|previousPayload|newPayload|payload|requestPayload|snapshotData|metadata|rawData|previousData|exifData|data)$/, 'payload'],
];

export interface ClassifiedField {
  model: string;
  field: string;
  dbName: string;
  type: string;
  required: boolean;
  unique: boolean;
  cls: PersonalDataClass;
}

/** The class of a column, or undefined when a candidate is not classified (the spec fails on that). */
export function classify(model: string, field: string): PersonalDataClass | undefined {
  const key = `${model}.${field}`;
  if (EXPLICIT[key]) return EXPLICIT[key];
  if (NOT_PERSONAL[key]) return 'keep';
  for (const [pattern, cls] of RULES) if (pattern.test(field)) return cls;
  return undefined;
}

const datamodel = Prisma.dmmf.datamodel;

/** Columns that are part of a unique key (an erased value there must stay distinct per row). */
function uniqueColumns(model: Prisma.DMMF.Model): Set<string> {
  const names = new Set<string>();
  for (const field of model.fields) if (field.isUnique) names.add(field.name);
  for (const index of model.uniqueFields) for (const name of index) names.add(name);
  return names;
}

/** Every text / JSON column of every model with its class (undefined when not a candidate). */
export function inventory(): Array<Omit<ClassifiedField, 'cls'> & { cls: PersonalDataClass | undefined; candidate: boolean }> {
  const rows: Array<Omit<ClassifiedField, 'cls'> & { cls: PersonalDataClass | undefined; candidate: boolean }> = [];
  for (const model of datamodel.models) {
    const unique = uniqueColumns(model);
    for (const field of model.fields) {
      if (field.kind !== 'scalar' || (field.type !== 'String' && field.type !== 'Json') || field.isId) continue;
      const cls = classify(model.name, field.name);
      rows.push({
        model: model.name,
        field: field.name,
        dbName: field.dbName ?? field.name,
        type: field.type,
        required: field.isRequired,
        unique: unique.has(field.name),
        cls,
        candidate: CANDIDATE_FIELD.test(field.name) || cls !== undefined,
      });
    }
  }
  return rows;
}

/** The columns an erasure rewrites, per model (keep and unclassified columns are left alone). */
export function erasableFields(): Map<string, ClassifiedField[]> {
  const byModel = new Map<string, ClassifiedField[]>();
  for (const row of inventory()) {
    if (!row.cls || row.cls === 'keep') continue;
    const list = byModel.get(row.model) ?? [];
    list.push(row as ClassifiedField);
    byModel.set(row.model, list);
  }
  return byModel;
}

/** Columns never written into an export (credentials). */
export function secretFields(model: string): Set<string> {
  return new Set(inventory().filter((r) => r.model === model && r.cls === 'secret').map((r) => r.field));
}

export interface TenantModel {
  name: string;
  table: string;
  idColumns: string[];
  shopColumn: string;
}

/**
 * Models without a shop column that are deliberately outside a shop's data
 * (audit F2), each with its reason. Every other model is tenant-owned or a
 * child reachable from one (`childModels`); `personal-data.spec.ts` fails on
 * a model that is none of the three.
 */
export const NOT_SHOP_DATA: Record<string, string> = {
  Shop: 'the shop itself: exported and erased as its own row',
  RefreshToken: "credentials (hashed session tokens) of the shop's people: never exported; deleted on erasure",
  PasswordResetToken: 'credentials (hashed reset links): never exported; deleted on erasure',
  IdempotencyRecord: 'consumer bookkeeping keyed by event ids: no shop, no personal data',
};

/** One join from a child row (or a row on its way) to its parent. */
export interface ChildHop {
  /** The parent's table and the columns the child's foreign key references. */
  table: string;
  parentColumns: string[];
  /** The foreign-key columns on the row joined so far. */
  childColumns: string[];
}

/**
 * A model without a shop column whose rows belong to a shop through a
 * required relation (audit F2 / F3): an invoice's lines through the invoice,
 * a customer's audit trail through the customer, an import's report through
 * the import, a webhook's deliveries through the endpoint. `hops` lead from
 * the child (alias t0) to the first row that names the shop; `shopColumns`
 * are that row's shop columns (one, or two for a stock transfer, which
 * belongs to both its shops). `customerColumn` is the child's own
 * `customerId` when it has one (a customer's erasure reaches it).
 */
export interface ChildModel {
  name: string;
  table: string;
  idColumn: string;
  hops: ChildHop[];
  shopColumns: string[];
  customerColumn?: string;
  /** The models on the way to the shop, for the export manifest and the docs. */
  via: string[];
}

function columnOf(model: Prisma.DMMF.Model, field: string): string {
  return model.fields.find((f) => f.name === field)?.dbName ?? field;
}

function modelByName(name: string): Prisma.DMMF.Model | undefined {
  return datamodel.models.find((m) => m.name === name);
}

function hasShopColumn(model: Prisma.DMMF.Model): boolean {
  return model.fields.some((f) => f.name === 'shopId' && f.kind === 'scalar');
}

/** Required relations of a model to another model, in field order. */
function requiredRelations(model: Prisma.DMMF.Model): Array<{ parent: Prisma.DMMF.Model; childColumns: string[]; parentColumns: string[] }> {
  const out: Array<{ parent: Prisma.DMMF.Model; childColumns: string[]; parentColumns: string[] }> = [];
  for (const field of model.fields) {
    if (field.kind !== 'object' || !field.isRequired || !field.relationFromFields?.length) continue;
    const parent = modelByName(field.type);
    if (!parent || parent.name === model.name) continue;
    out.push({ parent, childColumns: field.relationFromFields.map((f) => columnOf(model, f)), parentColumns: (field.relationToFields ?? []).map((f) => columnOf(parent, f)) });
  }
  return out;
}

/** The required relations of a model straight to Shop (a stock transfer has two). */
function shopRelations(model: Prisma.DMMF.Model): string[] {
  return requiredRelations(model).filter((r) => r.parent.name === 'Shop').map((r) => r.childColumns[0]);
}

/** Every model that is not tenant-owned but reaches one through required relations (shortest path first). */
export function childModels(): ChildModel[] {
  const out: ChildModel[] = [];
  for (const model of datamodel.models) {
    if (hasShopColumn(model) || NOT_SHOP_DATA[model.name]) continue;
    const ids = model.fields.filter((f) => f.isId);
    if (ids.length !== 1) continue;
    const customer = model.fields.find((f) => f.name === 'customerId' && f.kind === 'scalar');
    const base = { name: model.name, table: model.dbName ?? model.name, idColumn: ids[0].dbName ?? ids[0].name, ...(customer ? { customerColumn: customer.dbName ?? customer.name } : {}) };

    const direct = shopRelations(model);
    if (direct.length > 0) {
      out.push({ ...base, hops: [], shopColumns: direct, via: ['Shop'] });
      continue;
    }
    // Breadth first over required relations: the first row on the way that names the shop ends the path.
    const queue: Array<{ at: Prisma.DMMF.Model; hops: ChildHop[]; via: string[] }> = [{ at: model, hops: [], via: [] }];
    const seen = new Set<string>([model.name]);
    let found: ChildModel | undefined;
    while (queue.length > 0 && !found) {
      const { at, hops, via } = queue.shift()!;
      for (const relation of requiredRelations(at)) {
        if (seen.has(relation.parent.name)) continue;
        seen.add(relation.parent.name);
        const nextHops = [...hops, { table: relation.parent.dbName ?? relation.parent.name, parentColumns: relation.parentColumns, childColumns: relation.childColumns }];
        const nextVia = [...via, relation.parent.name];
        if (hasShopColumn(relation.parent)) {
          found = { ...base, hops: nextHops, shopColumns: [columnOf(relation.parent, 'shopId')], via: nextVia };
          break;
        }
        const viaShop = shopRelations(relation.parent);
        if (viaShop.length > 0) {
          found = { ...base, hops: nextHops, shopColumns: viaShop, via: [...nextVia, 'Shop'] };
          break;
        }
        queue.push({ at: relation.parent, hops: nextHops, via: nextVia });
      }
    }
    if (found) out.push(found);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Models that are neither tenant-owned, nor a child of one, nor excluded with a reason (the spec wants none). */
export function unownedModels(): string[] {
  const children = new Set(childModels().map((c) => c.name));
  return datamodel.models.filter((m) => !hasShopColumn(m) && !NOT_SHOP_DATA[m.name] && !children.has(m.name)).map((m) => m.name);
}

/** Models that belong to one shop (a `shopId` column), with their table and key columns. */
export function tenantModels(): TenantModel[] {
  const out: TenantModel[] = [];
  for (const model of datamodel.models) {
    const shop = model.fields.find((f) => f.name === 'shopId' && f.kind === 'scalar');
    if (!shop) continue;
    const ids = model.fields.filter((f) => f.isId).map((f) => f.dbName ?? f.name);
    out.push({
      name: model.name,
      table: model.dbName ?? model.name,
      idColumns: ids.length > 0 ? ids : (model.primaryKey?.fields ?? []).map((name) => model.fields.find((f) => f.name === name)?.dbName ?? name),
      shopColumn: shop.dbName ?? shop.name,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The goods-and-services tax retention period (CGST Act s.36): accounts are
 * kept "until the expiry of seventy-two months from the due date of
 * furnishing of annual return for the year". The annual return (GSTR-9) of
 * financial year `YYYY-YY` is due on 31 December after it ends, so its
 * records are held until 31 December of the start year + 7.
 */
export function gstRetentionEnds(financialYear: string): Date {
  const match = /^(\d{4})-\d{2}$/.exec(financialYear);
  if (!match) throw new Error(`Unexpected financial year label "${financialYear}"`);
  return new Date(Date.UTC(Number(match[1]) + 7, 11, 31, 23, 59, 59));
}

/**
 * CGST Rule 46(e) proviso: a tax invoice to an unregistered person of fifty
 * thousand rupees or more carries the recipient's name and address. While
 * such an invoice is within its retention period, those fields of the
 * customer are a legal hold on an erasure request.
 */
export const GST_NAMED_RECIPIENT_THRESHOLD = 50_000;
