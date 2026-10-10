import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateSync } from 'class-validator';
import { hydrateFromEnv } from './hydrate-from-env';

import { AppConfig } from './domains/app.config';
import { DatabaseConfig } from './domains/database.config';
import { JwtConfig } from './domains/jwt.config';
import { AuthConfig, assertAuthBypassPermitted, parseAuthDisabled, parseGoogleClientId } from './domains/auth.config';
import { RedisConfig } from './domains/redis.config';
import { StorageConfig } from './domains/storage.config';
import { AiConfig } from './domains/ai.config';
import { PrismaConfig } from './domains/prisma.config';
import { BullConfig } from './domains/bull.config';
import { CacheConfig } from './domains/cache.config';
import { EmailConfig } from './domains/email.config';
import { MonitoringConfig } from './domains/monitoring.config';
import { LoggingConfig } from './domains/logging.config';
import { SecurityConfig } from './domains/security.config';
import { CronConfig } from './domains/cron.config';
import { RetentionConfig } from './domains/retention.config';

// Feature Domains
import { SalesFeatureConfig } from './domains/features/sales-feature.config';
import { PurchaseFeatureConfig } from './domains/features/purchase-feature.config';
import { AnalyticsFeatureConfig } from './domains/features/analytics-feature.config';
import { SearchFeatureConfig } from './domains/features/search-feature.config';
import { ValidationFeatureConfig } from './domains/features/validation-feature.config';
import { EventsFeatureConfig } from './domains/features/events-feature.config';
import { InventoryFeatureConfig } from './domains/features/inventory-feature.config';
import { ImportExportFeatureConfig } from './domains/features/import-export-feature.config';
import { OcrFeatureConfig } from './domains/features/ocr-feature.config';
import { UploadConfig } from './domains/upload.config';
import { BillingFeatureConfig } from './domains/features/billing-feature.config';

function validateConfig<T extends object>(configClass: T): T {
  const errors = validateSync(configClass);
  if (errors.length > 0) {
    const errorMessages = errors.map(e => Object.values(e.constraints || {}).join(', ')).join('\n');
    throw new Error(`Configuration validation failed for ${configClass.constructor.name}:\n${errorMessages}`);
  }
  return configClass;
}

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // .env.<NODE_ENV> is a committed template and is read only for an explicit
      // NODE_ENV; a process that does not say which environment it is must not
      // pick up the development template (AppConfig then refuses to boot).
      envFilePath: ['.env.local', ...(process.env.NODE_ENV ? [`.env.${process.env.NODE_ENV}`] : []), '.env'],
    }),
  ],
  providers: [
    {
      provide: AppConfig,
      useFactory: () => validateConfig(hydrateFromEnv(AppConfig)),
    },
    {
      provide: DatabaseConfig,
      useFactory: () => {
        const config = new DatabaseConfig();
        Object.assign(config, {
          databaseUrl: process.env.DATABASE_URL,
        });
        return validateConfig(config);
      },
    },
    {
      provide: JwtConfig,
      useFactory: () => validateConfig(hydrateFromEnv(JwtConfig)),
    },
    {
      provide: AuthConfig,
      useFactory: () => {
        const config = new AuthConfig();
        // parseAuthDisabled returns undefined for unrecognized values, which
        // fails the @IsBoolean validation below and refuses to boot.
        Object.assign(config, {
          authDisabled: parseAuthDisabled(process.env.AUTH_DISABLED),
          googleClientId: parseGoogleClientId(process.env.GOOGLE_CLIENT_ID),
        });
        validateConfig(config);
        // The bypass is refused outright outside development/test (P1-6).
        assertAuthBypassPermitted(config.authDisabled, process.env.NODE_ENV);
        return config;
      },
    },
    {
      provide: RedisConfig,
      useFactory: () => {
        const config = new RedisConfig();
        Object.assign(config, {
          redisUrl: process.env.REDIS_URL,
        });
        return validateConfig(config);
      },
    },
    {
      provide: StorageConfig,
      useFactory: () => {
        const config = new StorageConfig();
        Object.assign(config, {
          storageRoot: process.env.STORAGE_ROOT,
          s3Region: process.env.S3_REGION,
          s3Endpoint: process.env.S3_ENDPOINT,
          s3AccessKey: process.env.S3_ACCESS_KEY,
          s3SecretKey: process.env.S3_SECRET_KEY,
          s3Bucket: process.env.S3_BUCKET,
          s3PublicUrl: process.env.S3_PUBLIC_URL,
        });
        return validateConfig(config);
      },
    },
    {
      provide: AiConfig,
      useFactory: () => {
        const config = new AiConfig();
        Object.assign(config, {
          geminiApiKey: process.env.GEMINI_API_KEY,
        });
        return validateConfig(config);
      },
    },
    {
      provide: PrismaConfig,
      useFactory: () => validateConfig(hydrateFromEnv(PrismaConfig)),
    },
    {
      provide: BullConfig,
      useFactory: () => validateConfig(hydrateFromEnv(BullConfig)),
    },
    {
      provide: CacheConfig,
      useFactory: () => validateConfig(hydrateFromEnv(CacheConfig)),
    },
    {
      provide: EmailConfig,
      useFactory: () => validateConfig(hydrateFromEnv(EmailConfig)),
    },
    {
      provide: MonitoringConfig,
      useFactory: () => validateConfig(hydrateFromEnv(MonitoringConfig)),
    },
    {
      provide: LoggingConfig,
      useFactory: () => validateConfig(hydrateFromEnv(LoggingConfig)),
    },
    {
      provide: SecurityConfig,
      useFactory: () => validateConfig(hydrateFromEnv(SecurityConfig)),
    },
    {
      provide: CronConfig,
      useFactory: () => validateConfig(hydrateFromEnv(CronConfig)),
    },
    { provide: RetentionConfig, useFactory: () => validateConfig(hydrateFromEnv(RetentionConfig)) },
    { provide: SalesFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(SalesFeatureConfig)) },
    { provide: PurchaseFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(PurchaseFeatureConfig)) },
    { provide: AnalyticsFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(AnalyticsFeatureConfig)) },
    { provide: SearchFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(SearchFeatureConfig)) },
    { provide: ValidationFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(ValidationFeatureConfig)) },
    { provide: EventsFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(EventsFeatureConfig)) },
    { provide: InventoryFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(InventoryFeatureConfig)) },
    { provide: ImportExportFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(ImportExportFeatureConfig)) },
    { provide: OcrFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(OcrFeatureConfig)) },
    { provide: UploadConfig, useFactory: () => validateConfig(hydrateFromEnv(UploadConfig)) },
    { provide: BillingFeatureConfig, useFactory: () => validateConfig(hydrateFromEnv(BillingFeatureConfig)) },
  ],
  exports: [
    AppConfig,
    DatabaseConfig,
    JwtConfig,
    AuthConfig,
    RedisConfig,
    StorageConfig,
    AiConfig,
    PrismaConfig,
    BullConfig,
    CacheConfig,
    EmailConfig,
    MonitoringConfig,
    LoggingConfig,
    SecurityConfig,
    CronConfig,
    RetentionConfig,
    SalesFeatureConfig,
    PurchaseFeatureConfig,
    AnalyticsFeatureConfig,
    SearchFeatureConfig,
    ValidationFeatureConfig,
    EventsFeatureConfig,
    InventoryFeatureConfig,
    ImportExportFeatureConfig,
    OcrFeatureConfig,
    UploadConfig,
    BillingFeatureConfig,
  ],
})
export class EnterpriseConfigModule {}
