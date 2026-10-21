import { SynonymEngineService } from './synonym-engine.service';
import { MAX_EXPANDED_TERMS, MAX_SYNONYM_TOKENS } from './search-term';

describe('SynonymEngineService (roadmap 5.3)', () => {
  let findMany: jest.Mock;
  let service: SynonymEngineService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    service = new SynonymEngineService({ searchSynonym: { findMany } } as never);
  });

  it('looks every distinct token up in one query and merges the active synonyms', async () => {
    findMany.mockResolvedValueOnce([
      { term: 'soap', synonyms: 'Detergent, cleaning bar ,soap' },
      { term: 'bar', synonyms: 'slab' },
    ]);
    const expanded = await service.expandQuery('shop-1', 'Soap  soap BAR');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ shopId: 'shop-1', isActive: true, term: { in: ['soap', 'bar'] } });
    expect(expanded).toBe('soap bar detergent cleaning bar slab');
  });

  it('caps the tokens it looks up and the terms it returns', async () => {
    const query = Array.from({ length: 40 }, (_, i) => `t${i}`).join(' ');
    findMany.mockResolvedValueOnce([{ term: 't0', synonyms: Array.from({ length: 100 }, (_, i) => `s${i}`).join(',') }]);
    const expanded = await service.expandQuery('shop-1', query);
    expect(findMany.mock.calls[0][0].where.term.in).toHaveLength(MAX_SYNONYM_TOKENS);
    expect(expanded.split(' ').length).toBeLessThanOrEqual(MAX_EXPANDED_TERMS);
  });

  it('keeps every typed token in the expansion: only the synonym lookup is capped, synonyms fill the remaining slots', async () => {
    const query = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    findMany.mockResolvedValueOnce([{ term: 'w0', synonyms: 'a, b' }]);
    const expanded = await service.expandQuery('shop-1', query);
    expect(findMany.mock.calls[0][0].where.term.in).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
    expect(expanded.split(' ')).toEqual([...Array.from({ length: 12 }, (_, i) => `w${i}`), 'a', 'b']);
  });

  it('a repeated query parameter (an array) is treated as its first value, never a crash', async () => {
    findMany.mockResolvedValueOnce([]);
    await expect(service.expandQuery('shop-1', ['tea', 'coffee'] as never)).resolves.toBe('tea');
  });

  it('returns the query untouched when it has no tokens', async () => {
    expect(await service.expandQuery('shop-1', '   ')).toBe('   ');
    expect(findMany).not.toHaveBeenCalled();
  });
});
