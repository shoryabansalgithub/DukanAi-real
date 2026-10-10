import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canonicalState } from '../../common/india/states';
import { SalesFeatureConfig } from '../../config/domains/features/sales-feature.config';
import { openingBalanceKey, CustomersService } from '../../customers/customers.service';
import { UpdateCustomerDto } from '../../customers/dto/create-customer.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerImportValue, normalizePhone, ParsedFile, validateCustomerRow } from '../import-rows';
import { fold, ImportActor, Importer, invalid, PlannedRow, refuse, refuseRepeats, RowAction } from './import-plan';

const CUSTOMER_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  address: true,
  city: true,
  state: true,
  creditLimit: true,
  notes: true,
  outstandingBalance: true,
  isActive: true,
} satisfies Prisma.CustomerSelect;

type StoredCustomer = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;

/** "opening udhar 1250.00" / "opening advance 500.00". */
function describeOpening(amount: number): string {
  return amount > 0 ? `opening udhar ${amount.toFixed(2)}` : `opening advance ${Math.abs(amount).toFixed(2)}`;
}

/**
 * Customers with their opening udhar (roadmap 9.20): matched by phone number
 * after normalising both sides (`normalizePhone`: "+91 98450 12345" and
 * "9845012345" are one customer), created and updated through
 * `CustomersService` (credit-limit authority and audit included), and the
 * opening balance recorded once through `CustomersService.recordOpeningBalance`
 * (an ADJUSTMENT udhar row and an OPENING_BALANCE posting against
 * OPENING_BALANCE_EQUITY). The same balance on a re-run is unchanged; a
 * different one, or a balance for a customer whose udhar already moved, is
 * refused: the difference is a repayment or a credit sale.
 */
@Injectable()
export class CustomerImporter implements Importer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly salesConfig: SalesFeatureConfig,
  ) {}

  async plan(rows: ParsedFile['rows'], actor: ImportActor): Promise<PlannedRow[]> {
    const { shopId } = actor;
    const validated = rows.map((row) => validateCustomerRow(row.rowNumber, row.cells));
    const byPhone = refuseRepeats(validated, (v) => v.phone, 'phone number', 'phone');
    const planned: PlannedRow[] = [...byPhone.repeats];

    const [stored, openings, activity] = await Promise.all([
      this.prisma.customer.findMany({ where: { shopId, isDeleted: false }, select: CUSTOMER_SELECT }),
      this.prisma.udharTransaction.findMany({ where: { shopId, idempotencyKey: { startsWith: 'OPENING:' } }, select: { customerId: true, idempotencyKey: true, balanceBefore: true, balanceAfter: true } }),
      this.prisma.udharTransaction.groupBy({ by: ['customerId'], where: { shopId }, _count: { _all: true } }),
    ]);
    const customersByPhone = new Map<string, StoredCustomer[]>();
    for (const customer of stored) {
      const parsed = normalizePhone(customer.phone);
      const key = parsed.ok ? parsed.value : customer.phone.trim();
      customersByPhone.set(key, [...(customersByPhone.get(key) ?? []), customer]);
    }
    const recordedOpening = new Map<string, Prisma.Decimal>();
    for (const row of openings) {
      if (row.idempotencyKey === openingBalanceKey(row.customerId)) recordedOpening.set(row.customerId, row.balanceAfter.minus(row.balanceBefore));
    }
    const transactionsOf = new Map(activity.map((a) => [a.customerId, a._count._all]));

    for (const row of byPhone.kept) {
      if (!row.value) {
        planned.push(invalid(row));
        continue;
      }
      const matches = customersByPhone.get(row.value.phone) ?? [];
      if (matches.length > 1) {
        planned.push(refuse(row, `${matches.length} customers in the shop share this phone number (${matches.map((c) => c.name).join(', ')}); merge them before importing.`, 'phone'));
        continue;
      }
      const existing = matches[0];
      const issues = [...row.issues];
      const limit = row.value.creditLimit ?? existing?.creditLimit.toNumber() ?? this.salesConfig.defaultCreditLimit;
      if (row.value.openingBalance !== undefined && row.value.openingBalance > limit) {
        issues.push({ field: 'openingBalance', message: `The opening balance ${row.value.openingBalance.toFixed(2)} is above the credit limit ${limit.toFixed(2)}: no further credit until it comes down.`, severity: 'warning' });
      }
      planned.push(
        existing
          ? this.planUpdate(row.rowNumber, row.raw, issues, row.value, existing, recordedOpening.get(existing.id), transactionsOf.get(existing.id) ?? 0, actor)
          : this.planCreate(row.rowNumber, row.raw, issues, row.value, actor),
      );
    }
    return planned;
  }

  private planCreate(rowNumber: number, raw: Record<string, string>, issues: PlannedRow['issues'], value: CustomerImportValue, actor: ImportActor): PlannedRow {
    const opening = value.openingBalance ?? 0;
    const changes = [`new customer ${value.name}`];
    if (opening !== 0) changes.push(describeOpening(opening));
    return {
      rowNumber,
      raw,
      issues,
      action: 'CREATE',
      changes,
      apply: async () => {
        const created = await this.customers.create(
          { name: value.name, phone: value.phone, email: value.email, address: value.address, city: value.city, state: value.state, creditLimit: value.creditLimit, notes: value.notes },
          { userId: actor.userId, role: actor.role },
        );
        if (opening !== 0) await this.customers.recordOpeningBalance(created.id, opening, actor, this.note(actor, rowNumber));
        return 'CREATE';
      },
    };
  }

  private planUpdate(
    rowNumber: number,
    raw: Record<string, string>,
    issues: PlannedRow['issues'],
    value: CustomerImportValue,
    existing: StoredCustomer,
    recorded: Prisma.Decimal | undefined,
    transactions: number,
    actor: ImportActor,
  ): PlannedRow {
    const dto: UpdateCustomerDto = {};
    const changes: string[] = [];
    if (value.name !== existing.name) {
      dto.name = value.name;
      changes.push(`name ${existing.name} → ${value.name}`);
    }
    if (value.email && fold(value.email) !== fold(existing.email ?? '')) {
      dto.email = value.email;
      changes.push(`email ${existing.email ?? '(none)'} → ${value.email}`);
    }
    if (value.address && value.address !== existing.address) {
      dto.address = value.address;
      changes.push('address');
    }
    if (value.city && value.city !== existing.city) {
      dto.city = value.city;
      changes.push(`city ${existing.city ?? '(none)'} → ${value.city}`);
    }
    const storedState = existing.state ? (canonicalState(existing.state) ?? existing.state) : null;
    if (value.state && value.state !== storedState) {
      dto.state = value.state;
      changes.push(`state ${existing.state ?? '(none)'} → ${value.state}`);
    }
    if (value.creditLimit !== undefined && !existing.creditLimit.equals(value.creditLimit)) {
      dto.creditLimit = value.creditLimit;
      changes.push(`creditLimit ${existing.creditLimit.toFixed(2)} → ${value.creditLimit.toFixed(2)}`);
    }
    if (value.notes && value.notes !== existing.notes) {
      dto.notes = value.notes;
      changes.push('notes');
    }

    let opening: number | undefined;
    if (value.openingBalance !== undefined) {
      if (recorded) {
        if (!recorded.equals(value.openingBalance)) {
          return { rowNumber, raw, issues: [...issues, { field: 'openingBalance', message: `The opening balance is already recorded as ${recorded.toFixed(2)}; record the difference as a repayment or a credit sale.`, severity: 'error' }], changes: [] };
        }
      } else if (value.openingBalance !== 0) {
        if (transactions > 0 || !existing.outstandingBalance.isZero()) {
          return {
            rowNumber,
            raw,
            issues: [...issues, { field: 'openingBalance', message: `The customer already has udhar activity (balance ${existing.outstandingBalance.toFixed(2)}); an opening balance is only recorded before the first credit sale or repayment.`, severity: 'error' }],
            changes: [],
          };
        }
        opening = value.openingBalance;
        changes.push(describeOpening(opening));
      }
    }
    if (!existing.isActive) issues.push({ message: 'The customer is inactive in the shop; the import updates it and leaves it inactive.', severity: 'warning' });

    if (changes.length === 0) return { rowNumber, raw, issues, action: 'UNCHANGED', changes: [] };
    const fieldsChange = Object.keys(dto).length > 0;
    return {
      rowNumber,
      raw,
      issues,
      action: 'UPDATE',
      changes,
      apply: async (): Promise<RowAction> => {
        if (fieldsChange) await this.customers.update(existing.id, dto, { userId: actor.userId, role: actor.role });
        if (opening === undefined) return 'UPDATE';
        const result = await this.customers.recordOpeningBalance(existing.id, opening, actor, this.note(actor, rowNumber));
        // Recorded meanwhile by another run with the same amount: nothing new happened unless a field changed.
        return result.status === 'UNCHANGED' && !fieldsChange ? 'UNCHANGED' : 'UPDATE';
      },
    };
  }

  private note(actor: ImportActor, rowNumber: number): string {
    return `Opening balance imported (import ${actor.jobId}, row ${rowNumber})`;
  }
}
