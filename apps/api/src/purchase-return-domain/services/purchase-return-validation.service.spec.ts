import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PurchaseReturnValidationService } from './purchase-return-validation.service';

describe('PurchaseReturnValidationService (roadmap 4.2)', () => {
  const service = new PurchaseReturnValidationService();
  const grnLine = { id: 'grn-line-1', productId: 'p-1', goodsReceiptId: 'grn-1', acceptedQuantity: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal('12.50') };
  const aggregate = jest.fn();
  const tx = {
    goodsReceiptLine: { findFirst: jest.fn().mockResolvedValue(grnLine) },
    purchaseReturnLine: { aggregate },
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    aggregate.mockReset();
    aggregate.mockResolvedValue({ _sum: { returnQuantity: new Prisma.Decimal(5) } });
  });

  it('rejects a line without a goods receipt line', async () => {
    await expect(service.validateReturnLines(tx, 'shop-1', [{ productId: 'p-1', returnQuantity: 1 }])).rejects.toThrow(BadRequestException);
  });

  it('rejects returning more than accepted minus what other live returns already took', async () => {
    await expect(service.validateReturnLines(tx, 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 6 }])).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_OVER_RETURN' } });
  });

  it('allows returning exactly the remaining balance and prices the line from the receipt', async () => {
    const result = await service.validateReturnLines(tx, 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 5 }]);
    expect(result.get('grn-line-1')?.unitPrice.toFixed(2)).toBe('12.50');
  });

  it('sums the lines of one return that point at the same receipt line, and excludes the return itself from the prior total', async () => {
    await expect(service.validateReturnLines(tx, 'shop-1', [
      { grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 3 },
      { grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 3 },
    ], { excludeReturnId: 'pr-self' })).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_OVER_RETURN' } });
    const where = aggregate.mock.calls[0][0].where;
    expect(where.purchaseReturn.id).toEqual({ not: 'pr-self' });
    expect(where.purchaseReturn.status.in).not.toContain('DRAFT');
  });

  it('refuses a receipt line of another goods receipt or another product', async () => {
    await expect(service.validateReturnLines(tx, 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 1 }], { goodsReceiptId: 'grn-other' })).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_LINE_MISMATCH' } });
    await expect(service.validateReturnLines(tx, 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-2', returnQuantity: 1 }])).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_LINE_MISMATCH' } });
  });

  describe('the receipt is the authority of the line (release audit S7 / S8)', () => {
    const receiptLine = (receipt: { status: string; supplierId: string; warehouseId: string }, variantId: string | null = 'v-1') => ({
      ...grnLine,
      variantId,
      goodsReceipt: { ...receipt, isDeleted: false },
    });
    const txWith = (line: unknown) =>
      ({ goodsReceiptLine: { findFirst: jest.fn().mockResolvedValue(line) }, purchaseReturnLine: { aggregate } }) as unknown as Prisma.TransactionClient;
    const accepted = { status: 'ACCEPTED', supplierId: 'sup-1', warehouseId: 'wh-2' };

    it('takes the variant and the warehouse from the receipt line', async () => {
      const result = await service.validateReturnLines(txWith(receiptLine(accepted)), 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 1 }], { supplierId: 'sup-1' });
      expect(result.get('grn-line-1')).toMatchObject({ variantId: 'v-1', warehouseId: 'wh-2', goodsReceiptId: 'grn-1' });
    });

    it('refuses a client variant or warehouse that differs from the receipt', async () => {
      await expect(service.validateReturnLines(txWith(receiptLine(accepted)), 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', variantId: 'v-other', returnQuantity: 1 }])).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_LINE_MISMATCH' } });
      await expect(service.validateReturnLines(txWith(receiptLine(accepted)), 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 1 }], { warehouseId: 'wh-other' })).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_LINE_MISMATCH' } });
    });

    it('refuses a receipt that was never accepted, and one of another supplier', async () => {
      await expect(service.validateReturnLines(txWith(receiptLine({ ...accepted, status: 'QUALITY_INSPECTION' })), 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 1 }])).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_RECEIPT_NOT_ACCEPTED' } });
      await expect(service.validateReturnLines(txWith(receiptLine(accepted)), 'shop-1', [{ grnLineId: 'grn-line-1', productId: 'p-1', returnQuantity: 1 }], { supplierId: 'sup-other' })).rejects.toMatchObject({ response: { code: 'PURCHASE_RETURN_SUPPLIER_MISMATCH' } });
    });
  });
});
