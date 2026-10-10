import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { StorageModule } from './storage/storage.module';
import { BullModule } from '@nestjs/bullmq';

import { EnterpriseConfigModule } from './config/enterprise-config.module';
import { RedisConfig } from './config/domains/redis.config';
import { BullConfig } from './config/domains/bull.config';
import { CacheConfig } from './config/domains/cache.config';
import { SecurityConfig } from './config/domains/security.config';
import { RuntimeValidationModule } from './config/validation/runtime-validation.module';
import { ConfigurationRegistryModule } from './config/registry/configuration-registry.module';
import { RedisModule } from './common/redis/redis.module';
import { EmailModule } from './common/email/email.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { BillingModule } from './billing/billing.module';
import { LedgerModule } from './ledger/ledger.module';
import { NumberSequenceModule } from './common/numbering/number-sequence.service';
import { ShiftsModule } from './shifts/shifts.module';
import { InventoryModule } from './inventory/inventory.module';
import { CacheModule } from '@nestjs/cache-manager';
import { CustomersModule } from './customers/customers.module';
import { OcrModule } from './ocr/ocr.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './common/redis/redis.module';
import { bullConnectionFromUrl } from './common/redis/redis-connection';
import { buildCacheOptions } from './common/cache/cache-options';
import { RedisThrottlerStorage } from './common/throttling/redis-throttler.storage';
import { buildThrottlerOptions } from './common/throttling/throttler-options';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { RouteAuthorizationAssertion } from './auth/route-authorization.assertion';
import { QueueWiringAssertion } from './common/queues/queue-wiring.assertion';
import { TenantGuard } from './iam/guards/tenant.guard';
import { IamModule } from './iam/iam.module';
import { CronLockModule } from './common/cron-lock/cron-lock.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { CorrelationModule } from './common/correlation/correlation.module';
import { InvitationsModule } from './invitations/invitations.module';
import { ShopsModule } from './shops/shops.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { ProductVersioningModule } from './product-versioning/product-versioning.module';
import { ProductVariantsModule } from './product-variants/product-variants.module';
import { ProductIdentityModule } from './product-identity/product-identity.module';
import { ProductMediaModule } from './product-media/product-media.module';
import { ProductSearchModule } from './product-search/product-search.module';
import { ProductValidationModule } from './product-validation/product-validation.module';
import { ImportExportModule } from './import-export/import-export.module';
import { ProductEventsModule } from './product-events/product-events.module';
import { InventoryDomainModule } from './inventory-domain/inventory-domain.module';
import { WarehouseModule } from './warehouse-domain/warehouse.module';
import { StockLedgerModule } from './stock-ledger-domain/stock-ledger.module';
import { ReservationModule } from './reservation-domain/reservation.module';
import { StockCountModule } from './stock-count-domain/stock-count.module';
import { BatchModule } from './batch-domain/batch.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalyticsDomainModule } from './analytics-domain/analytics-domain.module';
import { SalesEventsDomainModule } from './sales-events-domain/sales-events-domain.module';
import { PurchaseDomainModule } from './purchase-domain/purchase-domain.module';
import { GrnDomainModule } from './grn-domain/grn-domain.module';
import { VendorBillDomainModule } from './vendor-bill-domain/vendor-bill-domain.module';
import { PurchaseReturnDomainModule } from './purchase-return-domain/purchase-return-domain.module';
import { SupplierCreditDomainModule } from './supplier-credit-domain/supplier-credit-domain.module';
import { ProcurementWorkflowDomainModule } from './procurement-workflow-domain/procurement-workflow-domain.module';
import { PurchaseAnalyticsDomainModule } from './purchase-analytics-domain/purchase-analytics-domain.module';
import { PurchaseEventsDomainModule } from './purchase-events-domain/purchase-events-domain.module';
import { DocumentModule } from './common/document/document.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ExpensesModule } from './expenses/expenses.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HealthModule } from './health/health.module';
import { LifecycleModule } from './common/lifecycle/lifecycle.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { RetentionModule } from './common/retention/retention.module';
import { ClockModule } from './common/time/clock';
import { ReconciliationModule } from './reconciliation/reconciliation.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    EnterpriseConfigModule,
    ConfigurationRegistryModule,
    RuntimeValidationModule,
    // Cache entries live in Redis (Keyv store) so every instance shares them.
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [RedisConfig, CacheConfig],
      useFactory: (redisConfig: RedisConfig, cacheConfig: CacheConfig) => buildCacheOptions(redisConfig, cacheConfig),
    }),
    BullModule.forRootAsync({
      inject: [RedisConfig, BullConfig],
      useFactory: (redisConfig: RedisConfig, bullConfig: BullConfig) => ({
        // Parsed once from REDIS_URL: TLS for rediss://, decoded credentials, db index.
        connection: bullConnectionFromUrl(redisConfig.redisUrl),
        defaultJobOptions: {
          removeOnComplete: bullConfig.removeOnComplete,
          removeOnFail: bullConfig.removeOnFail,
          attempts: bullConfig.defaultAttempts,
          backoff: { 
            type: bullConfig.backoffType as 'exponential' | 'fixed', 
            delay: bullConfig.backoffDelay 
          },
        },
      }),
    }),
    // Per-IP rate limits with counters in Redis (shared by every instance);
    // routes marked @AuthThrottle() get the stricter AUTH_RATE_LIMIT_* limits.
    ThrottlerModule.forRootAsync({
      inject: [SecurityConfig, REDIS_CLIENT],
      useFactory: (securityConfig: SecurityConfig, redis: Redis) =>
        buildThrottlerOptions(securityConfig, new RedisThrottlerStorage(redis)),
    }),
    PrismaModule,
    StorageModule,
    UsersModule,
    AuthModule,
    LedgerModule,
    NumberSequenceModule,
    BillingModule,
    ShiftsModule,
    InventoryModule,
    CustomersModule,
    OcrModule,
    CronLockModule,
    OutboxModule,
    CorrelationModule,
    IamModule,
    InvitationsModule,
    ShopsModule,
    ProductsModule,
    CategoriesModule,
    ProductVersioningModule,
    ProductVariantsModule,
    ProductIdentityModule,
    ProductMediaModule,
    ProductSearchModule,
    ProductValidationModule,
    ImportExportModule,
    ProductEventsModule,
    InventoryDomainModule,
    WarehouseModule,
    StockLedgerModule,
    ReservationModule,
    StockCountModule,
    BatchModule,
    // The enterprise invoice, returns, payment, sales-order, pricing and
    // events-domain stacks are gone (roadmap 4.5): POS billing is the one
    // invoice / return / payment path, product-events the one webhook path.
    AnalyticsDomainModule,
    SalesEventsDomainModule,
    PurchaseDomainModule,
    GrnDomainModule,
    VendorBillDomainModule,
    PurchaseReturnDomainModule,
    SupplierCreditDomainModule,
    ProcurementWorkflowDomainModule,
    PurchaseAnalyticsDomainModule,
    PurchaseEventsDomainModule,
    DocumentModule,
    RedisModule,
    EmailModule,
    SuppliersModule,
    ExpensesModule,
    NotificationsModule,
    DiscoveryModule,
    // Deployment (roadmap 7.3): probes and shutdown ordering.
    LifecycleModule,
    HealthModule,
    // Observability (roadmap 7.6): /api/metrics and its collectors.
    ObservabilityModule,
    // Retention (roadmap 7.8): the nightly purge of expired tokens, DONE outbox rows and old history.
    RetentionModule,
    // The application clock (roadmap 9.6) and the financial reconciliation (roadmap 9.5).
    ClockModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global guards — execution order follows registration order:
    // 1. ThrottlerGuard  (rate limiting)
    // 2. JwtAuthGuard    (authentication)
    // 3. TenantGuard     (tenant isolation — rejects shopId=null)
    // 4. RolesGuard      (authorization — checks @Roles() metadata)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Refuses to boot while any write handler lacks @Roles / @AnyAuthenticated / @Public.
    RouteAuthorizationAssertion,
    // Refuses to boot while a registered queue has no worker or a worker no queue (roadmap 4.6).
    QueueWiringAssertion,
  ],
})
export class AppModule {}
