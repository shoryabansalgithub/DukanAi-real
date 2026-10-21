import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NumberSequenceService } from '../../common/numbering/number-sequence.service';

/**
 * Rule 46(b) of the CGST Rules, 2017 (and Rule 53(1A) for credit notes): a
 * tax invoice carries "a consecutive serial number not exceeding sixteen
 * characters, in one or multiple series, containing alphabets or numerals or
 * special characters hyphen or dash and slash ... unique for a financial
 * year" (docs/compliance/GST_INVOICE_CHECK.md).
 */
export const GST_DOCUMENT_NUMBER_MAX_LENGTH = 16;
const GST_DOCUMENT_NUMBER = /^[A-Za-z0-9/-]{1,16}$/;

/** `2026-27` -> `2627`: the financial year in four characters, so `INV-2627-000001` is 15. */
export function compactFinancialYear(financialYear: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(financialYear);
  if (!match) throw new Error(`Unexpected financial year label "${financialYear}" (expected YYYY-YY)`);
  return `${match[1].slice(2)}${match[2]}`;
}

/** The series prefix of a POS document: one series per kind and financial year. */
export function posDocumentPrefix(kind: 'INV' | 'RET', financialYear: string): string {
  return `${kind}-${compactFinancialYear(financialYear)}-`;
}

export function isGstDocumentNumber(value: string): boolean {
  return GST_DOCUMENT_NUMBER.test(value);
}

/**
 * POS invoice / return numbering: the shared gapless `NumberSequenceService`
 * (one locked `NumberSequence` row per shop, entity type and prefix), with
 * the POS entity types and the GST-compliant format pinned here so no caller
 * can open a second series or a number the rules refuse. Before 9.24 the
 * prefix carried the full label (`INV-2026-27-000001`, 18 characters, over
 * the limit); numbers already issued keep their series, new documents start
 * the compact one (multiple series are allowed).
 */
@Injectable()
export class InvoiceNumberService {
  constructor(private readonly sequences: NumberSequenceService) {}

  async next(tx: Prisma.TransactionClient, shopId: string, entityType: 'POS_INVOICE' | 'POS_RETURN', financialYear: string): Promise<{ number: string; sequence: number }> {
    const prefix = posDocumentPrefix(entityType === 'POS_INVOICE' ? 'INV' : 'RET', financialYear);
    const issued = await this.sequences.next(tx, shopId, entityType, prefix, 6);
    // An invariant, not a client condition: 999,999 documents per series and year fit; the next would not.
    if (!isGstDocumentNumber(issued.number)) {
      throw new Error(`Document number ${issued.number} breaks CGST Rule 46(b) (at most ${GST_DOCUMENT_NUMBER_MAX_LENGTH} characters, letters, digits, '-' and '/')`);
    }
    return issued;
  }
}
