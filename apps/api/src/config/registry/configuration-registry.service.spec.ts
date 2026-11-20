import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigurationRegistryService } from './configuration-registry.service';
import { ConfigDomain, EnvVariable, RuleDependencies, CONFIG_DOMAIN_KEY } from './registry.decorators';

// Mock Classes
@ConfigDomain({ owner: 'TeamA', feature: 'Redis', version: '1.0', description: 'Redis Config' })
class MockRedisConfig {
  @EnvVariable('REDIS_URL')
  url: string;
}

@ConfigDomain({ owner: 'TeamB', feature: 'Bull', version: '1.0', description: 'Bull Config' })
class MockBullConfig {
  @EnvVariable('BULL_QUEUE')
  queue: string;
}

@ConfigDomain({ owner: 'TeamC', feature: 'Storage', version: '1.0', description: 'Storage Config' })
class MockStorageConfig {
  @EnvVariable('S3_BUCKET')
  bucket: string;
}

@RuleDependencies([MockRedisConfig, MockBullConfig])
class MockQueueRule {}

class MockService {
  constructor(private readonly redis: MockRedisConfig) {}
}

class IgnoredClass {}

describe('ConfigurationRegistryService', () => {
  let service: ConfigurationRegistryService;
  let discoveryService: jest.Mocked<DiscoveryService>;

  beforeEach(async () => {
    discoveryService = {
      getProviders: jest.fn(),
    } as unknown as jest.Mocked<DiscoveryService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigurationRegistryService,
        { provide: DiscoveryService, useValue: discoveryService },
      ],
    }).compile();

    service = module.get<ConfigurationRegistryService>(ConfigurationRegistryService);

    // Suppress logger to keep test output clean, but allow tracking
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Initialization & Discovery', () => {
    it('should initialize exactly once', () => {
      discoveryService.getProviders.mockReturnValue([]);
      
      service.onModuleInit();
      service.onModuleInit();
      
      expect(discoveryService.getProviders).toHaveBeenCalledTimes(1);
    });

    it('should register domains and extract env variables', () => {
      discoveryService.getProviders.mockReturnValue([
        { metatype: MockRedisConfig, instance: new MockRedisConfig() },
        { metatype: MockBullConfig, instance: new MockBullConfig() },
        { metatype: IgnoredClass, instance: new IgnoredClass() },
        { metatype: undefined, instance: undefined }, // Should handle safely
      ] as any);

      service.onModuleInit();

      expect(service.exists('MockRedisConfig')).toBe(true);
      expect(service.exists('MockBullConfig')).toBe(true);
      expect(service.exists('IgnoredClass')).toBe(false);

      const redis = service.getOrThrow('MockRedisConfig');
      expect(redis.metadata.owner).toBe('TeamA');
      expect(redis.variables).toContain('REDIS_URL');

      expect(service.getVariableOwner('REDIS_URL')).toBe('MockRedisConfig');
      expect(service.getVariableOwner('BULL_QUEUE')).toBe('MockBullConfig');
    });
  });

  describe('Duplicate Ownership Detection', () => {
    it('should detect duplicate environment variable claims and throw (bootstrap reports it)', () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`Process exited with code ${code}`);
      });

      @ConfigDomain({ owner: 'TeamA', feature: 'F1', version: '1', description: '' })
      class DuplicateConfigA {
        @EnvVariable('SHARED_VAR')
        val1: string;
      }

      @ConfigDomain({ owner: 'TeamB', feature: 'F2', version: '1', description: '' })
      class DuplicateConfigB {
        @EnvVariable('SHARED_VAR')
        val2: string;
      }

      discoveryService.getProviders.mockReturnValue([
        { metatype: DuplicateConfigA, instance: new DuplicateConfigA() },
        { metatype: DuplicateConfigB, instance: new DuplicateConfigB() },
      ] as any);

      expect(() => {
        service.onModuleInit();
      }).toThrow('variable SHARED_VAR is claimed by both');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('REGISTRY DUPLICATE OWNERSHIP DETECTED'));
    });
  });

  describe('Graph Construction', () => {
    it('should build validation graph correctly', () => {
      discoveryService.getProviders.mockReturnValue([
        { metatype: MockRedisConfig, instance: new MockRedisConfig() },
        { metatype: MockBullConfig, instance: new MockBullConfig() },
        { metatype: MockQueueRule, instance: new MockQueueRule() },
      ] as any);

      service.onModuleInit();

      const redis = service.getOrThrow('MockRedisConfig');
      const bull = service.getOrThrow('MockBullConfig');

      expect(redis.validatedBy).toContain('MockQueueRule');
      expect(bull.validatedBy).toContain('MockQueueRule');
    });

    it('should safely abort if validation rule depends on unknown domain', () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`Process exited with code ${code}`);
      });

      discoveryService.getProviders.mockReturnValue([
        // Missing the config domains that the rule depends on
        { metatype: MockQueueRule, instance: new MockQueueRule() },
      ] as any);

      expect(() => {
        service.onModuleInit();
      }).toThrow('depends on unknown domain');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('unknown domain'));
    });

    it('should build Dependency Injection (injectedBy) graph correctly', () => {
      Reflect.defineMetadata('design:paramtypes', [MockRedisConfig], MockService);

      discoveryService.getProviders.mockReturnValue([
        { metatype: MockRedisConfig, instance: new MockRedisConfig() },
        { metatype: MockService, instance: new MockService(new MockRedisConfig()) },
      ] as any);

      service.onModuleInit();

      const redis = service.getOrThrow('MockRedisConfig');
      expect(redis.injectedBy).toContain('MockService');
      
      const dependencies = service.listDependencies('MockRedisConfig');
      expect(dependencies).toContain('MockService');
    });
  });

  describe('Query APIs', () => {
    beforeEach(() => {
      discoveryService.getProviders.mockReturnValue([
        { metatype: MockRedisConfig, instance: new MockRedisConfig() },
        { metatype: MockBullConfig, instance: new MockBullConfig() },
        { metatype: MockStorageConfig, instance: new MockStorageConfig() },
      ] as any);
      service.onModuleInit();
    });

    it('should list all domains', () => {
      const all = service.list();
      expect(all).toHaveLength(3);
    });

    it('should list by feature', () => {
      const redisFeatures = service.listByFeature('Redis');
      expect(redisFeatures).toHaveLength(1);
      expect(redisFeatures[0].name).toBe('MockRedisConfig');
    });

    it('should list by owner', () => {
      const teamCDomains = service.listByOwner('TeamC');
      expect(teamCDomains).toHaveLength(1);
      expect(teamCDomains[0].name).toBe('MockStorageConfig');
    });

    it('should throw if uninitialized access', () => {
      const uninitializedService = new ConfigurationRegistryService(discoveryService);
      expect(() => uninitializedService.list()).toThrow('before initialization');
    });

    it('should throw if domain not found via getOrThrow', () => {
      expect(() => service.getOrThrow('NonExistentConfig')).toThrow('not found in registry');
    });
  });

  describe('Security and Immutability', () => {
    it('should not mutate reflection metadata', () => {
      discoveryService.getProviders.mockReturnValue([
        { metatype: MockRedisConfig, instance: new MockRedisConfig() },
      ] as any);
      service.onModuleInit();
      
      const originalMetadata = Reflect.getMetadata(CONFIG_DOMAIN_KEY, MockRedisConfig);
      expect(originalMetadata.owner).toBe('TeamA');
    });
  });
});
