import { Abstract, SetMetadata, Type } from '@nestjs/common';
import { ConfigDomainMetadata } from './registry.types';
import { Expose } from 'class-transformer';

export const CONFIG_DOMAIN_KEY = 'registry:config_domain';
export const ENV_VARIABLE_KEY = 'registry:env_variable';
export const RULE_DEPENDENCIES_KEY = 'registry:rule_dependencies';

export const ConfigDomain = (metadata: ConfigDomainMetadata) => SetMetadata(CONFIG_DOMAIN_KEY, metadata);

export function EnvVariable(name: string): PropertyDecorator {
  return (target, propertyKey) => {
    // 1. Register with our custom Enterprise registry
    const existingVariables: string[] = Reflect.getMetadata(ENV_VARIABLE_KEY, target.constructor) || [];
    existingVariables.push(name);
    Reflect.defineMetadata(ENV_VARIABLE_KEY, existingVariables, target.constructor);
    
    // 2. Instruct class-transformer to map this property during hydration
    Expose({ name })(target, propertyKey);
  };
}

/** A class carrying `@ConfigDomain` metadata (the provider token or metatype). */
export type ConfigDomainClass = Type<unknown> | Abstract<unknown>;

export const RuleDependencies = (domains: ConfigDomainClass[]) => SetMetadata(RULE_DEPENDENCIES_KEY, domains);
