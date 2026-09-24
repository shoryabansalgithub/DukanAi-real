/**
 * Shared fixtures for the POS integration suites: boots the real AppModule
 * against the local MySQL + Redis (apps/api/.env.test) and creates isolated
 * shops so suites never see each other's data.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantContextService } from '../../src/iam/tenant-context/tenant-context.service';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { InventoryDomainService } from '../../src/inventory-domain/services/inventory-domain.service';
import { InventoryLocationService } from '../../src/inventory-domain/services/inventory-location.service';
import { BillingActor } from '../../src/billing/billing.types';

export const num = (v: Prisma.Decimal | number | string | null | undefined) => Number(v ?? 0);

export interface TestShop {
  shopId: string;
  ownerId: string;
  cashierId: string;
  customerId: string;
  saleLocationId: string;
  suffix: string;
}

export async function bootApp(configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (configure) builder = configure(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return app;
}

/** Runs `fn` with the query awaited inside the tenant AsyncLocalStorage scope (Prisma promises are lazy). */
export function tenantRunner(app: INestApplication) {
  const tenant = app.get(TenantContextService);
  return {
    as: <T>(shopId: string, userId: string, role: Role, fn: () => Promise<T>) =>
      tenant.runWithContext({ shopId, userId, role, correlationId: `test-${randomUUID()}`, requestId: randomUUID() }, async () => await fn()),
    system: <T>(fn: () => Promise<T>) => tenant.runAsSuperAdmin(async () => await fn()),
  };
}

export function actorFor(shop: Pick<TestShop, 'shopId'>, userId: string, role: Role): BillingActor {
  return { shopId: shop.shopId, userId, role, ipAddress: '127.0.0.1', correlationId: `test-${randomUUID()}` };
}

/** A fresh shop with an owner, a cashier and one credit customer. */
export async function createShop(app: INestApplication, label: string, options: { creditLimit?: number; resolveLocation?: boolean } = {}): Promise<TestShop> {
  const prisma = app.get(PrismaService);
  const run = tenantRunner(app);
  const suffix = `${label}${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const shop = await run.system(async () => {
    const created = await prisma.shop.create({ data: { name: `Shop ${suffix}`, state: 'Karnataka', city: 'Bengaluru' } });
    await prisma.shopSettings.create({ data: { shopId: created.id, timezone: 'Asia/Kolkata', gstin: '29ABCDE1234F1Z5' } });
    const owner = await prisma.user.create({ data: { email: `owner-${suffix}@test.local`, name: 'Owner', role: 'OWNER', password: 'x', shopId: created.id } });
    await prisma.shop.update({ where: { id: created.id }, data: { ownerId: owner.id } });
    const cashier = await prisma.user.create({ data: { email: `cashier-${suffix}@test.local`, name: 'Cashier', role: 'CASHIER', password: 'x', shopId: created.id } });
    const customer = await prisma.customer.create({
      data: { name: 'Ravi', phone: `9${suffix.replace(/\D/g, '').slice(-9).padStart(9, '7')}`, shopId: created.id, state: 'Karnataka', creditLimit: options.creditLimit ?? 500 },
    });
    return { shopId: created.id, ownerId: owner.id, cashierId: cashier.id, customerId: customer.id };
  });
  const locations = app.get(InventoryLocationService);
  const saleLocationId = options.resolveLocation === false ? '' : await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => locations.resolveSaleLocation(prisma, shop.shopId));
  return { ...shop, saleLocationId, suffix };
}

export interface ProductSpec {
  key: string;
  sellingPrice?: number;
  costPrice?: number;
  gstRate?: 'ZERO' | 'FIVE' | 'TWELVE' | 'EIGHTEEN' | 'TWENTYEIGHT';
  cessRate?: number;
  unit?: 'PCS' | 'KG';
  type?: 'SIMPLE' | 'SERVICE' | 'DIGITAL';
  /** Legacy products: stock only in Product.currentStock, no InventoryItem row. */
  legacyStock?: number;
  reorderPoint?: number;
  isActive?: boolean;
}

export async function createProduct(app: INestApplication, shop: TestShop, spec: ProductSpec): Promise<string> {
  const prisma = app.get(PrismaService);
  const run = tenantRunner(app);
  const product = await run.system(() =>
    prisma.product.create({
      data: {
        name: `${spec.key} ${shop.suffix}`,
        sku: `${spec.key}-${shop.suffix}`,
        barcode: `${spec.key}${shop.suffix}`,
        costPrice: spec.costPrice ?? 60,
        sellingPrice: spec.sellingPrice ?? 100,
        mrp: spec.sellingPrice ?? 120,
        wholesalePrice: spec.sellingPrice ?? 90,
        unit: spec.unit ?? 'PCS',
        gstRate: spec.gstRate ?? 'EIGHTEEN',
        cessRate: spec.cessRate ?? 0,
        type: spec.type ?? 'SIMPLE',
        currentStock: spec.legacyStock ?? 0,
        reorderPoint: spec.reorderPoint ?? 10,
        isActive: spec.isActive ?? true,
        shopId: shop.shopId,
      },
    }),
  );
  return product.id;
}

/** Receives `quantity` units through the inventory domain (same engine the POS deducts from). */
export async function receiveStock(app: INestApplication, shop: TestShop, productId: string, quantity: number, locationId?: string): Promise<void> {
  const inventoryDomain = app.get(InventoryDomainService);
  const run = tenantRunner(app);
  await run.as(shop.shopId, shop.ownerId, Role.OWNER, async () => {
    const item = await inventoryDomain.ensureInventoryItem(productId, undefined, locationId);
    await inventoryDomain.adjustStock(item.id, 'OPENING_BALANCE', quantity, shop.ownerId, { notes: 'test opening' });
  });
}

export function makeReaders(app: INestApplication, shop: TestShop) {
  const prisma = app.get(PrismaService);
  const run = tenantRunner(app);
  return {
    onHand: async (productId: string, locationId = shop.saleLocationId) => {
      const item = await run.system(() => prisma.inventoryItem.findFirst({ where: { shopId: shop.shopId, productId, locationId, isDeleted: false } }));
      return item ? num(item.onHand) : null;
    },
    productStock: async (productId: string) => num((await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: productId } }))).currentStock),
    ledgerBalance: async (account: 'CASH' | 'BANK' | 'ACCOUNTS_RECEIVABLE' | 'SALES_REVENUE' | 'GST_PAYABLE' | 'INVENTORY' | 'COST_OF_GOODS' | 'ACCOUNTS_PAYABLE' | 'INVENTORY_ADJUSTMENT') => {
      const row = await run.system(() => prisma.ledgerAccountBalance.findUnique({ where: { shopId_account: { shopId: shop.shopId, account } } }));
      return row ? num(row.balance) : 0;
    },
    outstanding: async (customerId = shop.customerId) => num((await run.system(() => prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))).outstandingBalance),
  };
}

export function errorCode(reason: unknown): string | undefined {
  const e = reason as { response?: { code?: string }; code?: string };
  return e?.response?.code ?? e?.code;
}
