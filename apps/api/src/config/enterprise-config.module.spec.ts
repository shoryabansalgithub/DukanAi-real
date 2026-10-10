import { Test, TestingModule } from '@nestjs/testing';
import { EnterpriseConfigModule } from './enterprise-config.module';
import { SecurityConfig } from './domains/security.config';
import { SalesFeatureConfig } from './domains/features/sales-feature.config';

describe('EnterpriseConfigModule', () => {
  let module: TestingModule;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Override environment for test
    process.env = {
      ...originalEnv,
      BCRYPT_ROUNDS: '12',
      SALES_DEFAULT_CREDIT_LIMIT: '7000',
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

    module = await Test.createTestingModule({
      imports: [EnterpriseConfigModule],
    }).compile();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should compile the module', () => {
    expect(module).toBeDefined();
  });

  it('should provide and hydrate SecurityConfig', () => {
    const securityConfig = module.get<SecurityConfig>(SecurityConfig);
    expect(securityConfig).toBeDefined();
    expect(securityConfig.bcryptRounds).toBe(12); // from env override
    expect(securityConfig.maxLoginAttempts).toBe(5); // default fallback
  });

  it('should provide and hydrate SalesFeatureConfig', () => {
    const salesConfig = module.get<SalesFeatureConfig>(SalesFeatureConfig);
    expect(salesConfig).toBeDefined();
    expect(salesConfig.defaultCreditLimit).toBe(7000); // from env override
    expect(salesConfig.recentEventsLimit).toBe(100); // default fallback
  });
});
