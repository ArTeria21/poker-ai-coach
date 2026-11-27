import { describe, expect, it, vi } from 'vitest';
import { coachSnapshotSchema, type CoachSnapshot } from './contract';
import { coachSnapshot } from './snapshot';
import { TableController } from '../game/tableController';
import { beginTournamentHand, createTournament } from '../game/tournament';
import { applyAction, startHandWithDeck } from '../engine/gameStateMachine';
import { legalActions } from '../engine/bettingRules';
import { freshDeck } from '../engine/deck';
import type { PlayerAction } from '../engine/types';
import { useGameStore, type GameViewState } from '../store/gameStore';
import {
  decisionGateId, initialTrainingState, obviousPreflopSpot, reviewGateId, step,
  type TrainingEvent, type TrainingState,
} from './training';

vi.mock('../game/sounds', () => ({ sounds: {} }));

const H = 'sng-x-hand-3';
const k = (i: number) => decisionGateId(H, i);

/** Runs events from `state`, collecting every request. */
function run(state: TrainingState, ...events: TrainingEvent[]) {
  const requests = [];
  for (const e of events) {
    const r = step(state, e);
    state = r.state;
    if (r.request) requests.push(r.request);
  }
  return { state, requests };
}
const training = (...events: TrainingEvent[]) => run(initialTrainingState('training'), { type: 'newHand', handId: H }, ...events);
const gateOf = (s: TrainingState) => (s.mode === 'training' ? s.gate : null);

describe('gate ids', () => {
  it('builds decision and review ids from the public hand id', () => {
    expect(decisionGateId(H, 4)).toBe('sng-x-hand-3#4');
    expect(reviewGateId(H)).toBe('sng-x-hand-3#review');
  });
});

describe('training state machine', () => {
  it('free mode never locks or requests', () => {
    const { state, requests } = run(initialTrainingState('free'),
      { type: 'newHand', handId: H }, { type: 'heroTurn', key: k(2), obvious: false }, { type: 'userMessage' },
      { type: 'heroActed', action: 'raise' }, { type: 'handComplete', heroDealt: true }, { type: 'released', gateId: k(2) });
    expect(requests).toEqual([]);
    expect(state).toEqual({ mode: 'free', handId: H });
  });

  it('locks a real decision and requests it once per key', () => {
    const { state, requests } = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'heroTurn', key: k(2), obvious: false });
    expect(requests).toEqual([{ kind: 'decision', gateId: k(2) }]);
    expect(state).toMatchObject({ engaged: true, gate: { id: k(2), kind: 'decision', locked: true } });
  });

  it('skips an obvious preflop spot without lock or request, and never re-triggers it', () => {
    const { state, requests } = training({ type: 'heroTurn', key: k(3), obvious: true }, { type: 'heroTurn', key: k(3), obvious: false });
    expect(requests).toEqual([]);
    expect(state).toMatchObject({ engaged: false, gate: { id: k(3), locked: false } });
  });

  it('does not skip an "obvious" spot once the hand is engaged', () => {
    const { requests } = training({ type: 'userMessage' }, { type: 'heroTurn', key: k(3), obvious: true });
    expect(requests).toEqual([{ kind: 'decision', gateId: k(3) }]);
  });

  it('ignores a hero turn keyed to another hand', () => {
    const { state, requests } = training({ type: 'heroTurn', key: decisionGateId('sng-x-hand-2', 1), obvious: false });
    expect(requests).toEqual([]);
    expect(gateOf(state)).toBeNull();
    expect(run(initialTrainingState('training'), { type: 'heroTurn', key: k(1), obvious: false }).requests).toEqual([]);
  });

  it('unlocks only on a release of the current gate id', () => {
    const locked = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'heroActed', action: 'call' }, { type: 'heroTurn', key: k(6), obvious: false });
    expect(locked.requests.map((r) => r.gateId)).toEqual([k(2), k(6)]);
    const stale = run(locked.state, { type: 'released', gateId: k(2) }, { type: 'released', gateId: reviewGateId(H) });
    expect(gateOf(stale.state)).toMatchObject({ id: k(6), locked: true });
    const released = run(stale.state, { type: 'released', gateId: k(6) }, { type: 'released', gateId: k(6) });
    expect(gateOf(released.state)).toEqual({ id: k(6), kind: 'decision', locked: false });
  });

  it('a release of an old hand never unlocks the new hand', () => {
    const { state } = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'newHand', handId: 'sng-x-hand-4' },
      { type: 'heroTurn', key: 'sng-x-hand-4#2', obvious: false }, { type: 'released', gateId: k(2) });
    expect(gateOf(state)).toMatchObject({ id: 'sng-x-hand-4#2', locked: true });
  });

  it('ignores a stale hero turn of an earlier decision', () => {
    const { state, requests } = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'released', gateId: k(2) }, { type: 'heroActed', action: 'call' },
      { type: 'heroTurn', key: k(6), obvious: false }, { type: 'heroTurn', key: k(2), obvious: false }, { type: 'heroTurn', key: k(5), obvious: false }, { type: 'released', gateId: k(6) });
    expect(requests.map((r) => r.gateId)).toEqual([k(2), k(6)]);
    expect(gateOf(state)).toEqual({ id: k(6), kind: 'decision', locked: false });
  });

  it('ignores any hero turn once the hand has completed', () => {
    const { state, requests } = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'released', gateId: k(2) }, { type: 'heroActed', action: 'fold' },
      { type: 'handComplete', heroDealt: true }, { type: 'heroTurn', key: k(2), obvious: false }, { type: 'heroTurn', key: k(9), obvious: false });
    expect(requests.map((r) => r.gateId)).toEqual([k(2), reviewGateId(H)]);
    expect(gateOf(state)).toEqual({ id: reviewGateId(H), kind: 'review', locked: true });
  });

  it('"Continue without Dan" releases the failed request\'s gate only', () => {
    // #2 errored after the hero already moved on to a locked #6: its release must not unlock #6.
    const { state } = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'released', gateId: k(2) }, { type: 'heroActed', action: 'call' },
      { type: 'heroTurn', key: k(6), obvious: false }, { type: 'released', gateId: k(2) });
    expect(gateOf(state)).toMatchObject({ id: k(6), locked: true });
  });

  describe('substantive hand review', () => {
    const review = { kind: 'review', gateId: reviewGateId(H) };

    it('trash folded by the filter → no review', () => {
      const { state, requests } = training({ type: 'heroTurn', key: k(3), obvious: true }, { type: 'heroActed', action: 'fold' }, { type: 'handComplete', heroDealt: true });
      expect(requests).toEqual([]);
      expect(gateOf(state)).toMatchObject({ locked: false });
    });

    it('a free check in the BB is not voluntary chips: no later decision → no review', () => {
      expect(training({ type: 'heroTurn', key: k(4), obvious: true }, { type: 'heroActed', action: 'check' }, { type: 'handComplete', heroDealt: true }).requests).toEqual([]);
    });

    it('trash checked for free in the BB: no lock preflop, the flop decision locks and the hand gets a review', () => {
      const { requests } = training({ type: 'heroTurn', key: k(4), obvious: true }, { type: 'heroActed', action: 'check' },
        { type: 'heroTurn', key: k(6), obvious: false }, { type: 'heroActed', action: 'fold' }, { type: 'handComplete', heroDealt: true });
      expect(requests).toEqual([{ kind: 'decision', gateId: k(6) }, review]);
    });

    it('trash played voluntarily → the next decision locks and the hand gets a review', () => {
      const { state, requests } = training({ type: 'heroTurn', key: k(3), obvious: true }, { type: 'heroActed', action: 'raise' },
        { type: 'heroTurn', key: k(6), obvious: true }, { type: 'heroActed', action: 'fold' }, { type: 'handComplete', heroDealt: true });
      expect(requests).toEqual([{ kind: 'decision', gateId: k(6) }, review]);
      expect(gateOf(state)).toEqual({ id: reviewGateId(H), kind: 'review', locked: true });
    });

    it('trash voluntarily played to the end (all-in, no later decision) → review', () => {
      expect(training({ type: 'heroTurn', key: k(3), obvious: true }, { type: 'heroActed', action: 'call' }, { type: 'handComplete', heroDealt: true }).requests).toEqual([review]);
    });

    it('chat during the hand → review', () => {
      expect(training({ type: 'userMessage' }, { type: 'handComplete', heroDealt: true }).requests).toEqual([review]);
    });

    it('a gated decision → review, requested once', () => {
      const { requests } = training({ type: 'heroTurn', key: k(2), obvious: false }, { type: 'released', gateId: k(2) },
        { type: 'heroActed', action: 'fold' }, { type: 'handComplete', heroDealt: true }, { type: 'handComplete', heroDealt: true });
      expect(requests).toEqual([{ kind: 'decision', gateId: k(2) }, review]);
    });

    it('hero not dealt in (eliminated) → nothing, even after chatting', () => {
      const { state, requests } = training({ type: 'userMessage' }, { type: 'handComplete', heroDealt: false });
      expect(requests).toEqual([]);
      expect(gateOf(state)).toMatchObject({ kind: 'review', locked: false });
    });

    it('chat after an unreviewed hand ended and repeated completion events never open a review', () => {
      const { state, requests } = training({ type: 'heroTurn', key: k(3), obvious: true }, { type: 'heroActed', action: 'fold' },
        { type: 'handComplete', heroDealt: true }, { type: 'userMessage' }, { type: 'handComplete', heroDealt: true });
      expect(requests).toEqual([]);
      expect(state).toMatchObject({ engaged: false, gate: { id: reviewGateId(H), locked: false } });
    });

    it('a review released before the next hand stays released', () => {
      const { state } = training({ type: 'userMessage' }, { type: 'handComplete', heroDealt: true }, { type: 'released', gateId: reviewGateId(H) }, { type: 'handComplete', heroDealt: true });
      expect(gateOf(state)).toMatchObject({ kind: 'review', locked: false });
    });
  });

  describe('hand boundaries', () => {
    it('newHand clears engagement and gate; the same hand id again is a no-op', () => {
      const locked = training({ type: 'heroTurn', key: k(2), obvious: false });
      expect(step(locked.state, { type: 'newHand', handId: H }).state).toBe(locked.state);
      expect(step(locked.state, { type: 'newHand', handId: 'h2' }).state).toEqual({ mode: 'training', handId: 'h2', engaged: false, gate: null });
    });

    it('reset clears hand state but keeps the mode', () => {
      expect(step(training({ type: 'userMessage' }).state, { type: 'reset' }).state).toEqual(initialTrainingState('training'));
      expect(step({ mode: 'free', handId: H }, { type: 'reset' }).state).toEqual(initialTrainingState('free'));
    });
  });

  describe('mode switches', () => {
    it('to free unlocks any gate, and back to training does not re-lock it', () => {
      const locked = training({ type: 'heroTurn', key: k(2), obvious: false });
      const free = step(locked.state, { type: 'modeChanged', mode: 'free' });
      expect(free.state).toEqual({ mode: 'free', handId: H });
      const back = run(free.state, { type: 'modeChanged', mode: 'training', currentKey: k(2) }, { type: 'heroTurn', key: k(2), obvious: false });
      expect(back.requests).toEqual([]);
      expect(gateOf(back.state)).toMatchObject({ id: k(2), locked: false });
    });

    it('to free during a review unlocks Next Hand', () => {
      const review = training({ type: 'userMessage' }, { type: 'handComplete', heroDealt: true });
      expect(step(review.state, { type: 'modeChanged', mode: 'free' }).state).toEqual({ mode: 'free', handId: H });
    });

    it('to training mid-decision does not lock it; training starts at the next trigger', () => {
      const { state, requests } = run(initialTrainingState('free'), { type: 'newHand', handId: H },
        { type: 'modeChanged', mode: 'training', currentKey: k(2) }, { type: 'heroTurn', key: k(2), obvious: false },
        { type: 'heroActed', action: 'call' }, { type: 'heroTurn', key: k(5), obvious: false });
      expect(requests).toEqual([{ kind: 'decision', gateId: k(5) }]);
      expect(gateOf(state)).toMatchObject({ id: k(5), locked: true });
    });

    it('to training after the hand completed treats that hand as reviewed', () => {
      const { state, requests } = run(initialTrainingState('free'), { type: 'newHand', handId: H }, { type: 'handComplete', heroDealt: true },
        { type: 'modeChanged', mode: 'training', currentKey: reviewGateId(H) }, { type: 'userMessage' }, { type: 'handComplete', heroDealt: true });
      expect(requests).toEqual([]);
      expect(gateOf(state)).toEqual({ id: reviewGateId(H), kind: 'review', locked: false });
    });

    it('to training between decisions starts unengaged with no gate', () => {
      const { state } = run({ mode: 'free', handId: H }, { type: 'modeChanged', mode: 'training' });
      expect(state).toEqual({ mode: 'training', handId: H, engaged: false, gate: null });
    });

    it('switching to the current mode changes nothing', () => {
      const locked = training({ type: 'heroTurn', key: k(2), obvious: false });
      expect(step(locked.state, { type: 'modeChanged', mode: 'training', currentKey: k(2) }).state).toBe(locked.state);
      const free = { mode: 'free', handId: H } as const;
      expect(step(free, { type: 'modeChanged', mode: 'free' }).state).toBe(free);
    });
  });
});

type Before = 'limp' | 'raise' | 'shove' | 'callShove' | 'fold';
type Seat = NonNullable<CoachSnapshot['hero']['position']>;
/**
 * Preflop hero-to-act spot in a 100-chip big blind; amounts in BB; `dealt` players in the hand.
 * `raisers` give the seat and stack (BB) of each raise in order; others are a 100 BB UTG.
 */
function spot(o: { cards: [string, string]; position: Seat; depth: number; before?: Before[]; toCall?: number; pot?: number; check?: boolean; dealt?: number; raisers?: [Seat, number][] }): CoachSnapshot {
  const toCall = (o.toCall ?? 1) * 100;
  let raise = 0;
  const history = (o.before ?? []).map((b) => {
    const [position, stackBB] = b === 'raise' || b === 'shove' ? o.raisers?.[raise++] ?? ['UTG', 100] : ['UTG', 100];
    return {
      street: 'preflop' as const, player: 'Bot', position,
      action: b === 'limp' || b === 'callShove' ? 'call' as const : b === 'fold' ? 'fold' as const : 'raise' as const,
      amountAdded: 0, raiseTo: null, potBefore: 0, toCallBefore: 0, stackBefore: stackBB * 100, allIn: b === 'shove' || b === 'callShove',
    };
  });
  return {
    street: 'preflop', pot: (o.pot ?? 1.5) * 100, history, tournament: { bigBlind: 100 },
    players: Array.from({ length: 6 }, (_, i) => ({ position: i < (o.dealt ?? 6) ? 'UTG' : null })),
    hero: { cards: o.cards, position: o.position, effectiveStackBB: o.depth },
    legalActions: { fold: !o.check, check: !!o.check, ...(o.check ? {} : { call: { amount: toCall, allIn: false } }) },
  } as CoachSnapshot; // only the fields the filter reads
}
const obvious = (o: Parameters<typeof spot>[0]) => obviousPreflopSpot(spot(o));
const offsuit = (hand: string): [string, string] => [`${hand[0]}h`, `${hand[1]}c`];

describe('preflop obvious-spot filter', () => {
  describe('acceptance examples', () => {
    it('72o UTG 100BB unopened → obvious', () => expect(obvious({ cards: ['7h', '2c'], position: 'UTG', depth: 100 })).toBe(true));
    it('72o BTN 100BB unopened → obvious', () => expect(obvious({ cards: ['7h', '2c'], position: 'BTN', depth: 100 })).toBe(true));
    it('Q8o BTN 40BB unopened → discuss', () => expect(obvious({ cards: ['Qh', '8c'], position: 'BTN', depth: 40 })).toBe(false));
    it('K2o BTN 8BB unopened → discuss', () => expect(obvious({ cards: ['Kh', '2c'], position: 'BTN', depth: 8 })).toBe(false));
    it('J4o vs a 3x raise at 50BB → obvious', () => {
      // CO opens to 3: 4.5 in the pot, 3 to call.
      expect(obvious({ cards: ['Jh', '4c'], position: 'BTN', depth: 50, before: ['raise'], toCall: 3, pot: 4.5 })).toBe(true);
    });
    it('94o in the BB vs an SB shove at 6BB → discuss', () => {
      expect(obvious({ cards: ['9h', '4c'], position: 'BB', depth: 6, before: ['shove'], toCall: 5, pot: 7 })).toBe(false);
    });
    it('72o BB after limps (free check) → obvious', () => {
      expect(obvious({ cards: ['7h', '2c'], position: 'BB', depth: 100, before: ['limp', 'fold', 'limp'], check: true, pot: 3.5 })).toBe(true);
    });
    it('AA anywhere → discuss', () => {
      for (const position of ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const) {
        expect(obvious({ cards: ['Ah', 'Ac'], position, depth: 100 })).toBe(false);
        expect(obvious({ cards: ['Ah', 'Ac'], position, depth: 100, before: ['raise'], toCall: 3, pot: 4.5 })).toBe(false);
      }
    });
  });

  it('only offsuit tier-8 hands can be obvious', () => {
    expect(obvious({ cards: ['Th', '2h'], position: 'UTG', depth: 100 })).toBe(false); // T2s is tier 8 but suited
    expect(obvious({ cards: ['Ah', '2c'], position: 'UTG', depth: 100 })).toBe(false); // A2o is tier 7
    expect(obvious({ cards: ['Kh', '3c'], position: 'HJ', depth: 100 })).toBe(true);
  });

  it('first in deeper than 15 BB: CO folds 9-high junk, BTN/SB only offsuit junk ≤ 9-high with ranks five or more apart', () => {
    const worst = ['72', '82', '83', '92', '93', '94'];
    const nineHigh = [...worst, '73', '84', '95', '62', '32'];
    for (const hand of [...nineHigh, 'T4', 'T2', 'J4', 'Q8', 'K2']) {
      expect(obvious({ cards: offsuit(hand), position: 'CO', depth: 100 }), `${hand}o CO`).toBe(nineHigh.includes(hand));
      for (const position of ['BTN', 'SB'] as const) {
        expect(obvious({ cards: offsuit(hand), position, depth: 100 }), `${hand}o ${position}`).toBe(worst.includes(hand));
      }
    }
  });

  it('SB completing: only the worst junk is obvious, unopened or behind limpers', () => {
    expect(obvious({ cards: ['7h', '2c'], position: 'SB', depth: 100, toCall: 0.5 })).toBe(true);
    expect(obvious({ cards: ['7h', '2c'], position: 'SB', depth: 100, before: ['limp', 'limp'], toCall: 0.5, pot: 3.5 })).toBe(true);
    expect(obvious({ cards: ['Qh', '4c'], position: 'SB', depth: 100, before: ['limp'], toCall: 0.5, pot: 2.5 })).toBe(false);
  });

  it('limpers: deep HJ folds any junk, later seats only the worst', () => {
    expect(obvious({ cards: ['Kh', '3c'], position: 'HJ', depth: 100, before: ['limp'], pot: 2.5 })).toBe(true);
    expect(obvious({ cards: ['Kh', '3c'], position: 'BTN', depth: 100, before: ['limp', 'limp'], pot: 3.5 })).toBe(false);
  });

  it('a cheap price against a raise is worth discussing', () => {
    // BB vs a min-raise with a 1 BB ante: 1 to call into 4.5 (18% needed).
    expect(obvious({ cards: ['7h', '2c'], position: 'BB', depth: 100, before: ['raise'], toCall: 1, pot: 4.5 })).toBe(false);
    // Limped behind a raise: 25% is the edge, still discussed.
    expect(obvious({ cards: ['7h', '2c'], position: 'SB', depth: 100, before: ['raise', 'limp', 'limp'], toCall: 2.5, pot: 7.5 })).toBe(false);
  });

  it('the BB vs a plain raise folds only the worst junk', () => {
    // BTN 3x with a 1 BB ante: 2 into 5.5 (27% needed) — K8o, K5o, J4o defend; 72o folds.
    for (const hand of ['K8', 'K5', 'Q5', 'J4']) {
      expect(obvious({ cards: offsuit(hand), position: 'BB', depth: 50, before: ['raise'], toCall: 2, pot: 5.5 }), hand).toBe(false);
    }
    expect(obvious({ cards: ['7h', '2c'], position: 'BB', depth: 50, before: ['raise'], toCall: 2, pot: 5.5 })).toBe(true);
    // A deep shove is not a plain raise: the price alone decides.
    expect(obvious({ cards: ['Kh', '8c'], position: 'BB', depth: 40, before: ['shove'], toCall: 39, pot: 41.5 })).toBe(true);
  });

  it('re-steal zone: a late seat vs a single late open at ≤ 25 BB (either stack) folds only the worst', () => {
    // SB vs a BTN 2.5x open with a 1 BB ante: 2 into 5 (28.6% needed).
    const sbVsBtn = (cards: [string, string], depth: number, btnStack: number) =>
      obvious({ cards, position: 'SB', depth, before: ['raise'], toCall: 2, pot: 5, raisers: [['BTN', btnStack]] });
    expect(sbVsBtn(['Kh', '8c'], 50, 20)).toBe(false); // short opener
    expect(sbVsBtn(['Kh', '8c'], 19.5, 50)).toBe(false); // short hero
    expect(sbVsBtn(['Kh', '8c'], 25, 50)).toBe(false);
    expect(sbVsBtn(['Kh', '8c'], 26, 50)).toBe(true);
    expect(sbVsBtn(['9h', '6c'], 20, 50)).toBe(false); // 9-high but not the worst
    expect(sbVsBtn(['7h', '2c'], 20, 50)).toBe(true);
    // An early opener is not a steal.
    expect(obvious({ cards: ['Kh', '8c'], position: 'BTN', depth: 20, before: ['raise'], toCall: 2.5, pot: 5, raisers: [['HJ', 50]] })).toBe(true);
    // An open and a 3-bet: no re-steal.
    expect(obvious({ cards: ['Kh', '8c'], position: 'SB', depth: 20, before: ['raise', 'raise'], toCall: 7, pot: 12.5, raisers: [['CO', 50], ['BTN', 50]] })).toBe(true);
  });

  it('facing an all-in: discuss when the price is worth calculating, fold when it is not', () => {
    // A 2.5 BB micro-shove: 2.5 to call into 4 (38% needed).
    expect(obvious({ cards: ['7h', '2c'], position: 'HJ', depth: 100, before: ['shove'], toCall: 2.5, pot: 4 })).toBe(false);
    // A 30 BB shove: 30 into 31.5 (49% needed).
    expect(obvious({ cards: ['Jh', '4c'], position: 'CO', depth: 100, before: ['shove'], toCall: 30, pot: 31.5 })).toBe(true);
    // A raise then an all-in call: the hero still faces an all-in.
    expect(obvious({ cards: ['Jh', '4c'], position: 'HJ', depth: 100, before: ['raise', 'callShove'], toCall: 3, pot: 7 })).toBe(false);
  });

  it('push/fold depth (≤ 15 BB effective) is never obvious in CO/BTN/SB/BB, even with a free check', () => {
    expect(obvious({ cards: ['7h', '2c'], position: 'BTN', depth: 15 })).toBe(false);
    expect(obvious({ cards: ['7h', '2c'], position: 'BTN', depth: 15.5 })).toBe(true);
    expect(obvious({ cards: ['7h', '2c'], position: 'BB', depth: 12, before: ['limp'], check: true, pot: 2.5 })).toBe(false);
  });

  it('short UTG/HJ shove the better junk, so only the worst is obvious unopened or behind limpers', () => {
    expect(obvious({ cards: ['7h', '2c'], position: 'UTG', depth: 10 })).toBe(true);
    expect(obvious({ cards: ['Kh', '8c'], position: 'UTG', depth: 8 })).toBe(false);
    expect(obvious({ cards: ['Kh', '7c'], position: 'HJ', depth: 8 })).toBe(false);
    expect(obvious({ cards: ['Kh', '8c'], position: 'HJ', depth: 10, before: ['limp'], pot: 3.5 })).toBe(false);
    // Facing a plain raise short, junk still folds.
    expect(obvious({ cards: ['Kh', '8c'], position: 'HJ', depth: 10, before: ['raise'], toCall: 2, pot: 3.5 })).toBe(true);
  });

  it('heads-up: only a free check is obvious', () => {
    expect(obvious({ cards: ['7h', '2c'], position: 'SB', depth: 100, toCall: 0.5, pot: 2.5, dealt: 2 })).toBe(false);
    expect(obvious({ cards: ['Kh', '2c'], position: 'BB', depth: 25, before: ['raise'], toCall: 2, pot: 5, dealt: 2 })).toBe(false);
    expect(obvious({ cards: ['7h', '2c'], position: 'BB', depth: 30, before: ['shove'], toCall: 29, pot: 31, dealt: 2 })).toBe(false);
    expect(obvious({ cards: ['7h', '2c'], position: 'BB', depth: 100, before: ['limp'], check: true, pot: 2, dealt: 2 })).toBe(true);
    // Three-handed the button is still first in.
    expect(obvious({ cards: ['7h', '2c'], position: 'BTN', depth: 100, dealt: 3 })).toBe(true);
  });

  it('is never obvious outside a preflop hero decision', () => {
    const s = spot({ cards: ['7h', '2c'], position: 'UTG', depth: 100 });
    expect(obviousPreflopSpot({ ...s, street: 'flop' })).toBe(false);
    expect(obviousPreflopSpot({ ...s, legalActions: null })).toBe(false);
    expect(obviousPreflopSpot({ ...s, hero: { ...s.hero, cards: null } })).toBe(false);
    expect(obviousPreflopSpot({ ...s, hero: { ...s.hero, effectiveStackBB: null } })).toBe(false);
  });

  describe('on real snapshots (level 3: 25/50 with a 50 BBA, 50 BB stacks)', () => {
    const lineup = [
      { id: 'hero', name: 'You', isHero: true },
      ...['shark', 'rock', 'maniac', 'fish', 'nit'].map((id) => ({ id, name: id, isHero: false })),
    ];
    /** Hero holds `cards`; bots act `acts` until the hero is to act. */
    function realSpot(buttonSeat: number, cards: [string, string], acts: PlayerAction[], stack = 2500): CoachSnapshot {
      // beginTournamentHand moves the button on from the previous hand's seats.
      const prev = (buttonSeat + 5) % 6;
      const t = createTournament(lineup, prev, 't');
      Object.assign(t, { completedHands: 12, levelIndex: 2, smallBlindSeat: (prev + 1) % 6, bigBlindSeat: (prev + 2) % 6 });
      t.players.forEach((p) => { p.stack = stack; });
      const begun = beginTournamentHand(t);
      // Hole cards go round-robin from the SB (seat button+1); the hero is seat 0.
      const slot = (6 - (buttonSeat + 1)) % 6;
      const deck = freshDeck().filter((c) => !cards.includes(c));
      deck.splice(slot, 0, cards[0]);
      deck.splice(slot + 6, 0, cards[1]);
      let state = startHandWithDeck(begun.config, deck, 1, begun.handId).state;
      for (const a of acts) state = applyAction(state, a).state;
      const controller = new TableController() as unknown as { publishSnapshot(o?: Partial<GameViewState>): void };
      Object.assign(controller, { tournament: begun.tournament, state, handNumber: 13 });
      const legal = legalActions(state)!;
      expect(legal.seatIndex).toBe(0);
      controller.publishSnapshot({ heroLegal: legal });
      const snapshot = coachSnapshotSchema.parse(coachSnapshot(useGameStore.getState()));
      expect(snapshot.hero.cards).toEqual(cards);
      return snapshot;
    }
    const fold: PlayerAction = { type: 'fold' };

    it('BTN vs a CO 3x open: J4o folds (150 into 275)', () => {
      const s = realSpot(0, ['Jh', '4c'], [fold, fold, { type: 'raise', amount: 150 }]);
      expect(s).toMatchObject({ pot: 275, hero: { position: 'BTN', toCall: 150, effectiveStackBB: 50 } });
      expect(obviousPreflopSpot(s)).toBe(true);
    });

    it('BB vs a BTN 3x open: K8o defends, 72o folds (100 into 275)', () => {
      const btnOpen = [fold, fold, fold, { type: 'raise', amount: 150 } as PlayerAction, fold];
      const k8 = realSpot(4, ['Kh', '8c'], btnOpen);
      expect(k8).toMatchObject({ pot: 275, hero: { position: 'BB', toCall: 100 } });
      expect(obviousPreflopSpot(k8)).toBe(false);
      expect(obviousPreflopSpot(realSpot(4, ['7h', '2c'], btnOpen))).toBe(true);
    });

    it('SB at 20 BB vs a BTN 2.5x open: K8o is a re-shove spot, 72o still folds (100 into 250)', () => {
      const btnOpen = [fold, fold, fold, { type: 'raise', amount: 125 } as PlayerAction];
      const k8 = realSpot(5, ['Kh', '8c'], btnOpen, 1000);
      expect(k8).toMatchObject({ pot: 250, hero: { position: 'SB', toCall: 100, effectiveStackBB: 19.5 } });
      expect(obviousPreflopSpot(k8)).toBe(false);
      expect(obviousPreflopSpot(realSpot(5, ['7h', '2c'], btnOpen, 1000))).toBe(true);
      // At 50 BB the same open is a plain fold.
      expect(obviousPreflopSpot(realSpot(5, ['Kh', '8c'], btnOpen))).toBe(true);
    });

    it('BB vs a BTN min-raise: even 72o is discussed (50 into 225)', () => {
      const s = realSpot(4, ['7h', '2c'], [fold, fold, fold, { type: 'raise', amount: 100 }, fold]);
      expect(s).toMatchObject({ pot: 225, hero: { toCall: 50 } });
      expect(obviousPreflopSpot(s)).toBe(false);
    });
  });
});
