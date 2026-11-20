import * as fs from 'fs';
import * as path from 'path';
import { canonicalState, INDIAN_STATES, STATE_ALIASES } from './states';

describe('Indian states (roadmap 9.20)', () => {
  it('is the list the web picker offers, in the same spelling', () => {
    const webFile = path.resolve(__dirname, '../../../../web/src/components/pos/indian-states.ts');
    const source = fs.readFileSync(webFile, 'utf8');
    const list = source.slice(source.indexOf('INDIAN_STATES'), source.indexOf('];'));
    const webStates = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(webStates).toEqual([...INDIAN_STATES]);
    // The aliases too, so the POS preview reads "Orissa" or "New Delhi" as the server does (audit B3).
    const aliases = source.slice(source.indexOf('STATE_ALIASES'), source.indexOf('};', source.indexOf('STATE_ALIASES')));
    const webAliases = Object.fromEntries([...aliases.matchAll(/^\s*'?([^':]+?)'?: '([^']+)',$/gm)].map((m) => [m[1], m[2]]));
    expect(webAliases).toEqual({ ...STATE_ALIASES });
  });

  it('returns the stored spelling whatever the case and spacing, and refuses what is not a state', () => {
    expect(canonicalState('  karnataka ')).toBe('Karnataka');
    expect(canonicalState('TAMIL   NADU')).toBe('Tamil Nadu');
    expect(canonicalState('Orissa')).toBe('Odisha');
    expect(canonicalState('Pondicherry')).toBe('Puducherry');
    expect(canonicalState('J&K')).toBe('Jammu and Kashmir');
    expect(canonicalState('Karnatak')).toBeUndefined();
    expect(canonicalState('Bangalore')).toBeUndefined();
  });
});
