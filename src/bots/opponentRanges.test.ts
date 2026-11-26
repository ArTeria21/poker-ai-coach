import { expect, it } from 'vitest';
import { modelOpponentRanges } from './opponentRanges';
import { buildBotView } from './botDecision';
import { startHand, applyAction } from '../engine/gameStateMachine';
import { handTier } from './preflopTiers';
import type { WeightedCombo } from '../equity/ranges';
import type { PublicAction } from '../engine/types';

const config = { smallBlind:5, bigBlind:10, buttonIndex:0, seats:[0,1,2].map(i => ({id:`p${i}`,name:`P${i}`,stack:1000,isHero:i===0,personalityId:i===1?'nit':'maniac'})) };
const meanTier = (range: WeightedCombo[]) => range.reduce((n,c) => n+handTier(c.cards)*c.weight,0)/range.reduce((n,c)=>n+c.weight,0);
it('weights a nit three-bet much tighter than a maniac open, retaining positive bluff support', () => {
  let state = startHand(config,42).state;
  state = applyAction(state,{type:'raise',amount:30}).state;
  state = applyAction(state,{type:'raise',amount:90}).state;
  state = applyAction(state,{type:'fold'}).state;
  const view = buildBotView(state,0);
  const nit = modelOpponentRanges(view)[0];
  const loose = structuredClone(view);
  loose.publicPlayers[1].personalityId = 'maniac';
  loose.publicPlayers[1].position = 'BTN';
  loose.publicHistory = [ { ...view.publicHistory[1], amount:30, toStreetBet:30, amountAdded:25, toCallBefore:5 } ];
  const maniac = modelOpponentRanges(loose)[0];
  expect(nit.seatIndex).toBe(1);
  expect(meanTier(nit.range)).toBeLessThan(meanTier(maniac.range)-1);
  expect(nit.range.every(combo => combo.weight>0)).toBe(true);
  expect(nit.range).toHaveLength(1225);
  const before = structuredClone(view);
  expect(modelOpponentRanges(view)).toEqual(modelOpponentRanges(view));
  expect(view).toEqual(before);
});
it('uses only the historical street board and separates blockers from action likelihoods', () => {
  const view = buildBotView(startHand(config,42).state,0);
  view.holeCards = ['As','Ad']; view.phase='river'; view.board=['Qh','7h','2c','Kc','3d'];
  view.publicPlayers[2].folded=true;
  view.publicHistory=[{seatIndex:1,street:'flop',type:'raise',amount:60,amountAdded:60,toStreetBet:60,potBefore:100,toCallBefore:0,stackBefore:990} satisfies PublicAction];
  const first=modelOpponentRanges(view)[0].range;
  const second=modelOpponentRanges({...view,board:['Qh','7h','2c','4d','5s']})[0].range;
  const weight=(range:WeightedCombo[], a:string,b:string) => range.find(c=>c.cards.includes(a)&&c.cards.includes(b))!.weight;
  expect(weight(first,'Ah','Kh')/weight(first,'6c','6d')).toBeCloseTo(weight(second,'Ah','Kh')/weight(second,'6c','6d'),10);
});
it('starts unobserved opponents at a uniform card prior and excludes folded seats', () => {
  const view=buildBotView(startHand(config,42).state,0);
  const modeled=modelOpponentRanges(view);
  expect(modeled).toHaveLength(2);
  expect(new Set(modeled[0].range.map(c=>c.weight))).toEqual(new Set([1]));
  expect(modeled[0].range.flatMap(c=>c.cards).some(c=>view.holeCards.includes(c))).toBe(false);
});
it('keeps relative evidence on long action lines instead of flooring every cumulative weight equally', () => {
  const view=buildBotView(startHand(config,42).state,0);
  view.holeCards=['2c','3d'];
  view.publicPlayers[2].folded=true;
  view.publicHistory=Array.from({length:200}, () => ({seatIndex:1,street:'preflop' as const,type:'raise' as const,amount:100,amountAdded:50,toStreetBet:100,potBefore:100,toCallBefore:20,stackBefore:1000}));
  const range=modelOpponentRanges(view)[0].range;
  const premium=range.find(c=>c.cards.includes('Ac')&&c.cards.includes('Ad'))!;
  const junk=range.find(c=>c.cards.includes('7c')&&c.cards.includes('2d'))!;
  expect(premium.weight).toBeGreaterThan(junk.weight*1e10);
  expect(range.every(c=>c.weight>0&&Number.isFinite(c.weight))).toBe(true);
});
