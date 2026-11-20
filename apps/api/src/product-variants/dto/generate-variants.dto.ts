import { IsObject, registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Bounds of one variant generation (roadmap 5.2, audit "unbounded Cartesian
 * product"): the number of variants is the product of the value counts, so
 * a few kilobytes of JSON could otherwise ask for 10^16 rows. The same
 * bounds are re-checked in the service.
 */
export const MAX_VARIANT_ATTRIBUTES = 8;
export const MAX_VALUES_PER_ATTRIBUTE = 100;
export const MAX_VARIANT_COMBINATIONS = 1000;
export const MAX_ATTRIBUTE_LABEL_LENGTH = 50;

/** The slug the service stores; two labels with the same slug are one attribute / value. */
export function attributeSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/** Number of variants a matrix expands to (product of the value counts), 0 for an empty matrix. */
export function countCombinations(attributes: Record<string, string[]>): number {
  const counts = Object.values(attributes).map((values) => values.length);
  if (counts.length === 0) return 0;
  return counts.reduce((product, count) => product * count, 1);
}

/** Why a matrix is refused, or null when it is acceptable. */
export function attributeMatrixProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'attributes must be an object';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return 'attributes must name at least one attribute';
  if (entries.length > MAX_VARIANT_ATTRIBUTES) return `attributes may name at most ${MAX_VARIANT_ATTRIBUTES} attributes`;
  const attributeSlugs = new Set<string>();
  for (const [name, values] of entries) {
    if (name.trim().length === 0 || name.length > MAX_ATTRIBUTE_LABEL_LENGTH) return `attribute names must be 1-${MAX_ATTRIBUTE_LABEL_LENGTH} characters`;
    const slug = attributeSlug(name);
    if (slug.replace(/-/g, '').length === 0) return `attribute name "${name}" has no letters or digits`;
    if (attributeSlugs.has(slug)) return `attribute "${name}" is listed twice`;
    attributeSlugs.add(slug);
    if (!Array.isArray(values) || values.length === 0) return `attribute "${name}" must list at least one value`;
    if (values.length > MAX_VALUES_PER_ATTRIBUTE) return `attribute "${name}" may list at most ${MAX_VALUES_PER_ATTRIBUTE} values`;
    const valueSlugs = new Set<string>();
    for (const option of values) {
      if (typeof option !== 'string' || option.trim().length === 0 || option.length > MAX_ATTRIBUTE_LABEL_LENGTH) {
        return `values of "${name}" must be strings of 1-${MAX_ATTRIBUTE_LABEL_LENGTH} characters`;
      }
      const valueSlug = attributeSlug(option);
      if (valueSlug.replace(/-/g, '').length === 0) return `value "${option}" of "${name}" has no letters or digits`;
      if (valueSlugs.has(valueSlug)) return `value "${option}" of "${name}" is listed twice`;
      valueSlugs.add(valueSlug);
    }
  }
  const combinations = countCombinations(value as Record<string, string[]>);
  if (combinations > MAX_VARIANT_COMBINATIONS) {
    return `attributes expand to ${combinations} variants; at most ${MAX_VARIANT_COMBINATIONS} may be generated at once`;
  }
  return null;
}

/** `{ Colour: ['Red', 'Blue'], Size: ['S', 'M'] }` within the bounds above. */
function IsAttributeMatrix(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isAttributeMatrix',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => attributeMatrixProblem(value) === null,
        defaultMessage: (args) => attributeMatrixProblem(args?.value) ?? 'attributes is invalid',
      },
    });
  };
}

export class GenerateVariantsDto {
  @IsObject()
  @IsAttributeMatrix()
  attributes: Record<string, string[]>;
}
