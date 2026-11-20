import { Global, Module } from '@nestjs/common';
import { VALIDATION_RULE } from './interfaces/validation-rule.interface';
import { ValidationEngine } from './validation.engine';
import { ValidationContext } from './validation.context';
import { StartupValidatorService } from './startup-validator.service';

// Rules
import { StorageInfrastructureRule } from './rules/storage-infrastructure.rule';
import { RedisInfrastructureRule } from './rules/redis-infrastructure.rule';
import { DatabaseEnvironmentRule } from './rules/database-environment.rule';
import { EnterpriseConfigModule } from '../enterprise-config.module';

const rules = [
  StorageInfrastructureRule,
  RedisInfrastructureRule,
  DatabaseEnvironmentRule
];

@Global()
@Module({
  imports: [EnterpriseConfigModule],
  providers: [
    ValidationContext,
    ValidationEngine,
    StartupValidatorService,
    ...rules,
    {
      provide: VALIDATION_RULE,
      useFactory: (...instances: any[]) => instances,
      inject: rules,
    }
  ],
  exports: [ValidationEngine, ValidationContext, StartupValidatorService]
})
export class RuntimeValidationModule {}
