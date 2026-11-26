import { expect, it } from 'vitest';
import { drawCompletionOuts, potOdds, effectiveStack, spr, terminalCallEV, headsUpRaiseEV } from './pokerMath';

it('counts the union of straight and flush completions, not duplicated draw labels', () => {
  const result = drawCompletionOuts({ hero: ['6h', '7h'], board: ['4h', '5c', 'Jh'] });
  expect(result.flush).toHaveLength(9);
  expect(result.straight).toHaveLength(8);
  expect(result.union).toHaveLength(15);
  expect(result.nextCardProbability).toBe(15 / 47);
});
it('separates current next-card leaders from structural draw completions', () => {
  const result = drawCompletionOuts({ hero: ['Ah', '9h'], board: ['Kh', '7h', '2c', '2d'], knownOpponents: [['Kc', 'Kd']] });
  expect(result.flush).toHaveLength(9);
  expect(result.nextCardLeaders?.winning).toEqual([]);
  expect(result.nextCardLeaders?.tying).toEqual([]);
  expect(result.unseenCards).toBe(44);
});
it('ignores board-only draws and has no river draws', () => {
  expect(drawCompletionOuts({ hero: ['Ah', 'Ad'], board: ['Ks', 'Qs', '8s', '2s'] }).union).toEqual([]);
  expect(drawCompletionOuts({ hero: ['6h', '7h'], board: ['4h', '5c', 'Jh', 'As', 'Kd'] }).nextCardProbability).toBe(0);
});
it('computes odds, current-street cover and explicitly undefined zero-pot SPR', () => {
  expect(potOdds(100, 50)).toBe(1 / 3);
  expect(potOdds(0, 0)).toBe(0);
  expect(effectiveStack({ behind: 80, streetBet: 20 }, { behind: 40, streetBet: 60 })).toEqual({ totalStreetCover: 100, heroAdditionalCover: 80, opponentAdditionalCover: 40 });
  expect(spr(100, 50)).toEqual({ status: 'finite', value: 2 });
  expect(spr(100, 0)).toEqual({ status: 'undefined', value: null });
});
it('uses explicit terminal pot shares and conditional called equity', () => {
  expect(terminalCallEV(100, 50, 0.4)).toBe(10);
  expect(headsUpRaiseEV({ pot: 100, heroCost: 100, opponentCall: 50, foldProbability: 0.4, equityWhenCalled: 0.5 })).toBe(55);
  for (const f of [() => potOdds(-1, 2), () => terminalCallEV(10, 2, 1.1), () => spr(NaN, 10), () => effectiveStack({ behind: -1, streetBet: 0 }, { behind: 1, streetBet: 0 })]) expect(f).toThrow();
});
it('finds pair and set category improvements separately from draw completion outs', () => {
  const pair = drawCompletionOuts({ hero: ['Ah', 'Kd'], board: ['2c', '7s', '9d'] });
  expect(pair.categoryImprovement).toContain('Ac');
  expect(pair.union).not.toContain('Ac');
  const set = drawCompletionOuts({ hero: ['Ah', 'Ad'], board: ['2c', '7s', '9d'] });
  expect(set.categoryImprovement).toContain('Ac');
});
it('handles wheel/broadway gutshots, board-only straights, ties and all known players', () => {
  expect(drawCompletionOuts({ hero: ['Ah', 'Kd'], board: ['Qc', 'Js', '2d'] }).straight).toHaveLength(4);
  expect(drawCompletionOuts({ hero: ['Ah', '2d'], board: ['3c', '4s', '9d'] }).straight).toHaveLength(4);
  expect(drawCompletionOuts({ hero: ['2c', '2d'], board: ['9h', 'Ts', 'Jc', 'Qd'] }).straight).toEqual([]);
  const tied = drawCompletionOuts({ hero: ['2c', '3d'], board: ['As', 'Ks', 'Qs', 'Js'], knownOpponents: [['4c', '5d'], ['6c', '7d']] });
  expect(tied.nextCardLeaders?.tying).toContain('Ts');
  expect(tied.nextCardLeaders?.winning).not.toContain('Ts');
});
