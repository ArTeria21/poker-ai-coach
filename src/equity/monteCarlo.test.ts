import { describe, expect, it } from 'vitest';
import { monteCarloEquity } from './monteCarlo';

describe('monteCarloEquity vs known values', () => {
  it('AA heads-up vs a random hand ≈ 85%', () => {
    const r = monteCarloEquity({ hero: ['As', 'Ah'], board: [], opponents: 1, iterations: 20_000, seed: 1 });
    expect(r.equity).toBeGreaterThan(0.835);
    expect(r.equity).toBeLessThan(0.87);
  });

  it('72o heads-up vs a random hand ≈ 35%', () => {
    const r = monteCarloEquity({ hero: ['7h', '2c'], board: [], opponents: 1, iterations: 20_000, seed: 2 });
    expect(r.equity).toBeGreaterThan(0.32);
    expect(r.equity).toBeLessThan(0.38);
  });

  it('AA vs 4 random hands ≈ 56%', () => {
    const r = monteCarloEquity({ hero: ['As', 'Ah'], board: [], opponents: 4, iterations: 20_000, seed: 3 });
    expect(r.equity).toBeGreaterThan(0.52);
    expect(r.equity).toBeLessThan(0.60);
  });

  it('AKs vs QQ (known hand) ≈ 46%', () => {
    const r = monteCarloEquity({
      hero: ['As', 'Ks'],
      board: [],
      opponents: 0,
      knownOpponents: [['Qh', 'Qd']],
      iterations: 20_000,
      seed: 4,
    });
    expect(r.equity).toBeGreaterThan(0.43);
    expect(r.equity).toBeLessThan(0.49);
  });

  it('flush draw on the flop vs a set ≈ 26%', () => {
    // Ah9h on Kh 7h 2c vs KcKd (set of kings): draw needs to hit without board pairing
    const r = monteCarloEquity({
      hero: ['Ah', '9h'],
      board: ['Kh', '7h', '2c'],
      opponents: 0,
      knownOpponents: [['Kc', 'Kd']],
      iterations: 20_000,
      seed: 5,
    });
    expect(r.equity).toBeGreaterThan(0.2);
    expect(r.equity).toBeLessThan(0.31);
  });

  it('is deterministic for a fixed seed', () => {
    const a = monteCarloEquity({ hero: ['Js', 'Th'], board: ['9c', '8d', '2h'], opponents: 2, iterations: 5000, seed: 42 });
    const b = monteCarloEquity({ hero: ['Js', 'Th'], board: ['9c', '8d', '2h'], opponents: 2, iterations: 5000, seed: 42 });
    expect(a).toEqual(b);
  });

  it('is fast enough for the live coach (5k iterations well under 100ms)', () => {
    const start = performance.now();
    monteCarloEquity({ hero: ['Qs', 'Jd'], board: ['Tc', '4h', '2s'], opponents: 3, iterations: 5000, seed: 6 });
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(100);
  });
});

describe('range equity and validation', () => {
  const base = { hero: ['2c', '3d'] as [string, string], board: ['As', 'Ks', 'Qs', 'Js', 'Ts'], opponents: 0, iterations: 100, seed: 7 };
  it('splits board ties among known, ranged and unknown opponents', () => {
    expect(monteCarloEquity({ ...base, knownOpponents: [['4c', '5d']], opponentRanges: ['66'], opponents: 1 }).equity).toBe(0.25);
  });
  it('rejects invalid inputs and impossible joint ranges', () => {
    for (const opts of [
      { iterations: 0 }, { iterations: 1.5 }, { iterations: 1_000_001 }, { opponents: -1 },
      { board: ['As'] }, { hero: ['As', 'As'] }, { hero: ['XX', '3d'] },
      { knownOpponents: [['As', '4h']] }, { opponentRanges: ['AA', 'AA', 'AA'] },
    ]) expect(() => monteCarloEquity({ ...base, ...opts } as Parameters<typeof monteCarloEquity>[0])).toThrow();
  });
});

it('matches exhaustive joint range equity rather than sequentially filtered range sampling', async () => {
  const { parseRange } = await import('./ranges');
  const { cardCodes, evaluateCardCodes } = await import('phe');
  const hero: [string, string] = ['Kh', 'Kd'];
  const board = ['2c', '5d', '8h', 'Js', 'Qc'];
  const ranges = ['AcAd,6c7c', 'AcAh,AdAs,3c4c'];
  let sum = 0, count = 0;
  for (const a of parseRange(ranges[0])) for (const b of parseRange(ranges[1])) {
    if (new Set([...a, ...b]).size !== 4) continue;
    const ranks = [hero, a, b].map(h => evaluateCardCodes(cardCodes([...h, ...board])));
    const best = Math.min(...ranks);
    sum += ranks[0] === best ? 1 / ranks.filter(r => r === best).length : 0;
    count++;
  }
  // AA can coexist with only one second-opponent combo; 67 can coexist with all three.
  expect(count).toBe(4);
  const opts = { hero, board, opponents: 0, opponentRanges: ranges, iterations: 20_000, seed: 55 };
  const actual = monteCarloEquity(opts);
  expect(actual.equity).toBeCloseTo(sum / count, 2);
  expect(monteCarloEquity(opts)).toEqual(actual);
});

it('matches exhaustive one-card completions with a fixed opponent', async () => {
  const { freshDeck } = await import('../cards/deck');
  const { cardCodes, evaluateCardCodes } = await import('phe');
  const hero: [string, string] = ['Ah', '9h'];
  const villain: [string, string] = ['Kc', 'Kd'];
  const board = ['Kh', '7h', '2c', '3s'];
  const known = [...hero, ...villain, ...board];
  let sum = 0, count = 0;
  for (const river of freshDeck().filter(c => !known.includes(c))) {
    const h = evaluateCardCodes(cardCodes([...hero, ...board, river]));
    const v = evaluateCardCodes(cardCodes([...villain, ...board, river]));
    sum += h < v ? 1 : h === v ? 0.5 : 0;
    count++;
  }
  const opts = { hero, board, opponents: 0, opponentRanges: ['KcKd'], iterations: 20_000, seed: 42 };
  expect(monteCarloEquity(opts).equity).toBeCloseTo(sum / count, 2);
  expect(monteCarloEquity({ ...opts, opponentRanges: undefined, knownOpponents: [villain] }).equity).toBeCloseTo(sum / count, 2);
});

it('does not mutate caller cards or ranges, and applies known-hand blockers', () => {
  const opts = {
    hero: ['Kh', 'Kd'] as [string, string], board: ['2c', '5d', '8h', 'Js', 'Qc'],
    knownOpponents: [['Ac', 'Ad']] as [string, string][], opponentRanges: ['AcAh,6c7c'],
    opponents: 0, iterations: 200, seed: 12,
  };
  const before = structuredClone(opts);
  expect(monteCarloEquity(opts).equity).toBe(0);
  expect(opts).toEqual(before);
});
it('samples weighted joint ranges conditioned on collisions and applies blockers', () => {
  const opts = {
    hero: ['Kh','Kd'] as [string,string], board: ['2c','5d','8h','Js','Qc'], opponents: 0, iterations: 30_000, seed: 55,
    opponentRanges: [
      [{cards: ['Ac','Ad'] as [string,string], weight: 2}, {cards: ['6c','7c'] as [string,string], weight: 1}],
      [{cards: ['Ac','Ah'] as [string,string], weight: 3}, {cards: ['Ad','As'] as [string,string], weight: 1}, {cards: ['3c','4c'] as [string,string], weight: 2}],
    ],
  };
  // Valid joints weigh 4 (AA/34), 3 (67/AA), 1 (67/AA), 2 (67/34): hero wins only the last.
  expect(monteCarloEquity(opts).equity).toBeCloseTo(2/10, 2);
  const blocked = { ...opts, opponentRanges: [[{cards: ['Kh','Ah'] as [string,string],weight:100}, {cards: ['Ac','Ad'] as [string,string],weight:1}]] };
  expect(monteCarloEquity(blocked).equity).toBe(0);
});
it('rejects malformed, duplicate, nonfinite and empty weighted combos', () => {
  const base = {hero:['Kh','Kd'] as [string,string],board:[],opponents:0,iterations:1};
  for (const range of [
    [{cards:['Ac','Ad'],weight:-1}], [{cards:['Ac','Ad'],weight:NaN}], [{cards:['Ac','Ad'],weight:Infinity}],
    [{cards:['Ac','Ad'],weight:0}], [{cards:['Ac','Ac'],weight:1}], [{cards:['XX','Ac'],weight:1}],
    [{cards:['Kh','Ad'],weight:1}], [{cards:['Ac','Ad'],weight:1},{cards:['Ad','Ac'],weight:2}], [],
  ]) expect(() => monteCarloEquity({...base,opponentRanges:[range]} as unknown as Parameters<typeof monteCarloEquity>[0])).toThrow();
});
it('preserves weighted joint distribution under seat permutation and range weight scaling', () => {
  const a = [{cards:['Ac','Ad'] as [string,string],weight:1},{cards:['6c','7c'] as [string,string],weight:3}];
  const b = [{cards:['Ac','Ah'] as [string,string],weight:2},{cards:['3c','4c'] as [string,string],weight:1}];
  const opts={hero:['Kh','Kd'] as [string,string],board:['2c','5d','8h','Js','Qc'],opponents:0,iterations:30_000,seed:80};
  for(const opponentRanges of [[a,b],[b,a],[a.map(c=>({...c,weight:c.weight*1e300})),b]]) {
    expect(monteCarloEquity({...opts,opponentRanges}).equity).toBeCloseTo(0.3,2);
  }
});
it('awards side pots independently of whole-field showdown equity', () => {
  const base={hero:['Kh','Kd'] as [string,string],board:['2c','5d','8h','Js','9c'],opponents:0,knownOpponents:[['Ac','Ad'],['Qs','Qd']] as [string,string][],iterations:10,seed:1,oddChipOrder:[0,1,2]};
  const deep=monteCarloEquity({...base,pots:[{amount:180,eligible:[0,1,2]},{amount:300,eligible:[0,2]}]});
  expect(deep.equity).toBe(0); expect(deep.expectedAward).toBe(300); expect(deep.awardStandardError).toBe(0);
  const short=monteCarloEquity({...base,hero:['Ac','Ad'],knownOpponents:[['Kh','Kd'],['Qs','Qd']],pots:[{amount:180,eligible:[0,1,2]},{amount:300,eligible:[1,2]}]});
  expect(short.expectedAward).toBe(180);
});
it('allocates odd chips by the supplied clockwise order', () => {
  const base={hero:['2c','3d'] as [string,string],board:['As','Ks','Qs','Js','Ts'],opponents:0,knownOpponents:[['4c','5d']] as [string,string][],iterations:1,pots:[{amount:5,eligible:[0,1]}]};
  expect(monteCarloEquity({...base,oddChipOrder:[0,1]}).expectedAward).toBe(3);
  expect(monteCarloEquity({...base,oddChipOrder:[1,0]}).expectedAward).toBe(2);
});
it('uses every opponent blocker for side pot runouts', () => {
  const result=monteCarloEquity({hero:['Ah','Kh'],board:['Jh','Th','4c','5d'],opponents:0,knownOpponents:[['2h','3h'],['As','Ad']],iterations:30_000,seed:12,pots:[{amount:1,eligible:[1]},{amount:42,eligible:[0,2]}],oddChipOrder:[0,1,2]});
  expect(result.expectedAward).toBeCloseTo(10,0);
});
it('validates pot participants, safe amounts and odd-chip permutations', () => {
  const base={hero:['As','Ah'] as [string,string],board:[],opponents:1,iterations:1};
  for (const extra of [
    {pots:[{amount:-1,eligible:[0,1]}],oddChipOrder:[0,1]},
    {pots:[{amount:1.5,eligible:[0,1]}],oddChipOrder:[0,1]},
    {pots:[{amount:1,eligible:[] }],oddChipOrder:[0,1]},
    {pots:[{amount:1,eligible:[0,0]}],oddChipOrder:[0,1]},
    {pots:[{amount:1,eligible:[0,2]}],oddChipOrder:[0,1]},
    {pots:[{amount:1,eligible:[0,1]}],oddChipOrder:[0,0]},
    {pots:[{amount:1,eligible:[0,1]}]},
    {pots:[{amount:Number.MAX_SAFE_INTEGER,eligible:[0,1]},{amount:1,eligible:[0,1]}],oddChipOrder:[0,1]},
  ]) expect(()=>monteCarloEquity({...base,...extra})).toThrow();
});
