import { Prisma, Role } from '@prisma/client';

export interface BillingActor {
  shopId: string;
  userId: string;
  role: Role;
  ipAddress?: string;
  correlationId?: string;
}

export interface StockOutcome {
  productId: string;
  quantity: number;
  /** InventoryItem.onHand at the sale location after the mutation. */
  balanceAfter: number;
  /** Product.currentStock (aggregate) after the mutation. */
  productStockAfter: number;
}

export const MANAGER_ROLES: readonly Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER];

export function isManager(role: Role): boolean {
  return MANAGER_ROLES.includes(role);
}

/** Decimal → DB money (2 dp) as a Prisma.Decimal. */
export function money(value: { toFixed(dp: number): string } | number | string): Prisma.Decimal {
  const asString = typeof value === 'number' || typeof value === 'string' ? new Prisma.Decimal(value).toFixed(2) : value.toFixed(2);
  return new Prisma.Decimal(asString);
}

/** Decimal → DB quantity (3 dp) as a Prisma.Decimal. */
export function qty(value: { toFixed(dp: number): string } | number | string): Prisma.Decimal {
  const asString = typeof value === 'number' || typeof value === 'string' ? new Prisma.Decimal(value).toFixed(3) : value.toFixed(3);
  return new Prisma.Decimal(asString);
}

export const INVOICE_INCLUDE = {
  items: { where: { isDeleted: false }, orderBy: { createdAt: 'asc' as const } },
  payments: { orderBy: { createdAt: 'asc' as const } },
  customer: { select: { id: true, name: true, phone: true, state: true, outstandingBalance: true, creditLimit: true } },
  cashier: { select: { id: true, name: true } },
} satisfies Prisma.InvoiceInclude;

export type InvoiceWithRelations = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;
