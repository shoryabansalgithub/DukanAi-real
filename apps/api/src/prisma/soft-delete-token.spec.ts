import { DELETED_TOKEN_MODELS, stampDeletedToken } from './soft-delete-token';

describe('soft-delete tokens (roadmap 3.10)', () => {
  it('covers every model whose unique key carries a token', () => {
    for (const model of ['Category', 'Product', 'ProductVariant', 'Supplier', 'Customer', 'CustomerGroup', 'CustomerCategory', 'PurchaseOrder', 'GoodsReceipt', 'VendorBill', 'PurchaseReturn', 'SupplierCreditNote', 'Warehouse', 'Location']) {
      expect(DELETED_TOKEN_MODELS.has(model)).toBe(true);
    }
    expect(DELETED_TOKEN_MODELS.has('Invoice')).toBe(false);
  });

  it('stamps the row id on a soft delete by id and clears it on a restore', () => {
    const del = stampDeletedToken('Customer', 'update', { where: { id: 'c1' }, data: { isDeleted: true, deletedAt: new Date() } }) as { data: { deletedToken: string } };
    expect(del.data.deletedToken).toBe('c1');
    const viaSet = stampDeletedToken('Product', 'update', { where: { id: 'p1' }, data: { deletedAt: { set: new Date() } } }) as { data: { deletedToken: string } };
    expect(viaSet.data.deletedToken).toBe('p1');
    const restore = stampDeletedToken('Customer', 'update', { where: { id: 'c1' }, data: { isDeleted: false, deletedAt: null } }) as { data: { deletedToken: string } };
    expect(restore.data.deletedToken).toBe('');
    const upsert = stampDeletedToken('Supplier', 'upsert', { where: { id: 's1' }, create: {}, update: { isDeleted: true } }) as { update: { deletedToken: string } };
    expect(upsert.update.deletedToken).toBe('s1');
  });

  it('leaves ordinary writes and other models alone', () => {
    const args = { where: { id: 'c1' }, data: { name: 'x' } };
    expect(stampDeletedToken('Customer', 'update', args)).toBe(args);
    const invoice = { where: { id: 'i1' }, data: { isDeleted: true } };
    expect(stampDeletedToken('Invoice', 'update', invoice)).toBe(invoice);
    expect(stampDeletedToken('Customer', 'findMany', args)).toBe(args);
  });

  it('refuses a soft delete that cannot be attributed to one row', () => {
    expect(() => stampDeletedToken('Customer', 'update', { where: { shopId_phone_deletedToken: {} }, data: { isDeleted: true } })).toThrow(/by id/);
    expect(() => stampDeletedToken('Customer', 'updateMany', { where: { shopId: 's' }, data: { isDeleted: true } })).toThrow(/update by id/);
  });
});
