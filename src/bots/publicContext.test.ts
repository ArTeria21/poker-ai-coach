import { expect, it } from 'vitest';
import { startHand, applyAction } from '../engine/gameStateMachine';
import { buildBotView } from './botDecision';
import { replayHand } from '../engine/replay';

const config = { smallBlind: 5, bigBlind: 10, buttonIndex: 0, seats: [0,1,2].map(i => ({ id: `p${i}`, name: `P${i}`, stack: 1000, isHero: i === 0, personalityId: i === 1 ? 'nit' : 'maniac' })) };
it('records public actions before street transitions and replays them identically', () => {
  let state = startHand(config, 42, 'public-test').state;
  state = applyAction(state, { type: 'raise', amount: 30 }).state;
  expect(state.actionHistory[0]).toMatchObject({ seatIndex: 0, street: 'preflop', type: 'raise', amount: 30, amountAdded: 30, toStreetBet: 30, potBefore: 15, toCallBefore: 10, stackBefore: 1000 });
  state = applyAction(state, { type: 'call' }).state;
  state = applyAction(state, { type: 'call' }).state;
  expect(state.phase).toBe('flop');
  expect(state.actionHistory[2]).toMatchObject({ street: 'preflop', amountAdded: 20, toStreetBet: 30 });
  state = applyAction(state, { type: 'check' }).state;
  expect(state.actionHistory[3].street).toBe('flop');
  expect(state.actionHistory[3]).not.toHaveProperty('board');
  expect(replayHand({ handId: 'public-test', config, seed: 42, actions: state.actionHistory }).steps.at(-1)!.state.actionHistory).toEqual(state.actionHistory);
});
it('exposes copied public state without seed, deck or opponents holes', () => {
  let state = startHand(config, 42, 'privacy').state;
  state = applyAction(state, { type: 'call' }).state;
  const view = buildBotView(state, state.actionOn!);
  expect(view.handId).toBe('privacy');
  expect(view.decisionIndex).toBe(1);
  expect(Object.keys(view.publicPlayers![0]).sort()).toEqual(['allIn','hasActed','folded','id','personalityId','position','seatIndex','stack','streetBet','totalCommitted'].sort());
  expect(JSON.stringify(view)).not.toMatch(/"(seed|deck|deckIndex|startingStack)"/);
  const before = structuredClone(state);
  view.holeCards[0] = 'XX'; view.board.push('XX');
  view.publicHistory[0].stackBefore = -1;
  view.publicPlayers![0].stack = -1;
  if (view.legal.call) view.legal.call.amount = -1;
  expect(state).toEqual(before);
});
it('does not expose seed-derived IDs or change when private opponent/deck data changes', () => {
  const state = startHand(config, 123456).state;
  expect(state.handId).toBe('hand');
  const view = buildBotView(state, state.actionOn!);
  const changed = structuredClone(state);
  changed.seed = 999;
  changed.deck.reverse(); changed.deckIndex = 42;
  changed.players[1].holeCards = ['XX','YY'];
  changed.players[2].holeCards = ['ZZ','WW'];
  expect(buildBotView(changed, changed.actionOn!)).toEqual(view);
});
