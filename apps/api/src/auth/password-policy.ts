import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * The one password rule of the API (OWASP ASVS 4.0.3 V2.1, roadmap 9.15),
 * applied wherever a password is set: registration, an accepted invitation,
 * a reset through the emailed link and a change by the signed-in user.
 *
 * - 2.1.1: at least 12 characters after runs of spaces are collapsed.
 * - 2.1.2: at most 72 characters, because bcrypt hashes the first 72 bytes
 *   only and a longer password would be silently truncated.
 * - 2.1.7: refused when it is a commonly used password. The check is local
 *   (ASVS allows "the top 1,000 or 10,000 most common passwords which match
 *   the system's password policy"): the 12-character floor already excludes
 *   almost every entry of the public top lists, so the list here is the
 *   long tail that survives it, plus the shapes those lists are made of
 *   (one character repeated, digit runs, keyboard walks, a common base word
 *   padded with digits or symbols).
 * - 2.1.9: no composition rule (no mandatory upper/lower/digit/symbol).
 * - 2.1.10: no periodic rotation; the owner rotates on compromise (docs/SECRETS.md).
 *
 * Nothing here says why a password was refused beyond the category, and the
 * value itself is never logged.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 72;

/** Common passwords of 12 characters or more (lower case, spaces collapsed). */
const COMMON_PASSWORDS = new Set<string>([
  'password1234',
  'password12345',
  'password123456',
  'password1234567',
  'password12345678',
  'password123456789',
  'password!1234',
  'password@1234',
  'password#1234',
  'passw0rd1234',
  'p@ssw0rd1234',
  'p@ssword1234',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwertyuiop1234',
  'qwertyuiopasdfghjkl',
  'qwertyuiop[]',
  'qwerty123456',
  'qwerty1234567',
  'qwerty12345678',
  'qwerty123456789',
  '1234567890ab',
  '1234567890abc',
  '1234567890abcd',
  '1234567890qwerty',
  '1234567890-=',
  'abcdefghijkl',
  'abcdefghijklm',
  'abcdefghijklmn',
  'abcdefghijklmnop',
  'abcdefghijklmnopqrstuvwxyz',
  'abcd1234abcd',
  'abc123abc123',
  'iloveyou1234',
  'iloveyou12345',
  'iloveyou123456',
  'letmein12345',
  'letmein123456',
  'welcome12345',
  'welcome123456',
  'welcome1234567',
  'administrator',
  'administrator1',
  'administrator123',
  'adminadmin12',
  'adminadmin123',
  'admin1234567',
  'admin12345678',
  'superman1234',
  'superman12345',
  'batman123456',
  'trustno1trustno1',
  'changeme1234',
  'changeme12345',
  'changemenow1',
  'computer1234',
  'computer12345',
  'internet1234',
  'internet12345',
  'football1234',
  'football12345',
  'baseball1234',
  'basketball12',
  'basketball123',
  'princess1234',
  'princess12345',
  'sunshine1234',
  'sunshine12345',
  'monkey123456',
  'dragon123456',
  'master123456',
  'shadow123456',
  'michael12345',
  'jennifer1234',
  'whatever1234',
  'summer202020',
  'summer202121',
  'summer202222',
  'summer202323',
  'summer202424',
  'summer202525',
  'winter202020',
  'january12345',
  'password2020',
  'password2021',
  'password2022',
  'password2023',
  'password2024',
  'password2025',
  'password2026',
  'passwordpass',
  'secret123456',
  'secret1234567',
  'login1234567',
  'starwars1234',
  'liverpool123',
  'chelsea12345',
  'arsenal12345',
  'india1234567',
  'india@123456',
  'indian123456',
  'mumbai123456',
  'delhi1234567',
  'dukaan123456',
  'dukaanai1234',
  'dukaanai12345',
  'dukaanai@123',
  'shopkeeper12',
  'shopkeeper123',
  'myshop123456',
  'cashier12345',
  'cashier123456',
  'manager12345',
  'manager123456',
  'owner1234567',
  'owner12345678',
  'test12345678',
  'testtest1234',
  'testing12345',
  'testing123456',
  'temp12345678',
  'temporary123',
  'default12345',
  'default123456',
  'guest1234567',
  'guest12345678',
  'user12345678',
  'username1234',
  'aaaaaaaaaaaa',
  '111111111111',
  '123123123123',
  '123456123456',
  '112233445566',
  '121212121212',
  '123456654321',
  '0123456789ab',
  'qazwsxedcrfv',
  'qazwsxedcrfvtgb',
  'zaq12wsxcde3',
  '1qaz2wsx3edc',
  '1q2w3e4r5t6y',
  '1q2w3e4r5t6y7u8i',
  'asdfghjkl123',
  'asdfghjklqwe',
  'zxcvbnm12345',
  'zxcvbnmasdfg',
  'qwerasdfzxcv',
  'passwordisstrong',
  'mypassword12',
  'mypassword123',
  'mypassword1234',
  'newpassword1',
  'newpassword12',
  'newpassword123',
  'strongpassword',
  'strongpassword1',
  'securepassword',
  'securepassword1',
  'correcthorsebatterystaple',
]);

/** Shapes the common-password lists are made of; a match is refused whatever the exact value. */
const COMMON_SHAPES: RegExp[] = [
  /^(.)\1+$/, // one character repeated
  /^[0-9]+$/, // digits only
  /^(?:0123456789|1234567890|9876543210)+[0-9]*$/, // digit runs
  /^(?:qwertyuiop|asdfghjkl|zxcvbnm|qwerty|asdfgh|zxcvbn)+[0-9!@#$%^&*._-]*$/, // keyboard rows
  /^(?:abcdefghijklmnopqrstuvwxyz|abcdefghijkl)[a-z]*[0-9!@#$%^&*._-]*$/, // the alphabet
  /^(?:password|passw0rd|p@ssw0rd|p@ssword|passwort|welcome|letmein|iloveyou|qwerty|admin|administrator|changeme|dukaan|dukaanai|shopkeeper)[0-9!@#$%^&*._-]{0,12}$/, // a base word padded
];

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Why `value` does not satisfy the policy, or null when it does. The reason never contains the value. */
export function passwordPolicyProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string';
  const normalised = normalise(value);
  if (normalised.length < MIN_PASSWORD_LENGTH) return `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (value.length > MAX_PASSWORD_LENGTH) return `must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (COMMON_PASSWORDS.has(normalised) || COMMON_SHAPES.some((shape) => shape.test(normalised))) {
    return 'is too common; choose a longer phrase that is not a well-known password';
  }
  return null;
}

/** Thrown-by-the-DTO form of the policy: `@IsAcceptablePassword()` on every password property. */
export function IsAcceptablePassword(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isAcceptablePassword',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => passwordPolicyProblem(value) === null,
        defaultMessage: (args: ValidationArguments) => `${args.property} ${passwordPolicyProblem(args.value) ?? 'is invalid'}`,
      },
    });
  };
}
