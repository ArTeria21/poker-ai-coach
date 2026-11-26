import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { GameState, TableConfig } from '../engine/types';
import { applyAction, startHand, startHandWithDeck } from '../engine/gameStateMachine';
import { freshDeck } from '../engine/deck';
import { mulberry32 } from '../engine/rng';
import { buildBotView, decideAction } from './botDecision';
import { PERSONALITIES, type Difficulty } from './personalities';
import { handTier } from './preflopTiers';
import type { Card } from '../engine/types';

const personalityIds = Object.keys(PERSONALITIES);

function config(stacks: number[], buttonIndex = 0): TableConfig {
  return {
    smallBlind: 5,
    bigBlind: 10,
    buttonIndex,
    seats: stacks.map((stack, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      stack,
      isHero: false,
      personalityId: personalityIds[i % personalityIds.length],
    })),
  };
}

function riggedDeck(buttonIndex: number, holes: [Card, Card][], board: Card[]): Card[] {
  const n = holes.length;
  const deal: Card[] = [];
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= n; i++) deal.push(holes[(buttonIndex + i) % n][round]);
  }
  const used = new Set([...deal, ...board]);
  const rest = freshDeck().filter((c) => !used.has(c));
  return [...deal, ...board, ...rest];
}

describe('preflop tiers', () => {
  it('rates the classics sensibly', () => {
    expect(handTier(['As', 'Ah'])).toBe(1);
    expect(handTier(['As', 'Ks'])).toBe(1);
    expect(handTier(['As', 'Kh'])).toBe(2);
    expect(handTier(['Js', 'Jh'])).toBe(2);
    expect(handTier(['7s', '2h'])).toBe(8);
    expect(handTier(['9s', '8s'])).toBe(4);
    expect(handTier(['2s', '2h'])).toBe(5);
  });
});

describe('bot sanity', () => {
  it.each([false, true])('does not count ante as a limper (real limper: %s)', (limped) => {
    const deck = riggedDeck(0, [['As', 'Ah'], ['5c', '5d'], ['9h', '9c'], ['Ks', 'Kh']], ['3c', '8d', 'Jh', '4s', '9s']);
    const decisions = [0, 10].map((bigBlindAnte) => {
      let { state } = startHandWithDeck({ ...config([1000, 1000, 1000, 1000]), bigBlindAnte }, deck);
      if (limped) state = applyAction(state, { type: 'call' }).state;
      return decideAction(buildBotView(state, state.actionOn!), PERSONALITIES.rock, 'hard', () => 0.1);
    });
    expect(decisions[0].action).toEqual({ type: 'raise', amount: limped ? 40 : 30 });
    expect(decisions[1]).toEqual(decisions[0]);
  });

  it('shows the real remaining call against an all-in short big blind', () => {
    let { state } = startHand(config([1000, 1000, 7]), 42);
    state = applyAction(state, { type: 'fold' }).state;
    const view = buildBotView(state, 1);
    expect(view.legal.call).toEqual({ amount: 2, allIn: false });
    expect(view.toCall).toBe(2);
  });

  it('the Rock folds 72o from UTG every time (100 samples)', () => {
    // 4-handed, button 0 → seat 3 is UTG and gets 7h 2c
    const deck = riggedDeck(
      0,
      [
        ['As', 'Kd'],
        ['5c', '5d'],
        ['9h', '9c'],
        ['7h', '2c'],
      ],
      ['3c', '8d', 'Jh', '4s', '9s'],
    );
    for (let i = 0; i < 100; i++) {
      const { state } = startHandWithDeck(config([1000, 1000, 1000, 1000]), deck);
      expect(state.actionOn).toBe(3); // UTG first to act
      const view = buildBotView(state, 3);
      const { action } = decideAction(view, PERSONALITIES.rock, 'hard', mulberry32(i));
      expect(action.type).toBe('fold');
    }
  });

  it('nobody ever folds aces preflop in an unraised pot (all personalities x 200 rng)', () => {
    const deck = riggedDeck(
      0,
      [
        ['Kd', 'Qc'],
        ['5c', '5d'],
        ['9h', '9c'],
        ['As', 'Ah'],
      ],
      ['3c', '8d', 'Jh', '4s', '9s'],
    );
    for (const pid of personalityIds) {
      for (let i = 0; i < 200; i++) {
        const { state } = startHandWithDeck(config([1000, 1000, 1000, 1000]), deck);
        const view = buildBotView(state, 3);
        const { action } = decideAction(view, PERSONALITIES[pid], 'medium', mulberry32(i * 7 + 1));
        expect(action.type, `${pid} folded aces (rng ${i})`).not.toBe('fold');
      }
    }
  });

  it('tight bots never fold aces to an open raise, but still fold jacks', () => {
    for (const hand of [['As', 'Ah'], ['Js', 'Jh']] as [Card, Card][]) for (const seat of [0, 1, 2]) {
      const holes: [Card, Card][] = [['2c', '7d'], ['3c', '8d'], ['4c', '9d'], ['5h', '6h']];
      holes[seat] = hand;
      let { state } = startHandWithDeck(config([1000, 1000, 1000, 1000]), riggedDeck(0, holes, []));
      state = applyAction(state, { type: 'raise', amount: 30 }).state;
      while (state.actionOn !== seat) state = applyAction(state, { type: 'fold' }).state;
      let folds = 0;
      for (const pid of ['rock', 'nit']) for (let i = 0; i < 100; i++) {
        if (decideAction(buildBotView(state, seat), PERSONALITIES[pid], 'medium', mulberry32(i + 1)).action.type === 'fold') folds++;
      }
      expect(folds > 0, `${hand.join('')} seat ${seat}`).toBe(hand[0] === 'Js');
    }
  });

  it('short-stack terminal calls follow the price, not the starting-hand table', () => {
    const spot = (bbStack: number, hole: [Card, Card] = ['7c', '2d']) => {
      // Heads-up: SB/button shoves over a big blind left with bbStack - 10 chips behind.
      const { state } = startHandWithDeck(config([6000, bbStack]), riggedDeck(0, [['As', 'Ah'], hole], []));
      return applyAction(state, { type: 'raise', amount: 6000 }).state;
    };
    for (const difficulty of ['easy', 'medium', 'hard'] as Difficulty[]) {
      expect(decideAction(buildBotView(spot(11), 1), PERSONALITIES.nit, difficulty, mulberry32(1)).action.type).toBe('call'); // 1 chip into 22: 4.5%
    }
    for (const difficulty of ['easy', 'medium'] as Difficulty[]) expect(decideAction(buildBotView(spot(14), 1), PERSONALITIES.nit, difficulty, mulberry32(1)).action.type).toBe('fold'); // 4 into 28: 14.29%, just above the 14.19% bound
    expect(decideAction(buildBotView(spot(20, ['Kc', 'Td']), 1), PERSONALITIES.nit, 'hard', mulberry32(1)).action.type).toBe('call'); // modeled +EV, tier table says fold
    expect(decideAction(buildBotView(spot(100), 1), PERSONALITIES.nit, 'hard', mulberry32(1)).action.type).toBe('fold');
    // 8BB, UTG min-raises: calling is not terminal, so the modeled call does not replace the AA shove.
    let open = startHandWithDeck(config([80, 80, 80, 80]), riggedDeck(0, [['2c', '7d'], ['3c', '8d'], ['As', 'Ah'], ['5h', '6h']], [])).state;
    for (const action of [{ type: 'raise', amount: 20 }, { type: 'fold' }, { type: 'fold' }] as const) open = applyAction(open, action).state;
    expect(decideAction(buildBotView(open, 2), PERSONALITIES.nit, 'hard', mulberry32(1)).action.type).toBe('raise');
    // Three-way the single-range equity bound does not hold, so the price rule stays off.
    let { state } = startHandWithDeck(config([6000, 6000, 11]), riggedDeck(0, [['As', 'Ah'], ['Ks', 'Kh'], ['7c', '2d']], []));
    state = applyAction(state, { type: 'raise', amount: 6000 }).state;
    state = applyAction(state, { type: 'call' }).state;
    expect(decideAction(buildBotView(state, 2), PERSONALITIES.nit, 'medium', mulberry32(1)).trace.join()).toContain('positional push/fold heuristic');
  });

  it('value-bets top pair heads-up but not four-way', () => {
    const betRate = (n: number) => {
      const holes = ([['Kc', 'Qd'], ['2s', '3s'], ['4s', '6h'], ['8s', '3h']] as [Card, Card][]).slice(0, n);
      let { state } = startHandWithDeck(config(Array(n).fill(1000)), riggedDeck(0, holes, ['Kh', '7d', '2c']));
      while (state.phase === 'preflop') state = applyAction(state, { type: state.currentBet > state.players[state.actionOn!].streetBet ? 'call' : 'check' }).state;
      while (state.actionOn !== 0) state = applyAction(state, { type: 'check' }).state;
      let bets = 0;
      for (let i = 0; i < 100; i++) bets += decideAction(buildBotView(state, 0), PERSONALITIES.shark, 'medium', mulberry32(i + 1)).trace.includes('value betting ~60% pot') ? 1 : 0;
      return bets;
    };
    expect(betRate(2)).toBeGreaterThan(0);
    expect(betRate(3)).toBeGreaterThan(0);
    expect(betRate(4)).toBe(0);
  });

  it('a hard bot never raises "for value" when the range model says it is behind', () => {
    // Small flush on a four-spade board vs a river overbet in a 3-bet pot: heuristic 0.80, modeled ~15%.
    const deck = riggedDeck(0, [['Kd', 'Kh'], ['6s', 'Jc']], ['Qs', 'As', 'Tc', 'Ts', '7s']);
    let state = startHandWithDeck(config([1000, 1000]), deck).state;
    for (const action of [{ type: 'raise', amount: 30 }, { type: 'raise', amount: 90 }, { type: 'call' }] as const) state = applyAction(state, action).state;
    while (state.phase !== 'river') state = applyAction(state, { type: 'check' }).state;
    state = applyAction(state, { type: 'check' }).state;
    state = applyAction(state, { type: 'raise', amount: 900 }).state;
    for (let i = 0; i < 30; i++) {
      const { trace } = decideAction(buildBotView(state, 1), PERSONALITIES.maniac, 'hard', mulberry32(i + 1));
      expect(trace).not.toContain('raising for value');
    }
  });
});

describe('bot integration (property-based)', () => {
  it('full bot tables always play legal actions to completion with chips conserved', () => {
    fc.assert(
      fc.property(
        fc.record({
          seed: fc.integer({ min: 0, max: 0x7fffffff }),
          botSeed: fc.integer({ min: 0, max: 0x7fffffff }),
          button: fc.nat(5),
          difficulty: fc.constantFrom<Difficulty>('easy', 'medium', 'hard'),
          stacks: fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 2, maxLength: 6 }),
        }),
        ({ seed, botSeed, button, difficulty, stacks }) => {
          const cfg = config(stacks, button % stacks.length);
          const rng = mulberry32(botSeed);
          let state: GameState = startHand(cfg, seed).state;
          let steps = 0;
          while (state.phase !== 'complete') {
            if (++steps > 400) throw new Error('bot hand did not terminate');
            const seat = state.actionOn!;
            const personality = PERSONALITIES[cfg.seats[seat].personalityId!];
            const view = buildBotView(state, seat);
            const { action } = decideAction(view, personality, difficulty, rng);
            state = applyAction(state, action).state; // throws if illegal
          }
          const total = state.players.reduce((sum, p) => sum + p.stack, 0);
          expect(total).toBe(stacks.reduce((a, b) => a + b, 0));
        },
      ),
      { numRuns: 200 },
    );
  });
});
