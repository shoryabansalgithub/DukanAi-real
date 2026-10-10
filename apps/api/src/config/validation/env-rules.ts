import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import * as path from 'path';

/**
 * Environment-value rules shared by the config domains: what counts as a
 * placeholder, what production demands of a secret, and what a URL list is.
 * Production means an explicit `NODE_ENV=production`; every other value (and
 * none) keeps the relaxed rule so local runs and tests keep their templates.
 */

/** Values the committed templates and generators leave behind. */
const PLACEHOLDER = /replace_me|your_|change_?me|placeholder|todo|xxx/i;

export const MIN_SECRET_LENGTH = 32;

export function isProductionEnv(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'production';
}

export function isPlaceholderValue(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

/** Reason a value is unfit as a production secret, or `null` when it is fit. */
export function productionSecretProblem(value: unknown, minLength = MIN_SECRET_LENGTH): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'is not set';
  if (isPlaceholderValue(value)) return 'is a template placeholder';
  if (value.length < minLength) return `is shorter than ${minLength} characters`;
  return null;
}

/**
 * A secret that production must not run with as a placeholder or a short
 * string. Outside production only non-emptiness is required (pair with
 * `@IsNotEmpty()` for that).
 */
export function IsProductionSecret(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isProductionSecret',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => !isProductionEnv() || productionSecretProblem(value) === null,
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} ${productionSecretProblem(args.value) ?? 'is invalid'}: production needs a real secret of at least ${MIN_SECRET_LENGTH} characters`,
      },
    });
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** Reason a comma-separated list of origins is unusable, or `null`. */
export function urlListProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'is not set';
  if (isProductionEnv() && isPlaceholderValue(value)) return 'is a template placeholder';
  const entries = value.split(',').map((entry) => entry.trim());
  const bad = entries.find((entry) => !isHttpUrl(entry));
  return bad === undefined ? null : `contains ${JSON.stringify(bad)}, which is not an absolute http(s) URL`;
}

/** One or more absolute http(s) URLs separated by commas; no placeholder in production. */
export function IsUrlList(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isUrlList',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => urlListProblem(value) === null,
        defaultMessage: (args: ValidationArguments) => `${args.property} ${urlListProblem(args.value) ?? 'is invalid'}`,
      },
    });
  };
}

/**
 * A value the committed templates leave behind (`___REPLACE_ME___`, `your_…`,
 * `CHANGE_ME`) is never a usable token, DSN or key, in any environment: a
 * placeholder that validates silently becomes "the" secret (roadmap 7.6).
 */
export function IsNotPlaceholder(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isNotPlaceholder',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => !isPlaceholderValue(value),
        defaultMessage: (args: ValidationArguments) => `${args.property} is a template placeholder`,
      },
    });
  };
}

/** Reason a filesystem root is unfit for production, or `null`. */
export function productionAbsolutePathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'is not set';
  if (isPlaceholderValue(value)) return 'is a template placeholder';
  if (!path.isAbsolute(value)) return `is relative (${JSON.stringify(value)}); a relative root depends on the working directory of whoever starts the process`;
  return null;
}

/**
 * A filesystem root (roadmap 7.5, `STORAGE_ROOT`) that production must set to
 * an absolute, non-placeholder path. Outside production a relative value is
 * accepted and resolved once at boot against the working directory (the
 * committed dev / test templates say `./data/storage`).
 */
export function IsProductionAbsolutePath(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isProductionAbsolutePath',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => !isProductionEnv() || productionAbsolutePathProblem(value) === null,
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} ${productionAbsolutePathProblem(args.value) ?? 'is invalid'}: production needs an absolute path such as /var/lib/dukaanai/storage`,
      },
    });
  };
}
