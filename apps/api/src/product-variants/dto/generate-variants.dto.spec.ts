import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { attributeMatrixProblem, countCombinations, GenerateVariantsDto, MAX_VARIANT_COMBINATIONS } from './generate-variants.dto';

const errorsOf = (attributes: unknown) => validateSync(plainToInstance(GenerateVariantsDto, { attributes }));
const messageOf = (attributes: unknown) => Object.values(errorsOf(attributes)[0]?.constraints ?? {}).join('; ');

describe('GenerateVariantsDto (roadmap 5.2)', () => {
  it('accepts a bounded matrix', () => {
    expect(errorsOf({ Colour: ['Red', 'Blue'], Size: ['S', 'M', 'L'] })).toHaveLength(0);
    expect(countCombinations({ Colour: ['Red', 'Blue'], Size: ['S', 'M', 'L'] })).toBe(6);
    // Exactly the cap is allowed: 10 × 10 × 10.
    const ten = Array.from({ length: 10 }, (_, i) => `v${i}`);
    expect(errorsOf({ A: ten, B: ten, C: ten })).toHaveLength(0);
  });

  it('refuses a matrix that expands past the cap before anything is computed', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `v${i}`);
    const matrix = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`attr${i}`, hundred]));
    expect(countCombinations(matrix)).toBe(1e16);
    expect(messageOf(matrix)).toContain(`at most ${MAX_VARIANT_COMBINATIONS}`);
    expect(messageOf({ A: Array.from({ length: 11 }, (_, i) => `v${i}`), B: Array.from({ length: 10 }, (_, i) => `w${i}`), C: Array.from({ length: 10 }, (_, i) => `x${i}`) })).toContain('1100 variants');
  });

  it('refuses malformed input instead of letting it reach the service', () => {
    expect(messageOf({})).toContain('at least one attribute');
    expect(messageOf([])).toBeTruthy();
    expect(messageOf('x')).toBeTruthy();
    expect(messageOf({ Colour: [] })).toContain('at least one value');
    expect(messageOf({ Colour: ['Red', 1] })).toContain('strings');
    expect(messageOf({ Colour: ['Red', ''] })).toContain('strings');
    expect(messageOf({ Colour: ['Red', 'red'] })).toContain('listed twice');
    expect(messageOf({ Colour: ['Red'], colour: ['Blue'] })).toContain('listed twice');
    expect(messageOf({ '!!!': ['Red'] })).toContain('no letters or digits');
    expect(messageOf({ Colour: ['x'.repeat(51)] })).toContain('1-50');
    expect(messageOf(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`a${i}`, ['v']])))).toContain('at most 8 attributes');
    expect(messageOf({ Colour: Array.from({ length: 101 }, (_, i) => `v${i}`) })).toContain('at most 100 values');
  });

  it('the service-side check reports the same verdicts', () => {
    expect(attributeMatrixProblem({ Colour: ['Red'] })).toBeNull();
    expect(attributeMatrixProblem(null)).toBe('attributes must be an object');
  });
});
