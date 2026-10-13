import { canonicalEmail, sameEmailAddress } from './email-address';

describe('canonicalEmail / sameEmailAddress (audit P0-1)', () => {
  it('lower-cases, trims and keeps an ASCII address as it is', () => {
    expect(canonicalEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it('encodes an internationalised domain to its ASCII form', () => {
    expect(canonicalEmail('owner@tést.local')).toBe('owner@xn--tst-bma.local');
    expect(canonicalEmail('owner@gmàil.com')).toBe('owner@xn--gmil-1na.com');
  });

  it('treats the composed and decomposed forms of one character as the same address', () => {
    const composed = 'owner@tést.local';
    const decomposed = 'owner@tést.local';
    expect(sameEmailAddress(composed, decomposed)).toBe(true);
  });

  it('never equates an accented lookalike with the stored address (the database collation does)', () => {
    expect(sameEmailAddress('owner@test.local', 'owner@tést.local')).toBe(false);
    expect(sameEmailAddress('owner@gmail.com', 'owner@gmàil.com')).toBe(false);
    expect(sameEmailAddress('strasse@shop.in', 'straße@shop.in')).toBe(false);
    expect(sameEmailAddress('Owner@Test.Local', 'owner@test.local')).toBe(true);
  });

  it('is false for a missing side', () => {
    expect(sameEmailAddress(null, 'a@b.c')).toBe(false);
    expect(sameEmailAddress('a@b.c', undefined)).toBe(false);
  });
});
