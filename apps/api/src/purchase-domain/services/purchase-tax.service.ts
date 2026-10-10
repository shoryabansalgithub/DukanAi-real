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
      const quantity = item.quantity || 0;
      const unitCost = item.unitCost || 0;
      const discount = item.discount || 0;
      
      const subtotal = (quantity * unitCost) - discount;
      if (subtotal < 0) {
        throw new BadRequestException('Subtotal cannot be negative');
      }

      // Base tax rates
      const cgstRate = item.cgstRate || 0;
      const sgstRate = item.sgstRate || 0;
      const igstRate = item.igstRate || 0;
      const cessRate = item.cessRate || 0;
      
      const isInterState = igstRate > 0;
      const gstRate = isInterState ? igstRate : (cgstRate + sgstRate);

      const taxResult = TaxCalculator.calculateTax({
        taxableAmount: new Decimal(subtotal),
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
