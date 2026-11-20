import { legacyFolderName, legacyNamePattern, matchLegacyFolder } from './legacy-folder-match';

/** Audit P3: the legacy storage migration matches folders by the sanitised name and refuses a cross-shop clash. */
describe('legacy storage folder matching', () => {
  it('maps a customer name to its legacy folder name', () => {
    expect(legacyFolderName('Ramesh Kumar')).toBe('Ramesh_Kumar');
    expect(legacyFolderName('  Sharma & Sons. ')).toBe('Sharma_Sons');
    expect(legacyFolderName('../etc')).toBeNull();
  });

  it('builds a LIKE pattern every matching name satisfies', () => {
    expect(legacyNamePattern('Ramesh_Kumar')).toBe('%Ramesh%Kumar%');
    expect(legacyNamePattern('Sharma_Sons')).toBe('%Sharma%Sons%');
  });

  it('matches the one customer of the shop whose sanitised name is the folder (a literal name compare missed it)', () => {
    expect(matchLegacyFolder('Ramesh_Kumar', 'shop-a', [{ id: 'c1', shopId: 'shop-a', name: 'Ramesh Kumar' }, { id: 'c2', shopId: 'shop-a', name: 'Ramesh Kumari' }])).toEqual({ kind: 'match', customerId: 'c1' });
  });

  it('refuses a folder two customers of the shop map to, and one a customer of another shop maps to', () => {
    expect(matchLegacyFolder('Ravi', 'shop-a', [{ id: 'c1', shopId: 'shop-a', name: 'Ravi' }, { id: 'c2', shopId: 'shop-a', name: 'Ravi.' }]).kind).toBe('ambiguous');
    expect(matchLegacyFolder('Ravi', 'shop-a', [{ id: 'c1', shopId: 'shop-a', name: 'Ravi' }, { id: 'c9', shopId: 'shop-b', name: 'Ravi' }])).toMatchObject({ kind: 'ambiguous', reason: expect.stringContaining('other shop') });
    expect(matchLegacyFolder('Ravi', 'shop-a', [{ id: 'c9', shopId: 'shop-b', name: 'Ravi' }])).toEqual({ kind: 'none' });
  });
});
