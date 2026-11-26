import { cardCodes, evaluateCardCodes } from 'phe';
import type { Card } from '../engine/types';
import { concreteRange, validateCards, type OpponentRange } from './ranges';
import { freshDeck } from '../engine/deck';
import { mulberry32, randInt, randomSeed } from '../engine/rng';

/** Precomputed phe codes for all 52 cards. */
const CODE = new Map<Card, number>(
  (() => {
    const deck = freshDeck();
    const codes = cardCodes(deck);
    return deck.map((c, i) => [c, codes[i]] as [Card, number]);
  })(),
);

export class RangeSamplingError extends Error {}

export interface EquityOptions {
  hero: [Card, Card];
  board: Card[];
  /** Number of opponents holding unknown (random) hands. */
  opponents: number;
  /** Opponents with known hands (drills, tests, modeled reads). */
  knownOpponents?: [Card, Card][];
  /** Additional opponents, each drawn from their range weights (strings give uniform combos). */
  opponentRanges?: OpponentRange[];
  /** Participants: hero=0, then uniform unknowns, ranged opponents, known hands. */
  pots?: { amount: number; eligible: number[] }[];
  /** Clockwise participant permutation, required with pots for integer odd chips. */
  oddChipOrder?: number[];
  iterations: number;
  /** Fixed seed for reproducible results (tests). */
  seed?: number;
}

export interface EquityResult {
  /** Always completed through the river; this is showdown equity, not one-card outs or action EV. */
  horizon?: 'showdown';
  /** Hero's expected share of the pot, 0..1 (ties split fractionally). */
  equity: number;
  /** Hero chips awarded by the supplied pots, excluding any uncalled refund. */
  expectedAward?: number;
  /** Sampling SE of expectedAward; null for a single sample. */
  awardStandardError?: number | null;
  /** Fraction of iterations hero wins outright. */
  win: number;
  /** Fraction of iterations hero ties for best. */
  tie: number;
  iterations: number;
}

/**
 * Monte Carlo equity: deals random completions of the board and random
 * opponent hands, evaluates everyone with phe, and tallies hero's pot share.
 * Pure and synchronous — run it inside the web worker for UI use; call it
 * directly in tests. ~5,000 iterations ≈ ±0.7% standard error.
 */
export function monteCarloEquity(opts: EquityOptions): EquityResult {
  const { hero, board, opponents, knownOpponents = [], iterations } = opts;
  if (![0, 3, 4, 5].includes(board.length)) throw new Error('Invalid board length');
  if (hero.length !== 2 || knownOpponents.some(h => h.length !== 2)) throw new Error('Hands need two cards');
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) throw new Error('iterations must be 1..1000000');
  if (!Number.isInteger(opponents) || opponents < 0 || opponents > 22) throw new Error('Invalid opponent count');
  if (opts.seed !== undefined && !Number.isSafeInteger(opts.seed)) throw new Error('Invalid seed');
  validateCards([...hero, ...board, ...knownOpponents.flat()]);
  const rng = mulberry32(opts.seed ?? randomSeed());

  const known = new Set<Card>([...hero, ...board, ...knownOpponents.flat()]);
  const ranges = (opts.opponentRanges ?? []).map(range => {
    const combos = concreteRange(range, [...known]);
    const maxWeight = Math.max(...combos.map(combo => combo.weight));
    let total = 0;
    const cumulative = combos.map(combo => (total += combo.weight / maxWeight));
    return { hands: combos.map(combo => combo.cards.map(c => CODE.get(c)!) as [number, number]), cumulative, total };
  });
  if (opponents + knownOpponents.length + ranges.length > 22) throw new Error('Too many opponents');
  const participants = 1 + opponents + knownOpponents.length + ranges.length;
  if (opts.pots !== undefined) {
    const order = opts.oddChipOrder;
    if (!order || order.length !== participants || new Set(order).size !== participants || order.some(i => !Number.isInteger(i) || i < 0 || i >= participants)) throw new Error('Odd-chip order must permute every participant');
    let total = 0;
    for (const pot of opts.pots) {
      if (!Number.isSafeInteger(pot.amount) || pot.amount < 0) throw new Error('Pot amount must be a nonnegative safe integer');
      total += pot.amount;
      if (!Number.isSafeInteger(total)) throw new Error('Pot total exceeds safe integers');
      if (!pot.eligible.length || new Set(pot.eligible).size !== pot.eligible.length || pot.eligible.some(i => !Number.isInteger(i) || i < 0 || i >= participants)) throw new Error('Invalid pot eligibility');
    }
  } else if (opts.oddChipOrder !== undefined) throw new Error('Odd-chip order requires pots');
  const basePool = freshDeck().filter((c) => !known.has(c)).map((c) => CODE.get(c)!);
  let pool = basePool.slice();
  const heroCodes = hero.map((c) => CODE.get(c)!);
  const boardCodes = board.map((c) => CODE.get(c)!);
  const knownOppCodes = knownOpponents.map((h) => [CODE.get(h[0])!, CODE.get(h[1])!]);

  const boardNeed = 5 - board.length;
  const draw = boardNeed + opponents * 2;
  if (draw + ranges.length * 2 > pool.length) throw new Error('not enough cards to simulate');

  const heroSeven = new Array<number>(7);
  heroSeven[0] = heroCodes[0];
  heroSeven[1] = heroCodes[1];
  const oppSeven = new Array<number>(7);

  const values = new Array<number>(participants);
  let awardMean = 0, awardM2 = 0;
  let winShare = 0;
  let wins = 0;
  let ties = 0;

  // Reject the whole independent joint draw: filtering later ranges would bias earlier hands.
  let attempts = 0;
  const maxAttempts = Math.min(10_000_000, Math.max(10_000, iterations * 100));
  for (let it = 0; it < iterations; it++) {
    let rangeHands: [number, number][] = [];
    if (ranges.length) {
      let used: Set<number>;
      do {
        if (++attempts > maxAttempts) throw new RangeSamplingError('Joint range sampling budget exhausted; no conditioned estimate available');
        rangeHands = ranges.map(range => {
          const target = rng() * range.total;
          let lo = 0, hi = range.hands.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (target < range.cumulative[mid]) hi = mid;
            else lo = mid + 1;
          }
          return range.hands[lo];
        });
        used = new Set(rangeHands.flat());
      } while (used.size !== ranges.length * 2);
      pool = basePool.filter(c => !used.has(c));
    }
    // partial Fisher–Yates: uniformly draw `draw` cards from the pool
    for (let i = 0; i < draw; i++) {
      const j = i + randInt(rng, pool.length - i);
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    // complete the board into both eval buffers
    for (let k = 0; k < 5; k++) {
      const code = k < boardCodes.length ? boardCodes[k] : pool[k - boardCodes.length];
      heroSeven[2 + k] = code;
      oppSeven[2 + k] = code;
    }
    const heroVal = evaluateCardCodes(heroSeven);

    values[0] = heroVal;
    let participant = 1;
    let bestOpp = Infinity;
    let countAtBest = 0;
    const evalOpp = (c1: number, c2: number) => {
      oppSeven[0] = c1;
      oppSeven[1] = c2;
      const v = evaluateCardCodes(oppSeven);
      values[participant++] = v;
      if (v < bestOpp) {
        bestOpp = v;
        countAtBest = 1;
      } else if (v === bestOpp) {
        countAtBest++;
      }
    };
    for (let o = 0; o < opponents; o++) {
      evalOpp(pool[boardNeed + 2 * o], pool[boardNeed + 2 * o + 1]);
    }
    for (const [c1, c2] of rangeHands) evalOpp(c1, c2);
    for (const [c1, c2] of knownOppCodes) evalOpp(c1, c2);

    if (opts.pots !== undefined) {
      let award = 0;
      for (const pot of opts.pots) {
        const best = Math.min(...pot.eligible.map(i => values[i]));
        const winners = opts.oddChipOrder!.filter(i => pot.eligible.includes(i) && values[i] === best);
        const index = winners.indexOf(0);
        if (index >= 0) award += Math.floor(pot.amount / winners.length) + Number(index < pot.amount % winners.length);
      }
      const delta = award - awardMean;
      awardMean += delta / (it + 1);
      awardM2 += delta * (award - awardMean);
    }
    if (heroVal < bestOpp) {
      wins++;
      winShare += 1;
    } else if (heroVal === bestOpp) {
      ties++;
      winShare += 1 / (countAtBest + 1);
    }
  }

  return {
    ...(opts.pots !== undefined ? { expectedAward: awardMean, awardStandardError: iterations > 1 ? Math.sqrt(awardM2 / (iterations - 1) / iterations) : null } : {}),
    horizon: 'showdown',
    equity: winShare / iterations,
    win: wins / iterations,
    tie: ties / iterations,
    iterations,
  };
}
