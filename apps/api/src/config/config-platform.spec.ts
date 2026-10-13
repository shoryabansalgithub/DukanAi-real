import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { EnterpriseConfigModule } from './enterprise-config.module';
import { ConfigurationRegistryModule } from './registry/configuration-registry.module';
import { RuntimeValidationModule } from './validation/runtime-validation.module';
import { SalesFeatureConfig } from './domains/features/sales-feature.config';
import { SecurityConfig } from './domains/security.config';
import { CronConfig } from './domains/cron.config';
import { CacheConfig } from './domains/cache.config';

describe('Configuration Platform Integration', () => {
  let module: TestingModule;
  const originalEnv = process.env;

  beforeAll(async () => {
    // 1. Environment Variable Setup
    process.env = {
      ...originalEnv,
      SALES_DEFAULT_CREDIT_LIMIT: '50000',
      SECURITY_MAX_LOGIN_ATTEMPTS: '7',
      RATE_LIMIT_SHORT_TTL_MS: '5000',
      CRON_OUTBOX_REAPER: '0 0 29 2 *',
      CRON_ENABLED: 'false',
      CACHE_CUSTOMER_SEARCH_TTL_MS: '15000',
      CACHE_TTL: '',
      DATABASE_URL: 'postgres://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'secret',
      JWT_EXPIRES_IN: '1h',
      JWT_REFRESH_EXPIRES_IN: '1d',
      STORAGE_ROOT: '/tmp',
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: 'http://localhost',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_BUCKET: 'bucket',
      S3_PUBLIC_URL: 'http://localhost',
      GEMINI_API_KEY: 'gemini',
    };

    // 2. Hydration, Validation, Registry, DI Setup
    module = await Test.createTestingModule({
      imports: [
        EnterpriseConfigModule,
        ConfigurationRegistryModule,
        RuntimeValidationModule,
      ],
    }).compile();

    // Trigger onModuleInit to ensure registry discovery runs
    await module.init();
  });

  afterAll(async () => {
    process.env = originalEnv;
    await module.close();
  });

  it('should seamlessly inject fully hydrated SalesFeatureConfig to consumers', () => {
    // 3. Consumer Service (Simulated by module.get)
    const salesConfig = module.get<SalesFeatureConfig>(SalesFeatureConfig);
    
    // 4. Runtime Behaviour
    expect(salesConfig).toBeDefined();
    expect(salesConfig.recentEventsLimit).toBe(100); // default
    expect(salesConfig.defaultCreditLimit).toBe(50000); // overriden by env
  });

  it('should seamlessly inject fully hydrated SecurityConfig to consumers', () => {
    const securityConfig = module.get<SecurityConfig>(SecurityConfig);
    expect(securityConfig).toBeDefined();
    expect(securityConfig.maxLoginAttempts).toBe(7); // from EnvVariable
    expect(securityConfig.rateLimitShortTtlMs).toBe(5000); // from EnvVariable
    expect(securityConfig.bcryptRounds).toBe(10); // default
  });

  it('hydrates CronConfig from the environment (schedulers read this, tests rely on it)', () => {
    const cron = module.get<CronConfig>(CronConfig);
    expect(cron.outboxReaperCron).toBe('0 0 29 2 *'); // from EnvVariable
    expect(cron.enabled).toBe(false); // from EnvVariable
    expect(cron.analyticsJobCron).toBe('0 0 * * *'); // default
  });

  it('hydrates CacheConfig from the environment; a blank variable keeps the default', () => {
    const cache = module.get<CacheConfig>(CacheConfig);
    expect(cache.customerSearchTtlMs).toBe(15000); // from EnvVariable
    expect(cache.ttl).toBe(3600000); // CACHE_TTL='' keeps the default
    expect(cache).not.toHaveProperty('JWT_SECRET'); // only declared variables are copied
  });
});
