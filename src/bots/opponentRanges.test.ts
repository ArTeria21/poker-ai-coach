import { expect, it } from 'vitest';
import { modelOpponentRanges } from './opponentRanges';
import { buildBotView, decideAction } from './botDecision';
import { PERSONALITIES } from './personalities';
import { mulberry32 } from '../engine/rng';
import { startHand, applyAction } from '../engine/gameStateMachine';
import { handTier } from './preflopTiers';
import type { WeightedCombo } from '../equity/ranges';
import type { PlayerAction, PublicAction } from '../engine/types';

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
const short = (pid: string, stacks: number[]) => ({ smallBlind:100, bigBlind:200, bigBlindAnte:200, buttonIndex:0, seats:stacks.map((stack,i) => ({id:`p${i}`,name:`P${i}`,stack,isHero:false,personalityId:pid})) });
it.each<[string, string, number[], PlayerAction[], number, number]>([
  ['HU SB open, 5BB (+1)', 'shark', [1000,8000], [], 0, 1],
  ['HU BB vs 2BB open, ante price 0.2 (+1)', 'shark', [8000,1800], [{type:'raise',amount:400}], 1, 0],
  ['HU BB vs 3BB open (-2)', 'shark', [8000,1800], [{type:'raise',amount:600}], 1, 0],
  ['maniac BTN 8BB (clamp 7)', 'maniac', [1600,8000,8000], [], 0, 2],
  ['deep SB vs short BB after deep BTN fold', 'shark', [8000,8000,1600], [{type:'fold'}], 1, 2],
  ['BB cover exactly 10BB', 'rock', [8000,8000,2200], [{type:'fold'}], 1, 2],
])('%s: short-stack model weights drop sharply right after the tier cut the bot jams', (_name, pid, stacks, before, bot, viewer) => {
  let state = startHand(short(pid,stacks),1).state;
  for (const a of before) state = applyAction(state,a).state;
  const view = buildBotView(state,bot);
  const tiers = new Set<number>(); let jam: PlayerAction | undefined;
  for (const r of '23456789TJQKA') for (const q of '23456789TJQKA') for (const suited of [true,false]) {
    if (r === q && suited) continue;
    const cards: [string,string] = [r+'s', q+(suited ? 's' : 'h')];
    const a = decideAction({...view,holeCards:cards}, PERSONALITIES[pid], 'medium', mulberry32(1)).action;
    if (a.type === 'raise') { tiers.add(handTier(cards)); jam = a; }
  }
  const cut = Math.max(...tiers);
  expect([...tiers].sort()).toEqual(Array.from({length:cut}, (_,i) => i+1));
  state = applyAction(state,jam!).state;
  while (state.actionOn !== viewer) state = applyAction(state,{type:'fold'}).state;
  const range = modelOpponentRanges(buildBotView(state,viewer)).find(p => p.seatIndex === bot)!.range;
  const mean = (t:number) => { const c = range.filter(x => handTier(x.cards) === t); return c.reduce((n,x) => n+x.weight,0)/c.length; };
  expect(mean(cut)).toBeGreaterThan(0.9);
  if (cut < 8) expect(mean(cut+1)).toBeLessThan(0.1);
});
