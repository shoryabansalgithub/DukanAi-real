import { AbcClass, Prisma, XyzClass } from '@prisma/client';
import { CLASSIFICATION_WEEKS, classifyAbc, classifyProducts, classifyXyz, coefficientOfVariation } from './classification-engine';

const D = (v: number | string) => new Prisma.Decimal(v);
const weeks = (units: number[]) => Array.from({ length: CLASSIFICATION_WEEKS }, (_, i) => units[i] ?? 0);

describe('classification engine (roadmap 4.9)', () => {
  describe('ABC', () => {
    it('walks the revenue ranking with 80 % / 95 % cumulative shares', () => {
      const classes = classifyAbc([
        { productId: 'hero', revenue: D(2600) },
        { productId: 'mid', revenue: D(200) },
        { productId: 'vary', revenue: D(160) },
        { productId: 'tail', revenue: D(10) },
        { productId: 'idle', revenue: D(0) },
        { productId: 'refunded', revenue: D(-50) },
      ]);
      expect(Object.fromEntries(classes)).toEqual({
        hero: AbcClass.A,
        mid: AbcClass.B,
        vary: AbcClass.B,
        tail: AbcClass.C,
        idle: AbcClass.UNCLASSIFIED,
        refunded: AbcClass.UNCLASSIFIED,
      });
    });

    it('the product that crosses a threshold still belongs to the class it started in', () => {
      // 70 + 20 = 90 %: the second product starts inside the top 80 %, so it is A; the third starts at 90 % -> B.
      const classes = classifyAbc([
        { productId: 'p1', revenue: D(70) },
        { productId: 'p2', revenue: D(20) },
        { productId: 'p3', revenue: D(6) },
        { productId: 'p4', revenue: D(4) },
      ]);
      expect([...classes.values()]).toEqual([AbcClass.A, AbcClass.A, AbcClass.B, AbcClass.C]);
    });

    it('a single seller is A and equal revenues rank deterministically by product id', () => {
      expect(classifyAbc([{ productId: 'only', revenue: D('0.01') }]).get('only')).toBe(AbcClass.A);
      // Five equal sellers: the fifth starts at exactly 80 %, so the id order decides which one is B.
      const equal = (ids: string[]) => classifyAbc(ids.map((productId) => ({ productId, revenue: D(10) })));
      const a = equal(['e', 'b', 'a', 'd', 'c']);
      const b = equal(['c', 'a', 'e', 'b', 'd']);
      expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
      expect(Object.fromEntries(a)).toEqual({ a: AbcClass.A, b: AbcClass.A, c: AbcClass.A, d: AbcClass.A, e: AbcClass.B });
    });

    it('an empty shop classifies nothing', () => {
      expect(classifyAbc([]).size).toBe(0);
    });
  });

  describe('XYZ', () => {
    it('coefficient of variation is population std dev over mean, null without demand', () => {
      expect(coefficientOfVariation([2, 2, 2, 2])).toBe(0);
      expect(coefficientOfVariation([0, 0, 0])).toBeNull();
      expect(coefficientOfVariation([])).toBeNull();
      expect(coefficientOfVariation([1, -1])).toBeNull();
      expect(coefficientOfVariation([1, 3])).toBeCloseTo(0.5, 10);
    });

    it('steady demand is X, intermittent Y, sporadic Z, none UNCLASSIFIED', () => {
      expect(classifyXyz(weeks(Array(13).fill(1)))).toBe(XyzClass.X);
      expect(classifyXyz(weeks([1, 1, 1, 1, 1, 1, 1, 1]))).toBe(XyzClass.Y); // 8 of 13 weeks, CV ~0.79
      expect(classifyXyz(weeks([2, 0, 0, 0, 0, 0, 2]))).toBe(XyzClass.Z); // 2 of 13 weeks, CV ~2.3
      expect(classifyXyz(weeks([1]))).toBe(XyzClass.Z);
      expect(classifyXyz(weeks([]))).toBe(XyzClass.UNCLASSIFIED);
      expect(classifyXyz(weeks([3, -3]))).toBe(XyzClass.UNCLASSIFIED);
    });
  });

  it('classifyProducts combines both axes per product', () => {
    const out = classifyProducts([
      { productId: 'hero', revenue: D(2600), weeklyUnits: weeks(Array(13).fill(1)) },
      { productId: 'idle', revenue: D(0), weeklyUnits: weeks([]) },
    ]);
    expect(out).toEqual([
      { productId: 'hero', abcClass: AbcClass.A, xyzClass: XyzClass.X },
      { productId: 'idle', abcClass: AbcClass.UNCLASSIFIED, xyzClass: XyzClass.UNCLASSIFIED },
    ]);
  });
});
