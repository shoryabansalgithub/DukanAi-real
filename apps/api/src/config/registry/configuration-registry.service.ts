import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { ConfigDomainMetadata, ConfigDomainRecord, ConfigurationRegistryData } from './registry.types';
import { CONFIG_DOMAIN_KEY, ConfigDomainClass, ENV_VARIABLE_KEY, RULE_DEPENDENCIES_KEY } from './registry.decorators';

@Injectable()
export class ConfigurationRegistryService implements OnModuleInit {
  private readonly logger = new Logger('ConfigurationRegistry');
  
  private data: ConfigurationRegistryData = {
    domains: new Map(),
    rules: new Map(),
    variableOwnership: new Map(),
  };

  private initialized = false;

  constructor(private readonly discoveryService: DiscoveryService) {}

  onModuleInit() {
    if (this.initialized) return;

    this.logger.log('Initializing Enterprise Configuration Registry...');
    
    const providers = this.discoveryService.getProviders();

    // 1. Discover Config Domains and their Variables
    for (const wrapper of providers) {
      if (!wrapper.instance) continue;

      // Config domains are registered with `useFactory` (see EnterpriseConfigModule),
      // so the @ConfigDomain metadata lives on the injection token (the config
      // class), not on wrapper.metatype (which is the factory / null). Resolve
      // the domain class from whichever carries the metadata; without this the
      // registry discovers zero domains and every rule dependency looks unknown.
      const domainType: ConfigDomainClass | undefined =
        wrapper.metatype && Reflect.getMetadata(CONFIG_DOMAIN_KEY, wrapper.metatype)
          ? (wrapper.metatype as ConfigDomainClass)
          : typeof wrapper.token === 'function' && Reflect.getMetadata(CONFIG_DOMAIN_KEY, wrapper.token)
            ? (wrapper.token as ConfigDomainClass)
            : undefined;
      if (!domainType) continue;

      const domainMetadata: ConfigDomainMetadata = Reflect.getMetadata(CONFIG_DOMAIN_KEY, domainType);
      if (domainMetadata) {
        const domainName = domainType.name;

        // Extract variables
        const variables: string[] = Reflect.getMetadata(ENV_VARIABLE_KEY, domainType) || [];

        // Check for duplicate ownership
        for (const v of variables) {
          if (this.data.variableOwnership.has(v)) {
            const existingOwner = this.data.variableOwnership.get(v);
            if (existingOwner !== domainName) {
              this.logger.error(`================================================================================`);
              this.logger.error(`                       REGISTRY DUPLICATE OWNERSHIP DETECTED                    `);
              this.logger.error(`================================================================================`);
              this.logger.error(`Variable: ${v}`);
              this.logger.error(`Claimed by: ${domainName}`);
              this.logger.error(`Already owned by: ${existingOwner}`);
              this.logger.error(`================================================================================`);
              this.logger.error(`Application cannot safely start.`);
              throw new Error(`Configuration registry: variable ${v} is claimed by both ${existingOwner} and ${domainName}`);
            }
          }
          this.data.variableOwnership.set(v, domainName);
        }

        this.data.domains.set(domainName, {
          name: domainName,
          metadata: domainMetadata,
          variables,
          injectedBy: [],
          validatedBy: [],
        });
      }
    }

    // 2. Discover Validation Rules and map Validation Graph
    for (const wrapper of providers) {
      if (!wrapper.metatype) continue;

      const ruleDependencies: ConfigDomainClass[] = Reflect.getMetadata(RULE_DEPENDENCIES_KEY, wrapper.metatype);
      if (ruleDependencies) {
        const ruleName = wrapper.metatype.name;
        const depNames = ruleDependencies.map(d => d.name);
        
        this.data.rules.set(ruleName, {
          name: ruleName,
          dependencies: depNames,
        });

        // Update domains with validatedBy
        for (const depName of depNames) {
          const domain = this.data.domains.get(depName);
          if (domain) {
            domain.validatedBy.push(ruleName);
          } else {
            this.logger.error(`Validation Rule ${ruleName} depends on unknown domain ${depName}.`);
            throw new Error(`Configuration registry: validation rule ${ruleName} depends on unknown domain ${depName}`);
          }
        }
      }
    }

    // 3. Discover DI Graph (Who injects what domain?)
    for (const wrapper of providers) {
      if (!wrapper.metatype) continue;

      const paramTypes = Reflect.getMetadata('design:paramtypes', wrapper.metatype);
      if (paramTypes && Array.isArray(paramTypes)) {
        for (const param of paramTypes) {
          if (param && param.name && this.data.domains.has(param.name)) {
            // Found a service injecting a domain
            const domain = this.data.domains.get(param.name)!;
            // Prevent duplicate entries if a service is registered multiple times or injects same domain multiple times
            if (!domain.injectedBy.includes(wrapper.metatype.name)) {
              domain.injectedBy.push(wrapper.metatype.name);
            }
          }
        }
      }
    }

    this.initialized = true;
    this.logger.log(`Registry initialized. Discovered ${this.data.domains.size} domains and ${this.data.rules.size} validation rules.`);
  }

  // APIs

  public get(domainName: string): ConfigDomainRecord | undefined {
    this.ensureInitialized();
    return this.data.domains.get(domainName);
  }

  public getOrThrow(domainName: string): ConfigDomainRecord {
    const domain = this.get(domainName);
    if (!domain) {
      throw new Error(`ConfigDomain ${domainName} not found in registry.`);
    }
    return domain;
  }

  public exists(domainName: string): boolean {
    this.ensureInitialized();
    return this.data.domains.has(domainName);
  }

  public list(): ConfigDomainRecord[] {
    this.ensureInitialized();
    return Array.from(this.data.domains.values());
  }

  public listByFeature(feature: string): ConfigDomainRecord[] {
    return this.list().filter(d => d.metadata.feature === feature);
  }

  public listByOwner(owner: string): ConfigDomainRecord[] {
    return this.list().filter(d => d.metadata.owner === owner);
  }

  public listDependencies(domainName: string): string[] {
    return this.getOrThrow(domainName).injectedBy;
  }

  public getVariableOwner(variableName: string): string | undefined {
    this.ensureInitialized();
    return this.data.variableOwnership.get(variableName);
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error('ConfigurationRegistryService accessed before initialization.');
    }
  }
}
