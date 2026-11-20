import { clampSearchQuery, MAX_SEARCH_QUERY_LENGTH, MAX_SYNONYM_TOKENS, normalizeSearchQuery, parseLimit, sanitizeFulltextTerm, tokenizeForSynonyms } from './search-term';

describe('sanitizeFulltextTerm', () => {
  it('strips every MySQL boolean-mode operator', () => {
    expect(sanitizeFulltextTerm('+milk -powder >1 <2 (500) ~ml *x "amul" @home')).toBe(
      'milk powder 1 2 500 ml x amul home',
    );
  });

  it('collapses runs of whitespace and trims', () => {
    expect(sanitizeFulltextTerm('   parle   g    biscuit  ')).toBe('parle g biscuit');
    expect(sanitizeFulltextTerm('\tcoke\n\nzero')).toBe('coke zero');
  });

  it('returns an empty string when only operators or whitespace remain', () => {
    expect(sanitizeFulltextTerm('+-*')).toBe('');
    expect(sanitizeFulltextTerm('   ')).toBe('');
    expect(sanitizeFulltextTerm('')).toBe('');
    expect(sanitizeFulltextTerm(undefined)).toBe('');
    expect(sanitizeFulltextTerm(null)).toBe('');
  });

  it('returns an empty string for terms shorter than two characters', () => {
    expect(sanitizeFulltextTerm('a')).toBe('');
    expect(sanitizeFulltextTerm('a+')).toBe('');
    expect(sanitizeFulltextTerm('ab')).toBe('ab');
  });

  it('keeps ordinary punctuation that is not an operator', () => {
    expect(sanitizeFulltextTerm("lay's 50% off, 2.5l")).toBe("lay's 50% off, 2.5l");
  });

  it('never leaves a dangling operator that could break a boolean query', () => {
    const term = sanitizeFulltextTerm('"unterminated (paren');
    expect(term).not.toMatch(/[+\-><()~*"@]/);
  });
});

describe('normalizeSearchQuery', () => {
  it('trims and collapses whitespace but keeps operators for exact code matches', () => {
    expect(normalizeSearchQuery('  SKU-001  ')).toBe('SKU-001');
    expect(normalizeSearchQuery('890  1234')).toBe('890 1234');
    expect(normalizeSearchQuery(undefined)).toBe('');
  });
});

describe('parseLimit', () => {
  it('falls back for missing, non-numeric or non-positive input', () => {
    expect(parseLimit(undefined, 20, 100)).toBe(20);
    expect(parseLimit('abc', 20, 100)).toBe(20);
    expect(parseLimit('0', 20, 100)).toBe(20);
    expect(parseLimit('-5', 20, 100)).toBe(20);
  });

  it('caps at the maximum and floors decimals', () => {
    expect(parseLimit('500', 20, 100)).toBe(100);
    expect(parseLimit('7.9', 20, 100)).toBe(7);
    expect(parseLimit(15, 20, 100)).toBe(15);
  });
});

describe('clampSearchQuery (roadmap 5.3)', () => {
  it('normalises and keeps a short query as is', () => {
    expect(clampSearchQuery('  parle   g ')).toBe('parle g');
    expect(clampSearchQuery(undefined)).toBe('');
  });

  it('cuts a long query at a word boundary near the cap, never past it', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const cut = clampSearchQuery(words);
    expect(cut.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
    expect(cut.endsWith('word')).toBe(false);
    expect(words.startsWith(cut)).toBe(true);
    expect(clampSearchQuery('x'.repeat(500))).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
  });
});

describe('tokenizeForSynonyms (roadmap 5.3)', () => {
  it('lower-cases, de-duplicates, drops blanks and caps the token count', () => {
    expect(tokenizeForSynonyms('Soap  soap BAR bar Soap')).toEqual(['soap', 'bar']);
    expect(tokenizeForSynonyms(Array.from({ length: 30 }, (_, i) => `t${i}`).join(' '))).toHaveLength(MAX_SYNONYM_TOKENS);
    expect(tokenizeForSynonyms('')).toEqual([]);
  });

  describe('queryString / repeated parameters (roadmap 5.3 hardening)', () => {
    it('a repeated q arrives as an array and is read as its first string; anything else is absent', () => {
      expect(clampSearchQuery(['tea', 'coffee'])).toBe('tea');
      expect(clampSearchQuery([42, 'sugar'] as never)).toBe('sugar');
      expect(clampSearchQuery({ q: 'x' } as never)).toBe('');
      expect(clampSearchQuery(undefined)).toBe('');
      expect(tokenizeForSynonyms(['Rice Rice bag'])).toEqual(['rice', 'bag']);
    });
  });
});
