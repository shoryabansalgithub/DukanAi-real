import { Injectable } from '@nestjs/common';
import { TaxCalculator } from '@dukaanai/invoice-math';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface VendorBillTaxLineInput {
  billedQuantity: number | string | Prisma.Decimal;
  unitPrice: number | string | Prisma.Decimal;
  taxPercentage?: number | string | Prisma.Decimal | null;
}

export interface VendorBillTaxedLine<L> {
  line: L;
  /** Taxable value of the line (2 dp): what the goods cost before GST. */
  baseAmount: Prisma.Decimal;
  /** GST on the line (2 dp): the input tax credit. */
  taxAmount: Prisma.Decimal;
  /** base + tax (2 dp). */
  totalAmount: Prisma.Decimal;
}

const toPrisma = (value: Decimal) => new Prisma.Decimal(value.toFixed(2));

@Injectable()
export class VendorBillTaxService {
  /**
   * Taxes every line through the shared engine (`TaxCalculator`) and keeps
   * every figure a Decimal rounded to the paisa (release audit S3: the bill
   * totals were JS floats added with `+`). The bill's total and tax are the
   * sums of the stored line figures, so the header always equals its lines
   * and the posting splits them exactly.
   */
  prepareTaxLiability<L extends VendorBillTaxLineInput>(lines: L[], taxMode: 'INCLUSIVE' | 'EXCLUSIVE') {
    let totalTax = new Prisma.Decimal(0);
    let totalBase = new Prisma.Decimal(0);
    const taxed: Array<VendorBillTaxedLine<L>> = [];

    for (const line of lines) {
      const qty = new Decimal(line.billedQuantity.toString());
      const price = new Decimal(line.unitPrice.toString());
      const taxRate = Number(line.taxPercentage?.toString() ?? 0);

      const taxResult = TaxCalculator.calculateTax({
        taxableAmount: qty.mul(price),
        gstRate: taxRate,
        isInterState: false, // the split is not stored on a bill line; the total tax is the same either way
        mode: taxMode,
      });

      const baseAmount = toPrisma(taxResult.baseAmount);
      const taxAmount = toPrisma(taxResult.totalTaxAmount);
      const totalAmount = baseAmount.plus(taxAmount);
      taxed.push({ line, baseAmount, taxAmount, totalAmount });
      totalBase = totalBase.plus(baseAmount);
      totalTax = totalTax.plus(taxAmount);
    }

    return { totalBase, totalTax, totalAmount: totalBase.plus(totalTax), lines: taxed };
  }
}
