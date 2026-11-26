import { expect, it } from 'vitest';
import { icmEquities, icmOutcomeEV, bubbleFactor } from './icm';

it('matches a numerical ICM fixture and preserves payout totals', () => {
  expect(icmEquities([100], [60])).toEqual([60]);
  const equities = icmEquities([50, 30, 20], [60, 40, 0]);
  [43.5714285714, 33, 23.4285714286].forEach((x, i) => expect(equities[i]).toBeCloseTo(x, 8));
  expect(equities.reduce((a,b) => a+b, 0)).toBeCloseTo(100, 10);
  expect(icmEquities([500, 300, 200], [60, 40])).toEqual(equities);
  const permuted = icmEquities([20, 50, 30], [60, 40]);
  [equities[2], equities[0], equities[1]].forEach((x,i) => expect(permuted[i]).toBeCloseTo(x, 10));
});
it('pays zero stacks at explicitly settled bottom places', () => {
  expect(icmEquities([100, 0], [65, 35])).toEqual([65, 35]);
  expect(() => icmEquities([100, 0, 0], [60, 30, 10])).toThrow();
  expect(icmEquities([100, 0, 0], [60, 30, 10], [[1, 2]])).toEqual([60, 20, 20]);
  expect(icmEquities([100, 0, 0], [60, 30, 10], [[2], [1]])).toEqual([60, 10, 30]);
});
it('computes matched-risk bubble factors, including zero-prize-risk cases', () => {
  expect(bubbleFactor([50, 50], [65, 35], 0, 1, 50).factor).toBeCloseTo(1);
  expect(bubbleFactor([50, 50, 50], [50, 30], 0, 1, 50).factor).toBeCloseTo(1.6);
  expect(bubbleFactor([50, 30, 20], [100], 0, 1, 10).factor).toBeCloseTo(1);
  expect(bubbleFactor([50, 50, 50], [30, 30, 30], 0, 1, 50)).toMatchObject({ status: 'undefined', factor: null, riskPremium: null });
  expect(bubbleFactor([50, 50, 50], [50, 50], 0, 1, 50).factor).toBeCloseTo(2);
});
it('weights settled win, loss and tie outcomes independently', () => {
  const result = icmOutcomeEV([50, 50], [65, 35], 0, [
    { probability: 0.3, stacks: [100, 0] },
    { probability: 0.3, stacks: [0, 100] },
    { probability: 0.4, stacks: [50, 50] },
  ]);
  expect(result.expectedEquity).toBeCloseTo(50);
  expect(result.delta).toBeCloseTo(0);
});
it('rejects invalid stacks, payouts, settlement groups and probabilities', () => {
  for (const f of [
    () => icmEquities([1e18, 1], [10]), () => icmEquities([1.5, 2], [10]),
    () => icmEquities([1, -1], [10]), () => icmEquities([1, 2], [5, 10]),
    () => icmEquities([1, 2], [10, -1]), () => icmEquities([1, 0, 0], [10], [[1], [1]]),
    () => icmEquities([1, 0, 0], [10], [[0], [1,2]]),
    () => bubbleFactor([10, 20], [10], 0, 1, 11),
    () => icmOutcomeEV([1, 1], [10], 0, [{probability: 0.8, stacks: [2,0]}]),
    () => icmOutcomeEV([1, 1], [10], 0, [{probability: 1, stacks: [3,0]}]),
    () => icmOutcomeEV([500_000_000, 500_000_000], [10], 0, [{probability: 1, stacks: [1_000_000_001,0]}]),
  ]) expect(f).toThrow();
});
it('preserves symmetry, prize scaling and totals for six live players and split eliminations', () => {
  const stacks = [10, 20, 30, 40, 50, 60];
  const a = icmEquities(stacks, [100, 60, 30]);
  const b = icmEquities(stacks, [200, 120, 60]);
  a.forEach((x,i) => expect(b[i]).toBeCloseTo(2*x, 9));
  expect(a.reduce((x,y) => x+y, 0)).toBeCloseTo(190, 9);
  icmEquities([10,10,10,10,10,10], [100,60,30]).forEach(x => expect(x).toBeCloseTo(190/6, 9));
  const settled = icmEquities([60,40,0,0], [50,30,15,5], [[2,3]]);
  expect(settled[2]).toBe(10);
  expect(settled[3]).toBe(10);
  expect(settled.reduce((x,y) => x+y, 0)).toBeCloseTo(100, 9);
});
it('reports cancellation limits instead of a spurious precise bubble factor for tiny chip risks', () => {
  for (const payouts of [[100], [50,30,0]]) {
    expect(bubbleFactor([1e15,1e15,1e15], payouts, 0, 1, 1)).toMatchObject({ status: 'precision-limit', factor: null, riskPremium: null });
  }
});
