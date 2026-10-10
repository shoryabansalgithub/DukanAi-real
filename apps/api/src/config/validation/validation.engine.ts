import { Injectable, Inject, Optional } from '@nestjs/common';
import { VALIDATION_RULE, ValidationRule } from './interfaces/validation-rule.interface';
import { ValidationContext } from './validation.context';
import { ValidationError } from './interfaces/validation-error.interface';
import { ValidationCategory } from './enums/validation-category.enum';
import { ValidationSeverity } from './enums/validation-severity.enum';

@Injectable()
export class ValidationEngine {
  constructor(
    @Optional()
    @Inject(VALIDATION_RULE)
    private readonly rules: ValidationRule[] = [],
  ) {}

  async validateAll(context: ValidationContext): Promise<ValidationError[]> {
    const allErrors: ValidationError[] = [];

    // Filter out undefined if injection is partial, though NextJS DI normally returns arrays for multi-providers
    const activeRules = (this.rules || []).filter(Boolean);

    for (const rule of activeRules) {
      try {
        const errors = await Promise.resolve(rule.validate(context));
        if (Array.isArray(errors) && errors.length > 0) {
          allErrors.push(...errors);
        }
      } catch (error: any) {
        // If a rule fails unexpectedly, we capture it as a critical infrastructure error
        allErrors.push({
          domain: 'ValidationEngine',
          reason: `Rule execution failed: ${error.message}`,
          severity: ValidationSeverity.CRITICAL,
          category: ValidationCategory.RUNTIME,
          resolution: 'Ensure the validation rule is purely functional and does not throw exceptions.'
        });
      }
    }

    return allErrors;
  }
}
