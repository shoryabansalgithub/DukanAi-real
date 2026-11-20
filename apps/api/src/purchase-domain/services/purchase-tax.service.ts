import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TaxCalculator } from '@dukaanai/invoice-math';
import { Decimal } from 'decimal.js';

@Injectable()
export class PurchaseTaxService {
  private readonly logger = new Logger(PurchaseTaxService.name);

  /**
   * Calculate taxes based on configuration (inclusive or exclusive).
   */
  calculateTaxes(items: any[], mode: 'INCLUSIVE' | 'EXCLUSIVE', _currency: string, _exchangeRate: number) {
    this.logger.debug(`Calculating taxes in ${mode} mode`);
    
    return items.map(item => {
      // Decimal from the first operation: 0.1 × 3 in floats is 0.30000000000000004.
      const quantity = new Decimal(item.quantity || 0);
      const unitCost = new Decimal(item.unitCost || 0);
      const discount = new Decimal(item.discount || 0);

      const subtotal = quantity.times(unitCost).minus(discount);
      if (subtotal.isNegative()) {
        throw new BadRequestException({ message: 'A line discount cannot exceed the line value.', code: 'PURCHASE_ORDER_LINE_NEGATIVE' });
      }

      // Base tax rates
      const cgstRate = item.cgstRate || 0;
      const sgstRate = item.sgstRate || 0;
      const igstRate = item.igstRate || 0;
      const cessRate = item.cessRate || 0;
      
      const isInterState = igstRate > 0;
      const gstRate = isInterState ? igstRate : (cgstRate + sgstRate);

      const taxResult = TaxCalculator.calculateTax({
        taxableAmount: subtotal,
        gstRate,
        cessRate,
        isInterState,
        mode
      });

      return {
        ...item,
        price: taxResult.baseAmount.toNumber(),
        tax: taxResult.totalTaxAmount.toNumber(),
        totalCost: taxResult.totalAmount.toNumber(),
        cgstAmount: taxResult.cgstAmount.toNumber(),
        sgstAmount: taxResult.sgstAmount.toNumber(),
        igstAmount: taxResult.igstAmount.toNumber(),
        cessAmount: taxResult.cessAmount.toNumber(),
      };
    });
  }
}
