import { Prisma } from '@prisma/client';
import { GLOBAL_MODELS } from './tenant-scope';

/**
 * Data-model conventions (roadmap 8.1), read from the generated DMMF so a
 * schema edit that drops one of them fails here before it reaches a
 * migration: every tenant model is a Shop relation (the foreign key is the
 * isolation guard), every owning relation says what a delete does, no
 * implicit many-to-many table (no primary key, no shop column), stock
 * quantities share one width, free-text columns are TEXT, money defaults to
 * the rupee, and no unique key relies on a nullable column (phase 8 exit
 * gate): MySQL never compares NULLs in a unique index, so such a key admits
 * any number of rows whose nullable part is NULL. A key whose nullable column
 * is a real dimension of the row carries a NOT NULL `*Key` token instead
 * (`InventoryItem.variantKey`, `PurchaseCategorySpendSnapshot.departmentKey`,
 * `PriceListItem.variantKey`). The remaining nullable keys are listed below
 * with the reason NULL means "absent" there; adding one is a design decision
 * that belongs in this list with its reason, never a silent schema edit.
 */
const models = Prisma.dmmf.datamodel.models;
const model = (name: string) => {
  const found = models.find((m) => m.name === name);
  if (!found) throw new Error(`model ${name} is not in the schema`);
  return found;
};

/** Unique keys that deliberately include a nullable column, and why NULL is right there. */
const NULLABLE_UNIQUE_KEYS: Record<string, string> = {
  'Shift(shopId,openedById,openToken)': "the partial key of roadmap 8.3: 'OPEN' while open, NULL once closed, so one open shift per cashier",
  'User(googleId)': 'optional identity: present only for Google accounts, unique when present',
  'Shop(ownerId)': 'optional 1:1 pointer, set once the owner row exists (Shop.ownerId and User.shopId are created as a deferred pair)',
  'Product(currentPublishedRevId)': 'optional 1:1 pointer to the published revision',
  'Product(currentDraftRevId)': 'optional 1:1 pointer to the draft revision',
  'Product(shopId,barcode,deletedToken)': 'optional identifier: products without a barcode are many, a present barcode is unique per shop',
  'ProductVariant(shopId,barcode,deletedToken)': 'optional identifier: variants without a barcode are many, a present barcode is unique per shop',
  'ProductIdentity(globalProductId)': 'optional external identifier, unique when present',
  'ProductIdentity(internalProductId)': 'optional internal identifier, unique when present',
  'SupplierPayment(shopId,idempotencyKey)': 'optional idempotency key: a request without one is never replayed by design',
  'UdharTransaction(shopId,idempotencyKey)': 'optional idempotency key: a request without one is never replayed by design',
  'PurchaseCategorySpendSnapshot(shopId,categoryId,departmentId)': 'REPLACED by departmentKey (migration 20261004120000); listed so a revert fails',
  'PriceListItem(versionId,productId,variantId)': 'REPLACED by variantKey (migration 20261004120000); listed so a revert fails',
};

/** Nullable column -> the NOT NULL token that carries the unique key instead. */
const TOKEN_KEYS: Array<[model: string, nullable: string, token: string]> = [
  ['InventoryItem', 'variantId', 'variantKey'],
  ['PurchaseCategorySpendSnapshot', 'departmentId', 'departmentKey'],
  ['PriceListItem', 'variantId', 'variantKey'],
];

function nullableUniqueKeys(): string[] {
  const found: string[] = [];
  for (const m of models) {
    const byName = new Map(m.fields.map((f) => [f.name, f]));
    const keys = [...m.uniqueFields, ...m.fields.filter((f) => f.isUnique).map((f) => [f.name])];
    for (const key of keys) {
      if (key.some((name) => !byName.get(name)?.isRequired)) found.push(`${m.name}(${key.join(',')})`);
    }
  }
  return found.sort();
}

describe('schema conventions (roadmap 8.1)', () => {
  it('no unique key relies on a nullable column unless its reason is recorded here (phase 8 exit gate)', () => {
    const found = nullableUniqueKeys();
    const unexplained = found.filter((k) => !(k in NULLABLE_UNIQUE_KEYS) || NULLABLE_UNIQUE_KEYS[k].startsWith('REPLACED'));
    expect(unexplained).toEqual([]);
    const stale = Object.keys(NULLABLE_UNIQUE_KEYS).filter((k) => !NULLABLE_UNIQUE_KEYS[k].startsWith('REPLACED') && !found.includes(k));
    expect(stale).toEqual([]);
  });

  it.each(TOKEN_KEYS)('%s.%s is mirrored by the NOT NULL token %s that carries the unique key', (modelName, nullable, token) => {
    const m = model(modelName);
    const nullableField = m.fields.find((f) => f.name === nullable);
    const tokenField = m.fields.find((f) => f.name === token);
    expect(nullableField?.isRequired).toBe(false);
    expect(tokenField?.isRequired).toBe(true);
    expect(tokenField?.default).toBe('-');
    expect(m.uniqueFields.some((key) => key.includes(token))).toBe(true);
    expect(m.uniqueFields.some((key) => key.includes(nullable))).toBe(false);
  });

  it('every model with a shopId column has a relation to Shop', () => {
    const missing = models
      .filter((m) => !GLOBAL_MODELS.has(m.name) && m.fields.some((f) => f.name === 'shopId'))
      .filter((m) => !m.fields.some((f) => f.kind === 'object' && f.type === 'Shop'))
      .map((m) => m.name);
    expect(missing).toEqual([]);
  });

  it('every owning relation declares its onDelete action', () => {
    const silent = models.flatMap((m) =>
      m.fields
        .filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0 && !f.relationOnDelete)
        .map((f) => `${m.name}.${f.name}`),
    );
    expect(silent).toEqual([]);
  });

  it('has no implicit many-to-many relation', () => {
    const implicit: string[] = [];
    for (const m of models) {
      for (const f of m.fields) {
        if (f.kind !== 'object' || !f.isList || !f.relationName || (f.relationFromFields?.length ?? 0) > 0) continue;
        const back = model(f.type).fields.find((b) => b.relationName === f.relationName && b.name !== f.name);
        if (back?.isList) implicit.push(`${m.name}.${f.name} <-> ${f.type}.${back.name}`);
      }
    }
    expect(implicit).toEqual([]);
  });

  it('the asset tag join model has a composite primary key and a shop column', () => {
    const join = model('MediaAssetTag');
    expect(join.primaryKey?.fields).toEqual(['assetId', 'tagId']);
    expect(join.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['assetId', 'tagId', 'shopId']));
    expect(join.fields.find((f) => f.name === 'asset')?.relationOnDelete).toBe('Cascade');
    expect(join.fields.find((f) => f.name === 'tag')?.relationOnDelete).toBe('Cascade');
  });

  it.each([
    ['Product', 'currentStock'],
    ['Product', 'totalUnitsSold'],
    ['ProductVariant', 'currentStock'],
    ['InventoryItem', 'onHand'],
    ['InventoryLog', 'quantityBefore'],
    ['InventoryLog', 'quantityChange'],
    ['InventoryLog', 'quantityAfter'],
    ['InventoryDriftLog', 'databaseValue'],
  ])('%s.%s is a Decimal(12, 3) stock quantity', (modelName, field) => {
    const column = model(modelName).fields.find((f) => f.name === field);
    expect(column?.nativeType).toEqual(['Decimal', ['12', '3']]);
  });

  it.each([
    ['Notification', 'message'],
    ['OutboxEvent', 'error'],
  ])('%s.%s is a TEXT column', (modelName, field) => {
    expect(model(modelName).fields.find((f) => f.name === field)?.nativeType).toEqual(['Text', []]);
  });

  it('every currency column defaults to INR', () => {
    const defaults = models.flatMap((m) => m.fields.filter((f) => f.name === 'currency').map((f) => `${m.name}=${String(f.default)}`));
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.filter((d) => !d.endsWith('=INR'))).toEqual([]);
  });

  it('VariantIdentity.sku is unique per shop', () => {
    expect(model('VariantIdentity').uniqueFields).toContainEqual(['shopId', 'sku']);
  });
});
