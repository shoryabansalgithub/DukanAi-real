import { plainToInstance, Transform, type ClassConstructor } from 'class-transformer';

/**
 * Builds a config domain from environment variables.
 *
 * Only properties declared with `@EnvVariable(...)` are read, so unrelated
 * environment values (secrets included) never land on the object. An unset or
 * blank variable keeps the class default. Anything else reaches the property's
 * transforms and validators as the raw string, so a bad value fails
 * `validateConfig` at boot instead of silently becoming a default.
 */
export function hydrateFromEnv<T extends object>(
  cls: ClassConstructor<T>,
  source: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): T {
  return plainToInstance(cls, source, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
    exposeUnsetFields: false,
    enableImplicitConversion: false,
  });
}

const INTEGER = /^-?\d+$/;

/**
 * Integer environment value: unset or blank → `undefined` (the class default is
 * kept), an integer string → number, anything else → `NaN` so `@IsInt()` rejects it.
 */
export function parseEnvInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return undefined;
  return INTEGER.test(text) ? Number(text) : Number.NaN;
}

/** Property transform for integer environment variables; pair with `@IsInt()`. */
export function IntegerFromEnv(): PropertyDecorator {
  return Transform(({ value }) => parseEnvInteger(value));
}

const DECIMAL = /^-?(\d+\.?\d*|\.\d+)$/;

/**
 * Decimal environment value: unset or blank → `undefined` (the class default is
 * kept), a finite decimal string → number, anything else → `NaN` so
 * `@IsNumber()` rejects it (`Number('')` is 0 and `Number('1e400')` is
 * Infinity, so neither the constructor nor `parseFloat` is used).
 */
export function parseEnvNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return undefined;
  return DECIMAL.test(text) ? Number(text) : Number.NaN;
}

/** Property transform for decimal environment variables; pair with `@IsNumber()`. */
export function NumberFromEnv(): PropertyDecorator {
  return Transform(({ value }) => parseEnvNumber(value));
}

/** Property transform for string environment variables: blank keeps the default, otherwise trimmed. */
export function StringFromEnv(): PropertyDecorator {
  return Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text === '' ? undefined : text;
  });
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Boolean environment value: unset or blank → `undefined` (the class default is
 * kept), true/false spellings → boolean, anything else is returned as-is so
 * `@IsBoolean()` rejects it. (`Boolean('false')` is `true`, so implicit
 * conversion must never be used for these.)
 */
export function parseEnvBoolean(value: unknown): boolean | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === '') return undefined;
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  return String(value);
}

/** Property transform for boolean environment variables; pair with `@IsBoolean()`. */
export function BooleanFromEnv(): PropertyDecorator {
  return Transform(({ value }) => parseEnvBoolean(value));
}
