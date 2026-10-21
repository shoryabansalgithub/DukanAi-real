import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, ValidateIf } from 'class-validator';
import { canonicalState, INDIAN_STATES } from './states';

/**
 * A request field that names an Indian state or union territory (audit B3):
 * any spelling `canonicalState` knows (case, spacing, "Orissa", "New Delhi")
 * is stored and compared as the canonical one, anything else is 400. With
 * `allowBlank` an empty string passes through (the customer forms send ''
 * to clear the field).
 */
export function IsIndianState(options: { allowBlank?: boolean } = {}): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => {
      if (typeof value !== 'string') return value;
      if (options.allowBlank && value.trim() === '') return '';
      return canonicalState(value) ?? value;
    }),
    ...(options.allowBlank ? [ValidateIf((_: unknown, value: unknown) => value !== '')] : []),
    IsIn([...INDIAN_STATES], { message: ({ property }) => `${property} must be an Indian state or union territory (e.g. Karnataka)` }),
  );
}

/**
 * A stored or typed state as two states are compared (place of supply against
 * the shop's state): the canonical spelling, or for a name the list does not
 * know (a legacy row) the trimmed, lower-cased, space-collapsed text; null
 * when blank. The web POS preview folds the same way
 * (`apps/web/src/components/pos/indian-states.ts`).
 */
export function comparableState(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return canonicalState(value) ?? value.trim().toLowerCase().replace(/\s+/g, ' ');
}
