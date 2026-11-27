import { describe, expect, it } from 'vitest';
import { icmEquities } from '../src/math/icm';
import { tools } from './tools';

const run = async (name: keyof typeof tools, input: unknown) =>
  await (tools[name].execute as (input: unknown, options: unknown) => unknown)(input, { toolCallId: 't', messages: [], context: {} }) as Record<string, unknown>;

describe('coach math tools', () => {
  it('equity: AA vs KK preflop is about 82% and repeatable', async () => {
    const input = { hero: ['Ah', 'Ad'], board: [], opponents: ['KsKc'] };
    const result = await run('equity', input);
    expect(result.equity).toBeCloseTo(0.82, 1);
    expect(result.rangeCombos).toEqual([{ range: 'KsKc', combos: 1 }]);
    expect(await run('equity', input)).toEqual(result);
    expect(await run('equity', { ...input, iterations: 20_000 })).toEqual(result);
    const mixed = await run('equity', { hero: ['Ah', 'Ad'], board: [], opponents: ['QQ', 'random'], iterations: 2000 });
    expect(await run('equity', { hero: ['Ah', 'Ad'], board: [], opponents: ['Random', 'QQ'], iterations: 2000 })).toEqual(mixed);
  });

  it('equity: ranges count combos after blockers and mix with random opponents', async () => {
    const result = await run('equity', { hero: ['Ah', 'Qd'], board: [], opponents: ['TT+, AQs+, AKo', 'random'], iterations: 5000 });
    // Ah and Qd block: TT 6 + JJ 6 + QQ 3 + KK 6 + AA 3, AQs 2 + AKs 3, AKo 9
    expect(result.rangeCombos).toEqual([{ range: 'TT+, AQs+, AKo', combos: 24 + 5 + 9 }]);
    expect(result.equity).toBeGreaterThan(0.2);
    expect(result.equity).toBeLessThan(0.5);
  });

  it('shove_ev: EV versus folding at the decision, in chips and BB, with errors as { error }', async () => {
    // SB 6 BB with blinds 50/100: 150 posted, the shove adds 550, the BB adds 500 to call.
    expect(await run('shove_ev', { pot: 150, heroCost: 550, opponentCall: 500, foldProbability: 0.7, equityWhenCalled: 0.35, bigBlind: 100 }))
      .toEqual({ evChips: 66, evBB: 0.66, assumption: expect.stringContaining('terminal') });
    expect((await run('shove_ev', { pot: 150, heroCost: 550, opponentCall: 500, foldProbability: 1, equityWhenCalled: 0 })).evChips).toBe(150);
    // Shorter caller: blinds 50/100 + BBA 100, BB 1000 at hand start has 800 behind; heroCost = his street bet after calling (900) - the SB's 50.
    expect((await run('shove_ev', { pot: 250, heroCost: 850, opponentCall: 800, foldProbability: 0.5, equityWhenCalled: 0.4 })).evChips).toBe(80);
    expect(await run('shove_ev', { pot: -1, heroCost: 550, opponentCall: 500, foldProbability: 0.7, equityWhenCalled: 0.35 })).toEqual({ error: expect.any(String) });
  });

  it('icm outcomes: ICM EV of a bubble shove versus the fold baseline', async () => {
    // Blinds 50/100, hero SB 900 shoves into BB 1500, others 3000 and 600; BB folds 60%, hero has 40% when called.
    const fold = [850, 1550, 3000, 600], steal = [1000, 1400, 3000, 600], win = [1800, 600, 3000, 600], lose = [0, 2400, 3000, 600];
    const payouts = [0.5, 0.3, 0.2];
    const result = await run('icm', { stacks: fold, payouts, hero: 0, outcomes: [{ probability: 0.6, stacks: steal }, { probability: 0.16, stacks: win }, { probability: 0.24, stacks: lose }] });
    const eq = (stacks: number[]) => icmEquities(stacks, payouts)[0];
    expect(result.delta).toBeCloseTo(0.6 * eq(steal) + 0.16 * eq(win) + 0.24 * eq(lose) - eq(fold), 4);
    // Plus in chips, minus in prize equity: the bubble makes the shove a fold.
    expect((await run('shove_ev', { pot: 150, heroCost: 850, opponentCall: 800, foldProbability: 0.6, equityWhenCalled: 0.4 })).evChips).toBe(38);
    expect(result.delta).toBeLessThan(0);
    expect(await run('icm', { stacks: fold, payouts, hero: 0, outcomes: [{ probability: 1, stacks: [0, 0, 0, 0] }] })).toEqual({ error: expect.stringMatching(/conserve chips/) });
  });

  it('range_combos applies blockers', async () => {
    expect(await run('range_combos', { range: 'AA', blockers: ['Ah'] })).toEqual({ combos: 3, combosWithoutBlockers: 6 });
  });

  it('pot_odds: calling 50 into 150 needs 25% and gives terminal EV', async () => {
    expect(await run('pot_odds', { potBeforeCall: 150, toCall: 50, heroEquity: 0.3 })).toEqual({
      requiredEquity: 0.25, oddsRatio: '3:1', finalPot: 200, callEV: 10, assumption: expect.any(String),
    });
  });

  it('outs: flop flush draw has 9 completion cards, 9/47 next card, exact by river', async () => {
    const result = await run('outs', { hero: ['Ah', '5h'], board: ['Kh', '8h', '2c'] });
    expect(result).toMatchObject({ completionCards: 9, unseenCards: 47, nextCardProbability: 0.1915, byRiverProbability: 0.3497 });
    expect((await run('outs', { hero: ['Ah', '5h'], board: ['Kh', '8h', '2c', '3d'] })).byRiverProbability).toBeNull();
  });

  it('icm: two equal stacks split 65/35 evenly; bubble factor with three left', async () => {
    expect(await run('icm', { stacks: [1000, 1000], payouts: [0.65, 0.35] })).toEqual({ equities: [0.5, 0.5] });
    expect(await run('icm', { stacks: [0, 12000], payouts: [0.65, 0.35] })).toEqual({ equities: [0.35, 0.65] });
    const result = await run('icm', { stacks: [4000, 4000, 4000], payouts: [0.65, 0.35], hero: 0, opponent: 1, risk: 4000 });
    expect(result).toEqual({ equities: [0.3333, 0.3333, 0.3333], bubbleFactor: 1.5385, status: 'finite' });
    expect(await run('icm', { stacks: [4000, 4000, 4000], payouts: [0.65, 0.35], hero: 0, opponent: 1 })).toHaveProperty('error');
  });

  it('invalid input returns { error } instead of throwing', async () => {
    expect(await run('equity', { hero: ['Ah', 'Ah'], board: [], opponents: ['random'] })).toEqual({ error: 'Duplicate card' });
    expect(await run('equity', { hero: ['Ah', 'Kd'], board: ['2c'], opponents: ['random'] })).toHaveProperty('error');
    expect(await run('range_combos', { range: 'XYZ', blockers: [] })).toHaveProperty('error');
    expect(await run('icm', { stacks: [100, 200], payouts: [0.35, 0.65] })).toHaveProperty('error');
    expect(await run('pot_odds', { potBeforeCall: 1.5, toCall: 1 })).toHaveProperty('error');
  });
});
