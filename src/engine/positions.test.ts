import { describe, expect, it } from 'vitest';
import type { GameState, TableConfig } from './types';
import { positionOfSeat } from './types';
import { applyAction, startHand, startHandWithDeck } from './gameStateMachine';
import { legalActions } from './bettingRules';
import { replayHand } from './replay';
import { freshDeck } from './deck';

function config(n: number, buttonIndex: number | null, smallBlindIndex: number | null, bigBlindIndex: number): TableConfig {
  return {
    smallBlind: 5, bigBlind: 10, buttonIndex, smallBlindIndex, bigBlindIndex,
    seats: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, stack: 100, isHero: i === 0 })),
  };
}

function callOrCheck(state: GameState): GameState {
  return applyAction(state, { type: legalActions(state)!.check ? 'check' : 'call' }).state;
}

describe('explicit blind positions', () => {
  it.each([
    { n: 4, button: 0, sb: 1, bb: 2, first: 1, preflop: 3, positions: ['BTN', 'SB', 'BB', 'UTG'] },
    { n: 4, button: null, sb: 0, bb: 1, first: 0, preflop: 2, positions: ['SB', 'BB', 'UTG', 'CO'] },
    { n: 5, button: 1, sb: null, bb: 2, first: 2, preflop: 3, positions: ['CO', 'BTN', 'BB', 'UTG', 'HJ'] },
    { n: 3, button: null, sb: null, bb: 0, first: 0, preflop: 1, positions: ['BB', 'UTG', 'CO'] },
    { n: 2, button: 1, sb: 1, bb: 0, first: 0, preflop: 1, positions: ['BB', 'SB'] },
  ])('uses actual positions for dealing, action, and replay: $button/$sb/$bb', ({ n, button, sb, bb, first, preflop, positions }) => {
    const cfg = config(n, button, sb, bb);
    let { state } = startHand(cfg, 42, 'positions');
    expect(state.smallBlindIndex).toBe(sb);
    expect(state.bigBlindIndex).toBe(bb);
    expect(state.players[first].holeCards[0]).toBe(state.deck[0]);
    expect(state.players[(first + n - 1) % n].holeCards[1]).toBe(state.deck[2 * n - 1]);
    expect(state.actionOn).toBe(preflop);
    expect(state.players.map((_, i) => positionOfSeat(state, i))).toEqual(positions);
    while (state.phase === 'preflop') state = callOrCheck(state);
    expect(state.actionOn).toBe(first);
    while (state.phase !== 'complete') state = callOrCheck(state);
    const replay = replayHand({ handId: state.handId, config: cfg, seed: 42, actions: state.actionHistory });
    expect(replay.steps.at(-1)!.state).toEqual(state);
  });

  it('awards an odd chip clockwise from a dead button', () => {
    const holes = ['2c', '4c', '6c', '8c', '3c', '5c', '7c', '9c'];
    const board = ['Ah', 'Kh', 'Qh', 'Jh', 'Th'];
    const used = new Set([...holes, ...board]);
    const deck = [...holes, ...board, ...freshDeck().filter((c) => !used.has(c))];
    let { state } = startHandWithDeck(config(4, null, 0, 1), deck);
    state = applyAction(state, { type: 'call' }).state; // UTG
    state = applyAction(state, { type: 'fold' }).state; // CO
    state = applyAction(state, { type: 'fold' }).state; // SB
    while (state.phase !== 'complete') state = callOrCheck(state);
    expect(state.players.map((p) => p.stack)).toEqual([95, 103, 102, 100]);
  });

  it.each([
    { buttonIndex: null, smallBlindIndex: undefined, bigBlindIndex: undefined },
    { buttonIndex: 0.5, smallBlindIndex: 1, bigBlindIndex: 2 },
    { buttonIndex: 0, smallBlindIndex: 1, bigBlindIndex: 1 },
    { buttonIndex: 0, smallBlindIndex: 2, bigBlindIndex: 1 },
    { buttonIndex: 0, smallBlindIndex: 1, bigBlindIndex: 3 },
    { buttonIndex: null, smallBlindIndex: null, bigBlindIndex: 0.5 },
  ])('rejects inconsistent positions: %j', (positions) => {
    expect(() => startHand({ ...config(4, 0, 1, 2), ...positions }, 42)).toThrow(/position|button|blind/i);
  });

  it('requires a live button and small blind heads-up', () => {
    expect(() => startHand(config(2, null, null, 0), 42)).toThrow();
  });
});
