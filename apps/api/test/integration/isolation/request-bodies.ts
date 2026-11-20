import { Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validateSync, ValidationError } from 'class-validator';
import { randomUUID } from 'crypto';

/**
 * Builds a request body that passes a route's DTO validation, from the
 * class-validator / class-transformer metadata of the DTO itself, so the
 * cross-shop suite reaches the code behind the validation pipe on every
 * write route (a body refused with 400 never tests an ownership check).
 *
 * Every field that names a row (`...Id`, `...Ids`, `parentId`, ...) takes its
 * value from `ids(field)`: the suite fills them with the attacker's own rows
 * and then, one field at a time, with the victim shop's.
 */

interface Meta {
  type: string;
  name?: string;
  propertyName: string;
  constraints: unknown[];
  each: boolean;
}

// class-transformer keeps its @Type() registry here; the package exports no accessor for it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const transformerStorage = (require('class-transformer/cjs/storage') as { defaultMetadataStorage: { findTypeMetadata(target: unknown, property: string): { typeFunction: (options?: unknown) => unknown } | undefined } }).defaultMetadataStorage;

/** A field that holds the id of a row (the suite swaps these for another shop's). */
export function isIdField(field: string): boolean {
  return /(^id$|Id$|Ids$|^ids$)/.test(field);
}

export type IdSource = (field: string, path: string) => string | undefined;

function metadataOf(dto: Type<unknown>): Map<string, Meta[]> {
  const all = getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false) as unknown as Meta[];
  const byProperty = new Map<string, Meta[]>();
  for (const m of all) byProperty.set(m.propertyName, [...(byProperty.get(m.propertyName) ?? []), m]);
  return byProperty;
}

const constraint = (ms: Meta[], name: string) => ms.find((m) => m.name === name)?.constraints;
const has = (ms: Meta[], ...names: string[]) => ms.some((m) => m.name !== undefined && names.includes(m.name));

/** Strings tried against a `@Matches` pattern, in order. */
const PATTERN_CANDIDATES = ['ISO1', 'iso-1', 'abc', 'ABC', 'A1', '1', '9876543210', '+919876543210', '560001', '29ABCDE1234F1Z5', '#123456', 'Iso Test', '0 0 * * *', 'x'];

/** Fields whose name says what a valid value looks like. */
function byName(field: string, tag: string): unknown {
  const f = field.toLowerCase();
  if (f === 'email' || f.endsWith('email')) return `iso-${randomUUID().slice(0, 8)}@test.local`;
  if (f === 'phone' || f.endsWith('phone') || f === 'mobile') return `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  if (f.includes('password')) return 'Correct-Horse-Battery-9';
  if (f === 'gstin') return '29ABCDE1234F1Z5';
  if (f === 'pincode' || f === 'postalcode') return '560001';
  if (f === 'state' || f === 'placeofsupply') return 'Karnataka';
  if (f === 'idempotencykey') return randomUUID();
  if (f === 'currency') return 'INR';
  if (f === 'url' || f.endsWith('url')) return 'https://hooks.example.com/iso';
  if (f === 'timezone') return 'Asia/Kolkata';
  if (f === 'refreshtoken' || f === 'token' || f === 'idtoken') return `tok-${tag}`;
  return undefined;
}

const DAY_MS = 86_400_000;
const BASE = Date.now();

/** A future date; one that ends a period (`endDate`, `expiresAt`, `dueDate`, ...) lies after one that starts it. */
function dateFor(field: string): string {
  return new Date(BASE + (/(end|expir|until|due|^to$)/i.test(field) ? 30 : 1) * DAY_MS).toISOString();
}

function numberFor(ms: Meta[]): number {
  let v = 1;
  const min = constraint(ms, 'min')?.[0];
  const max = constraint(ms, 'max')?.[0];
  if (typeof min === 'number') v = Math.max(v, min);
  if (typeof max === 'number') v = Math.min(v, max);
  if (has(ms, 'isPositive') && v <= 0) v = 1;
  return v;
}

function stringFor(field: string, ms: Meta[], tag: string): string {
  const pattern = constraint(ms, 'matches');
  if (pattern) {
    const re = pattern[0] instanceof RegExp ? pattern[0] : new RegExp(String(pattern[0]), typeof pattern[1] === 'string' ? pattern[1] : undefined);
    const found = PATTERN_CANDIDATES.find((c) => re.test(c));
    if (found) return found;
  }
  let min = 1;
  let max = 191;
  const length = constraint(ms, 'isLength');
  if (length) {
    min = Number(length[0] ?? 1);
    if (typeof length[1] === 'number') max = length[1];
  }
  const minLength = constraint(ms, 'minLength')?.[0];
  const maxLength = constraint(ms, 'maxLength')?.[0];
  if (typeof minLength === 'number') min = Math.max(min, minLength);
  if (typeof maxLength === 'number') max = Math.min(max, maxLength);
  let s = `Iso ${field} ${tag}`;
  while (s.length < min) s += 'x';
  return s.slice(0, max);
}

function scalarFor(field: string, ms: Meta[], designType: unknown, path: string, ids: IdSource, tag: string): unknown {
  if (isIdField(field) && !has(ms, 'isInt', 'isNumber', 'isBoolean')) return ids(field.replace(/Ids$/, 'Id').replace(/^ids$/, 'id'), path) ?? randomUUID();
  const enumValues = constraint(ms, 'isEnum')?.[0];
  if (enumValues && typeof enumValues === 'object') return Object.values(enumValues as Record<string, unknown>).find((v) => typeof v === 'string' || typeof v === 'number');
  const inValues = constraint(ms, 'isIn')?.[0];
  if (Array.isArray(inValues)) return inValues[0];
  if (has(ms, 'isAcceptablePassword')) return 'Correct-Horse-Battery-9';
  const named = byName(field, tag);
  if (named !== undefined && !has(ms, 'isInt', 'isNumber', 'isBoolean', 'isEnum')) return named;
  if (has(ms, 'isBoolean') || designType === Boolean) return false;
  if (has(ms, 'isNumberString')) return '1';
  if (has(ms, 'isInt', 'isNumber', 'isPositive', 'min', 'max', 'isDecimal') || designType === Number) return numberFor(ms);
  if (has(ms, 'isDateString', 'isISO8601', 'isDate', 'minDate') || designType === Date) return dateFor(field);
  if (has(ms, 'isEmail')) return `iso-${randomUUID().slice(0, 8)}@test.local`;
  if (has(ms, 'isUrl')) return 'https://hooks.example.com/iso';
  if (has(ms, 'isUUID')) return randomUUID();
  if (has(ms, 'isObject') || designType === Object) return {};
  return stringFor(field, ms, tag);
}

/** The class a nested field holds (`@Type(() => X)`, else the declared type). */
function nestedClassOf(dto: Type<unknown>, field: string): Type<unknown> | undefined {
  const typeFn = transformerStorage.findTypeMetadata(dto, field)?.typeFunction;
  const nested = (typeFn?.() ?? Reflect.getMetadata('design:type', dto.prototype as object, field)) as Type<unknown> | undefined;
  return nested && nested !== Object && nested !== Array ? nested : undefined;
}

/** Whether `dto`, or a class nested in it, has a field that names a row. */
function namesRows(dto: Type<unknown>, depth = 0): boolean {
  if (depth > 4) return false;
  for (const [field, ms] of metadataOf(dto)) {
    if (isIdField(field)) return true;
    const nested = ms.some((m) => m.type === 'nestedValidation') ? nestedClassOf(dto, field) : undefined;
    if (nested && namesRows(nested, depth + 1)) return true;
  }
  return false;
}

const isOptional = (ms: Meta[]) => ms.some((m) => m.type === 'conditionalValidation' && m.name === 'isOptional');
const conditionOf = (ms: Meta[]) => ms.find((m) => m.type === 'conditionalValidation' && m.name !== 'isOptional')?.constraints[0] as ((o: unknown, v: unknown) => boolean) | undefined;

/**
 * A body for `dto`: every required field, every field a `@ValidateIf` asks
 * for once the rest is in place (a field that names a row is preferred over
 * its alternative), and every optional field that names a row, directly or
 * in a nested object (so an attack can put another shop's id there).
 */
export function exampleBody(dto: Type<unknown>, ids: IdSource, tag = 'x', path = '', depth = 0): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (depth > 4) return body;
  const prototype = dto.prototype as object;
  const conditional: Array<{ field: string; condition: (o: unknown, v: unknown) => boolean }> = [];
  for (const [field, ms] of metadataOf(dto)) {
    if (ms.every((m) => m.type === 'whitelistValidation')) continue;
    const designType = Reflect.getMetadata('design:type', prototype, field) as unknown;
    const nestedClass = ms.some((m) => m.type === 'nestedValidation') ? nestedClassOf(dto, field) : undefined;
    if (isOptional(ms) && !isIdField(field) && !(nestedClass && namesRows(nestedClass))) continue;
    // An optional field naming a row the caller has none of is left out: a made-up id would stop the request at that lookup.
    if (isOptional(ms) && isIdField(field) && !nestedClass && ids(field.replace(/Ids$/, 'Id').replace(/^ids$/, 'id'), path ? `${path}.${field}` : field) === undefined) continue;
    const condition = conditionOf(ms);
    if (condition) conditional.push({ field, condition });
    const isArray = has(ms, 'isArray', 'arrayMinSize', 'arrayNotEmpty') || ms.some((m) => m.each) || designType === Array;
    const count = Math.max(1, Number(constraint(ms, 'arrayMinSize')?.[0] ?? 1));
    const here = path ? `${path}.${field}` : field;
    const one = nestedClass ? exampleBody(nestedClass, ids, tag, here, depth + 1) : ms.some((m) => m.type === 'nestedValidation') ? {} : scalarFor(field, ms, designType, here, ids, tag);
    body[field] = isArray ? Array.from({ length: count }, () => one) : one;
  }
  // Settle the alternatives: fields that do not name a row give way first.
  conditional.sort((a, b) => Number(isIdField(a.field)) - Number(isIdField(b.field)));
  for (const { field, condition } of conditional) if (!condition(body, body[field])) delete body[field];
  return body;
}

/** The validation pipe's verdict on `body` (empty when it passes), as the global ValidationPipe is configured. */
export function bodyProblems(dto: Type<unknown>, body: unknown): string[] {
  const instance = plainToInstance(dto, body) as object;
  const flatten = (errors: ValidationError[], prefix = ''): string[] =>
    errors.flatMap((e) => [
      ...Object.values(e.constraints ?? {}).map((m) => `${prefix}${m}`),
      ...flatten(e.children ?? [], `${prefix}${e.property}.`),
    ]);
  return flatten(validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }));
}

/** Every path in `body` whose key names a row: `['customerId', 'items.0.productId', ...]`. */
export function idPaths(body: unknown, prefix = ''): string[] {
  if (Array.isArray(body)) return body.flatMap((v, i) => idPaths(v, `${prefix}${i}.`));
  if (!body || typeof body !== 'object') return [];
  return Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => {
    if (isIdField(k) && (typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) return [`${prefix}${k}`];
    return idPaths(v, `${prefix}${k}.`);
  });
}

/** A deep copy of `body` with the value at `path` replaced (an array of ids gets `[value]`). */
export function withValueAt(body: unknown, path: string, value: string): unknown {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const parts = path.split('.');
  let node: Record<string, unknown> = copy;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  const last = parts[parts.length - 1];
  node[last] = Array.isArray(node[last]) ? [value] : value;
  return copy;
}
