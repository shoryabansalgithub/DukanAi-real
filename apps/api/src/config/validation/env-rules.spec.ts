import { validateSync } from 'class-validator';
import { IsProductionSecret, IsUrlList, isPlaceholderValue, productionAbsolutePathProblem, productionSecretProblem, urlListProblem } from './env-rules';

class Secrets {
  @IsProductionSecret()
  secret: string;
}

class Origins {
  @IsUrlList()
  origins: string;
}

const withNodeEnv = (value: string | undefined, fn: () => void) => {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
};

const REAL_SECRET = 'k9vP2xR7mQ4tW8zB1nL6cH3jF5dS0aY2eU4iO7pA9sD1fG3h';

describe('environment value rules', () => {
  it.each(['___REPLACE_ME_IN_PRODUCTION___', 'your_jwt_secret_generate_with_openssl', 'CHANGE_ME', 'changeme-now', 'placeholder'])(
    'recognises the template placeholder %j',
    (value) => {
      expect(isPlaceholderValue(value)).toBe(true);
    },
  );

  it('does not mistake a real secret for a placeholder', () => {
    expect(isPlaceholderValue(REAL_SECRET)).toBe(false);
  });

  it('names what is wrong with a production secret', () => {
    expect(productionSecretProblem(undefined)).toBe('is not set');
    expect(productionSecretProblem('')).toBe('is not set');
    expect(productionSecretProblem('___REPLACE_ME_IN_PRODUCTION___')).toBe('is a template placeholder');
    expect(productionSecretProblem('short')).toBe('is shorter than 32 characters');
    expect(productionSecretProblem(REAL_SECRET)).toBeNull();
  });

  it('enforces the secret rule only under NODE_ENV=production', () => {
    withNodeEnv('production', () => {
      expect(validateSync(Object.assign(new Secrets(), { secret: '___REPLACE_ME_IN_PRODUCTION___' }))).toHaveLength(1);
      expect(validateSync(Object.assign(new Secrets(), { secret: 'short' }))).toHaveLength(1);
      expect(validateSync(Object.assign(new Secrets(), { secret: REAL_SECRET }))).toEqual([]);
    });
    withNodeEnv('development', () => {
      expect(validateSync(Object.assign(new Secrets(), { secret: 'your_jwt_secret_generate_with_openssl' }))).toEqual([]);
    });
    withNodeEnv(undefined, () => {
      expect(validateSync(Object.assign(new Secrets(), { secret: 'short' }))).toEqual([]);
    });
  });

  it('accepts one or more absolute http(s) origins and nothing else', () => {
    expect(urlListProblem('http://localhost:3000')).toBeNull();
    expect(urlListProblem('https://app.example.com, https://pos.example.com')).toBeNull();
    expect(urlListProblem('')).toBe('is not set');
    expect(urlListProblem('localhost:3000')).toMatch(/not an absolute http\(s\) URL/);
    expect(urlListProblem('https://a.example.com,,https://b.example.com')).toMatch(/""/);
    expect(urlListProblem('ftp://files.example.com')).toMatch(/ftp/);
  });

  it('refuses a placeholder origin in production only', () => {
    withNodeEnv('production', () => {
      expect(validateSync(Object.assign(new Origins(), { origins: '___REPLACE_ME_IN_PRODUCTION___' }))[0].constraints?.isUrlList).toMatch(/placeholder/);
      expect(validateSync(Object.assign(new Origins(), { origins: 'https://app.example.com' }))).toEqual([]);
    });
    withNodeEnv('development', () => {
      // Not a URL either way, so still refused, but for the URL reason.
      expect(validateSync(Object.assign(new Origins(), { origins: '___REPLACE_ME___' }))[0].constraints?.isUrlList).toMatch(/not an absolute/);
    });
  });

  it('a production storage root must be absolute and real (roadmap 7.5)', () => {
    expect(productionAbsolutePathProblem('/var/lib/dukaanai/storage')).toBeNull();
    expect(productionAbsolutePathProblem('./data/storage')).toMatch(/relative/);
    expect(productionAbsolutePathProblem('data/storage')).toMatch(/relative/);
    expect(productionAbsolutePathProblem('___REPLACE_ME_IN_PRODUCTION___')).toMatch(/placeholder/);
    expect(productionAbsolutePathProblem('')).toMatch(/not set/);
    expect(productionAbsolutePathProblem(undefined)).toMatch(/not set/);
  });
});
