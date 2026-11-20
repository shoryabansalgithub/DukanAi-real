import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Amount = number | string | Prisma.Decimal;

@Injectable()
export class VendorBillOutstandingService {
  /**
   * Applies a payment to a bill's live balance, in Decimal to the paisa.
   * `outstanding` is the bill's current outstanding amount (earlier payments
   * and credit-note allocations already taken off), `paid` what was paid so far.
   */
  processPayment(outstanding: Amount, paid: Amount, payment: Amount) {
    const before = new Prisma.Decimal(outstanding.toString()).toDecimalPlaces(2);
    const amount = new Prisma.Decimal(payment.toString()).toDecimalPlaces(2);

    if (amount.greaterThan(before)) {
      throw new BadRequestException({
        message: `Payment amount ${amount.toFixed(2)} exceeds outstanding balance ${before.toFixed(2)}`,
        code: 'VENDOR_BILL_OVERPAYMENT',
        details: { outstanding: before.toFixed(2), requested: amount.toFixed(2) },
      });
    }

    const outstandingAmount = before.minus(amount);
    return {
      paidAmount: new Prisma.Decimal(paid.toString()).plus(amount),
      outstandingAmount,
      isFullyPaid: outstandingAmount.lessThanOrEqualTo(0),
    };
  }
}
