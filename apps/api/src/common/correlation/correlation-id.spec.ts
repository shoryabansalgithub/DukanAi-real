import { sanitizeIdentifier } from './correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('sanitizeIdentifier', () => {
  it('keeps a well-formed client value', () => {
    expect(sanitizeIdentifier('req-42_abc')).toBe('req-42_abc');
    expect(sanitizeIdentifier(['first-value', 'second'])).toBe('first-value');
  });

  it.each([undefined, '', 'a'.repeat(101), 'bad value', 'x\ny', 'é', 42])('replaces %j with a fresh UUID', (value) => {
    expect(sanitizeIdentifier(value)).toMatch(UUID);
  });

  it('never returns the same replacement twice', () => {
    expect(sanitizeIdentifier('')).not.toBe(sanitizeIdentifier(''));
  });
});
