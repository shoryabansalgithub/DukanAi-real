import { ConfigDomain, ConfigDomainClass, EnvVariable, RuleDependencies, CONFIG_DOMAIN_KEY, ENV_VARIABLE_KEY, RULE_DEPENDENCIES_KEY } from './registry.decorators';

describe('Registry Decorators', () => {
  describe('@ConfigDomain', () => {
    it('should set configuration domain metadata correctly', () => {
      const metadata = {
        owner: 'Platform',
        feature: 'Test',
        version: '1.0.0',
        description: 'Test Config Domain',
      };

      @ConfigDomain(metadata)
      class TestConfig {}

      const reflected = Reflect.getMetadata(CONFIG_DOMAIN_KEY, TestConfig);
      expect(reflected).toEqual(metadata);
    });
  });

  describe('@EnvVariable', () => {
    it('should set environment variable metadata correctly', () => {
      class TestConfig {
        @EnvVariable('TEST_VAR_1')
        testVar1: string;

        @EnvVariable('TEST_VAR_2')
        testVar2: string;
      }

      const reflected: string[] = Reflect.getMetadata(ENV_VARIABLE_KEY, TestConfig);
      expect(reflected).toBeDefined();
      expect(reflected).toHaveLength(2);
      expect(reflected).toContain('TEST_VAR_1');
      expect(reflected).toContain('TEST_VAR_2');
    });

    it('should gracefully handle properties without decorator', () => {
      class TestConfig {
        @EnvVariable('TEST_VAR_1')
        testVar1: string;

        undecorated: string;
      }

      const reflected: string[] = Reflect.getMetadata(ENV_VARIABLE_KEY, TestConfig);
      expect(reflected).toBeDefined();
      expect(reflected).toHaveLength(1);
      expect(reflected).toContain('TEST_VAR_1');
    });
  });

  describe('@RuleDependencies', () => {
    it('should set rule dependencies metadata correctly', () => {
      class DepConfig1 {}
      class DepConfig2 {}

      @RuleDependencies([DepConfig1, DepConfig2])
      class TestRule {}

      const reflected: ConfigDomainClass[] = Reflect.getMetadata(RULE_DEPENDENCIES_KEY, TestRule);
      expect(reflected).toBeDefined();
      expect(reflected).toHaveLength(2);
      expect(reflected[0]).toBe(DepConfig1);
      expect(reflected[1]).toBe(DepConfig2);
    });
  });
});
