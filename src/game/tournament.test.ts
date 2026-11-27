import { describe, expect, it } from 'vitest';
import type { GameState } from '../engine/types';
import { applyAction, startHand, startHandWithDeck } from '../engine/gameStateMachine';
import { legalActions } from '../engine/bettingRules';
import { freshDeck } from '../cards/deck';
import { beginTournamentHand, createTournament, settleTournamentHand, type TournamentState } from './tournament';

const lineup = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isHero: i === 0 }));
const tournament = () => createTournament(lineup, 0, 'sng-test');

function finishByFolds(state: GameState): GameState {
  while (state.phase !== 'complete') state = applyAction(state, { type: 'fold' }).state;
  return state;
}

/** Arbitrary results exercise tournament transitions independently of hand strength. */
function syntheticResult(t: TournamentState, finalStacks: number[]): GameState {
  const begun = beginTournamentHand(t);
  const started = startHand(begun.config, 42, begun.handId).state;
  return {
    ...started, phase: 'complete', actionOn: null,
    players: started.players.map((p) => ({ ...p, stack: finalStacks[p.seatIndex] })),
  };
}

function settleAs(t: TournamentState, physicalStacks: number[]): TournamentState {
  const begun = beginTournamentHand(t);
  const liveStacks = t.players.filter((p) => p.stack > 0).map((p) => physicalStacks[p.seatIndex]);
  return settleTournamentHand(begun.tournament, syntheticResult(t, liveStacks));
}

describe('SNG lifecycle', () => {
  it('rejects an invalid lineup or initial button', () => {
    expect(() => createTournament(lineup.slice(1), 0, 'sng')).toThrow();
    expect(() => createTournament(lineup.map((p) => ({ ...p, id: 'same' })), 0, 'sng')).toThrow();
    expect(() => createTournament(lineup, 0.5, 'sng')).toThrow();
  });

  it('starts six players with 2000 chips and no ante at 10/20', () => {
    const initial = tournament();
    const begun = beginTournamentHand(initial);
    expect(initial.pendingHandId).toBeNull();
    expect(begun.config).toMatchObject({ smallBlind: 10, bigBlind: 20, bigBlindAnte: 0, buttonIndex: 0, smallBlindIndex: 1, bigBlindIndex: 2, payouts: [0.65, 0.35] });
    expect(begun.config.seats.map((p) => p.stack)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    const ended = finishByFolds(startHand(begun.config, 42, begun.handId).state);
    const settled = settleTournamentHand(begun.tournament, ended);
    expect(settled.completedHands).toBe(1);
    expect(settled.players.map((p) => p.stack)).toEqual(ended.players.map((p) => p.stack));
    expect(settled.players.reduce((sum, p) => sum + p.stack, 0)).toBe(12000);
    expect(begun.tournament.completedHands).toBe(0);
  });

  it('changes the level only when beginning the seventh hand, and caps the final level', () => {
    let t = tournament();
    for (let i = 0; i < 6; i++) {
      const begun = beginTournamentHand(t);
      t = settleTournamentHand(begun.tournament, finishByFolds(startHand(begun.config, i, begun.handId).state));
    }
    expect(t.completedHands).toBe(6);
    expect(t.levelIndex).toBe(0);
    expect(beginTournamentHand(t).config).toMatchObject({ smallBlind: 15, bigBlind: 30, bigBlindAnte: 0 });
    expect(beginTournamentHand({ ...t, completedHands: 12 }).config).toMatchObject({ smallBlind: 25, bigBlind: 50, bigBlindAnte: 50 });
    expect(beginTournamentHand({ ...t, completedHands: 1000 }).config).toMatchObject({ smallBlind: 8000, bigBlind: 16000, bigBlindAnte: 16000 });
  });

  it('rejects a second begin, incomplete hands, double settlement, and stale hands', () => {
    const t = tournament();
    const begun = beginTournamentHand(t);
    const started = startHand(begun.config, 42, begun.handId).state;
    expect(() => beginTournamentHand(begun.tournament)).toThrow();
    expect(() => settleTournamentHand(begun.tournament, started)).toThrow();
    const final = finishByFolds(started);
    const settled = settleTournamentHand(begun.tournament, final);
    expect(() => settleTournamentHand(settled, final)).toThrow();
    expect(() => settleTournamentHand(beginTournamentHand(settled).tournament, final)).toThrow();
  });

  it.each(['missing', 'duplicate', 'unknown', 'startingStack', 'chipDrift', 'ante', 'blinds'])('rejects mismatched hand data: %s', (kind) => {
    const begun = beginTournamentHand(tournament());
    const final = finishByFolds(startHand(begun.config, 42, begun.handId).state);
    if (kind === 'missing') final.players.pop();
    if (kind === 'duplicate') final.players[1].id = final.players[0].id;
    if (kind === 'unknown') final.players[0].id = 'other';
    if (kind === 'startingStack') final.players[0].startingStack++;
    if (kind === 'chipDrift') final.players[0].stack++;
    if (kind === 'ante') final.antePot++;
    if (kind === 'blinds') final.config = { ...final.config, bigBlind: 40 };
    expect(() => settleTournamentHand(begun.tournament, final)).toThrow();
  });

  it('preserves dead SB and button markers across successive hands', () => {
    let t = settleAs(tournament(), [4000, 2000, 0, 0, 4000, 2000]);
    let begun = beginTournamentHand(t);
    expect(begun.tournament).toMatchObject({ buttonSeat: 1, smallBlindSeat: 2, bigBlindSeat: 4 });
    expect(begun.config).toMatchObject({ buttonIndex: 1, smallBlindIndex: null, bigBlindIndex: 2 });
    const ended = finishByFolds(startHand(begun.config, 42, begun.handId).state);
    t = settleTournamentHand(begun.tournament, ended);
    begun = beginTournamentHand(t);
    expect(begun.tournament).toMatchObject({ buttonSeat: 2, smallBlindSeat: 4, bigBlindSeat: 5 });
    expect(begun.config).toMatchObject({ buttonIndex: null, smallBlindIndex: 2, bigBlindIndex: 3 });
    expect(begun.config.seats.map((p) => p.id)).toEqual(['p0', 'p1', 'p4', 'p5']);
  });

  it.each([0, 1, 2])('enters heads-up correctly when three-handed seat %i busts', (bust) => {
    let t = settleAs(tournament(), [4000, 4000, 4000, 0, 0, 0]);
    const previous = beginTournamentHand(t).tournament;
    const stacks = [4000, 4000, 4000, 0, 0, 0];
    stacks[(bust + 1) % 3] += stacks[bust];
    stacks[bust] = 0;
    t = settleAs(t, stacks);
    const begun = beginTournamentHand(t);
    const remaining = t.players.filter((p) => p.stack > 0);
    const expectedBB = remaining.find((p) => p.seatIndex > previous.bigBlindSeat)?.seatIndex ?? remaining[0].seatIndex;
    expect(begun.tournament.bigBlindSeat).toBe(expectedBB);
    expect(begun.tournament.smallBlindSeat).toBe(remaining.find((p) => p.seatIndex !== expectedBB)!.seatIndex);
    expect(begun.tournament.buttonSeat).toBe(begun.tournament.smallBlindSeat);
    expect(begun.config.buttonIndex).toBe(begun.config.smallBlindIndex);
    const hand = startHand(begun.config, 42, begun.handId).state;
    expect(hand.actionOn).toBe(hand.smallBlindIndex);
    let flop = hand;
    while (flop.phase === 'preflop') flop = applyAction(flop, { type: legalActions(flop)!.check ? 'check' : 'call' }).state;
    expect(flop.actionOn).toBe(flop.bigBlindIndex);
  });

  it('ranks simultaneous busts by starting stacks after the actual BBA', () => {
    const t = { ...tournament(), completedHands: 12 };
    const begun = beginTournamentHand(t);
    const bb = begun.tournament.bigBlindSeat;
    const stacks = [3000, 3000, 3000, 3000, 3000, 3000];
    stacks[bb] = 0;
    stacks[(bb + 1) % 6] = 0;
    const settled = settleAs(t, stacks);
    expect(settled.players[bb].place).toBe(6);
    expect(settled.players[(bb + 1) % 6].place).toBe(5);
  });

  it('splits payouts for equal after-ante stacks across a paid/unpaid boundary', () => {
    let t = settleAs(tournament(), [3950, 4000, 4050, 0, 0, 0]);
    t = { ...t, completedHands: 12 };
    const begun = beginTournamentHand(t);
    const bb = begun.tournament.bigBlindSeat; // seat 0: BB gross stack 3950
    const other = (bb + 1) % 3;
    t = { ...t, players: t.players.map((p) => ({ ...p, stack: p.seatIndex === bb ? 4000 : p.seatIndex === other ? 3950 : p.stack })) };
    const total = t.players.reduce((sum, p) => sum + p.stack, 0);
    const results = t.players.map((p) => p.seatIndex === bb || p.seatIndex === other ? 0 : p.stack > 0 ? total : 0);
    const settled = settleAs(t, results);
    expect(settled.players[bb]).toMatchObject({ place: 2, payoutShare: 0.175 });
    expect(settled.players[other]).toMatchObject({ place: 2, payoutShare: 0.175 });
    expect(settled.players.find((p) => p.stack > 0)).toMatchObject({ place: 1, payoutShare: 0.65 });
    expect(settled.players.reduce((sum, p) => sum + p.payoutShare, 0)).toBeCloseTo(1);
    expect(() => beginTournamentHand(settled)).toThrow();
  });

  it('uses the partial ante actually paid for simultaneous busts in a real hand', () => {
    const t = { ...settleAs(tournament(), [75, 50, 11875, 0, 0, 0]), completedHands: 12 };
    const begun = beginTournamentHand(t);
    expect(begun.tournament.bigBlindSeat).toBe(0);
    const cards = ['As', 'Ks', 'Qs', 'Ad', 'Kd', 'Qd', '2c', '3h', '4s', '7d', '9c'];
    const deck = [...cards, ...freshDeck().filter((c) => !cards.includes(c))];
    let { state } = startHandWithDeck(begun.config, deck, 42, begun.handId);
    expect(state.antePot).toBe(25);
    while (state.phase !== 'complete') state = applyAction(state, { type: legalActions(state)!.check ? 'check' : 'call' }).state;
    const settled = settleTournamentHand(begun.tournament, state);
    expect(settled.players[0]).toMatchObject({ stack: 0, place: 2, payoutShare: 0.175 });
    expect(settled.players[1]).toMatchObject({ stack: 0, place: 2, payoutShare: 0.175 });
    expect(settled.players[2]).toMatchObject({ stack: 12000, place: 1, payoutShare: 0.65 });
  });

  it('splits places two through four evenly for a triple tie', () => {
    const t = settleAs(tournament(), [3000, 3000, 3000, 3000, 0, 0]);
    const settled = settleAs(t, [0, 0, 0, 12000, 0, 0]);
    for (const player of settled.players.slice(0, 3)) {
      expect(player.place).toBe(2);
      expect(player.payoutShare).toBeCloseTo(0.35 / 3);
    }
    expect(settled.players.reduce((sum, p) => sum + p.payoutShare, 0)).toBeCloseTo(1);
  });
});
