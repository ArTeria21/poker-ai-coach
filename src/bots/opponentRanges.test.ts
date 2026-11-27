import { describe, expect, it } from 'vitest';
import { archetypePosterior, modelOpponentRanges } from './opponentRanges';
import { jitterPersonality } from './lineup';
import { freshDeck, type Card } from '../cards/deck';
import { evaluate7 } from '../cards/handEval';
import { decideAction } from './botDecision';
import { buildDecisionView } from '../engine/decisionView';
import { PERSONALITIES, type Personality } from './personalities';
import { mulberry32, type Rng } from '../random';
import { startHand, startHandWithDeck, applyAction } from '../engine/gameStateMachine';
import { handTier } from './preflopTiers';
import type { WeightedCombo } from '../equity/ranges';
import type { GameState, PlayerAction, PublicAction, TableConfig } from '../engine/types';

const config = { smallBlind:5, bigBlind:10, buttonIndex:0, seats:[0,1,2].map(i => ({id:`p${i}`,name:`P${i}`,stack:1000,isHero:i===0})) };
const tierShare = (range: WeightedCombo[], tier: number) => range.reduce((n,c) => n+(handTier(c.cards)===tier ? c.weight : 0),0)/range.reduce((n,c)=>n+c.weight,0);
const meanTier = (range: WeightedCombo[]) => range.reduce((n,c) => n+handTier(c.cards)*c.weight,0)/range.reduce((n,c)=>n+c.weight,0);
it('concentrates a three-bet range on premiums (the bots 3-bet only tier 1 for value) yet keeps positive any-two bluff support', () => {
  let state = startHand(config,42).state;
  state = applyAction(state,{type:'raise',amount:30}).state;
  state = applyAction(state,{type:'raise',amount:90}).state;
  state = applyAction(state,{type:'fold'}).state;
  const view = buildDecisionView(state,0);
  const threeBet = modelOpponentRanges(view)[0];
  const loose = structuredClone(view);
  loose.publicPlayers[1].position = 'BTN';
  loose.publicHistory = [ { ...view.publicHistory[1], amount:30, toStreetBet:30, amountAdded:25, toCallBefore:5 } ];
  const open = modelOpponentRanges(loose)[0];
  expect(threeBet.seatIndex).toBe(1);
  expect(tierShare(threeBet.range,1)).toBeGreaterThan(3*tierShare(open.range,1));
  expect(tierShare(threeBet.range,8)).toBeGreaterThan(0.1); // 3-bet bluffs are any two cards
  expect(threeBet.range.every(combo => combo.weight>0)).toBe(true);
  expect(threeBet.range).toHaveLength(1225);
  const before = structuredClone(view);
  expect(modelOpponentRanges(view)).toEqual(modelOpponentRanges(view));
  expect(view).toEqual(before);
});
it('uses only the historical street board and separates blockers from action likelihoods', () => {
  const view = buildDecisionView(startHand(config,42).state,0);
  view.holeCards = ['As','Ad']; view.phase='river'; view.board=['Qh','7h','2c','Kc','3d'];
  view.publicPlayers[2].folded=true;
  view.publicHistory=[{seatIndex:1,street:'flop',type:'raise',amount:60,amountAdded:60,toStreetBet:60,potBefore:100,toCallBefore:0,stackBefore:990} satisfies PublicAction];
  const first=modelOpponentRanges(view)[0].range;
  const second=modelOpponentRanges({...view,board:['Qh','7h','2c','4d','5s']})[0].range;
  const weight=(range:WeightedCombo[], a:string,b:string) => range.find(c=>c.cards.includes(a)&&c.cards.includes(b))!.weight;
  expect(weight(first,'Ah','Kh')/weight(first,'6c','6d')).toBeCloseTo(weight(second,'Ah','Kh')/weight(second,'6c','6d'),10);
});
it('starts unobserved opponents at a uniform card prior and excludes folded seats', () => {
  const view=buildDecisionView(startHand(config,42).state,0);
  const modeled=modelOpponentRanges(view);
  expect(modeled).toHaveLength(2);
  expect(new Set(modeled[0].range.map(c=>c.weight))).toEqual(new Set([1]));
  expect(modeled[0].range.flatMap(c=>c.cards).some(c=>view.holeCards.includes(c))).toBe(false);
});
it('keeps relative evidence on long action lines instead of flooring every cumulative weight equally', () => {
  const view=buildDecisionView(startHand(config,42).state,0);
  view.holeCards=['2c','3d'];
  view.publicPlayers[2].folded=true;
  view.publicHistory=Array.from({length:200}, () => ({seatIndex:1,street:'preflop' as const,type:'raise' as const,amount:100,amountAdded:50,toStreetBet:100,potBefore:100,toCallBefore:20,stackBefore:1000}));
  const range=modelOpponentRanges(view)[0].range;
  const premium=range.find(c=>c.cards.includes('Ac')&&c.cards.includes('Ad'))!;
  const junk=range.find(c=>c.cards.includes('7c')&&c.cards.includes('2d'))!;
  expect(premium.weight).toBeGreaterThan(junk.weight*1e10);
  expect(range.every(c=>c.weight>0&&Number.isFinite(c.weight))).toBe(true);
});
const short = (stacks: number[]) => ({ smallBlind:100, bigBlind:200, bigBlindAnte:200, buttonIndex:0, seats:stacks.map((stack,i) => ({id:`p${i}`,name:`P${i}`,stack,isHero:false})) });
it.each<[string, number[], PlayerAction[], number, number]>([
  ['HU SB open, 5BB (+1)', [1000,8000], [], 0, 1],
  ['HU BB vs 2BB open, ante price 0.2 (+1)', [8000,1800], [{type:'raise',amount:400}], 1, 0],
  ['HU BB vs 3BB open (-2)', [8000,1800], [{type:'raise',amount:600}], 1, 0],
  ['BTN 8BB (maniac clamps at 7)', [1600,8000,8000], [], 0, 2],
  ['deep SB vs short BB after deep BTN fold', [8000,8000,1600], [{type:'fold'}], 1, 2],
  ['BB cover exactly 10BB', [8000,8000,2200], [{type:'fold'}], 1, 2],
])('%s: the short-stack mixture weights each tier by the share of archetypes whose bot jams it', (_name, stacks, before, bot, viewer) => {
  let state = startHand(short(stacks),1).state;
  for (const a of before) state = applyAction(state,a).state;
  const view = buildDecisionView(state,bot);
  const cuts: number[] = []; let jam: PlayerAction | undefined;
  for (const personality of Object.values(PERSONALITIES)) {
    const tiers = new Set<number>();
    for (const r of '23456789TJQKA') for (const q of '23456789TJQKA') for (const suited of [true,false]) {
      if (r === q && suited) continue;
      const cards: [string,string] = [r+'s', q+(suited ? 's' : 'h')];
      const a = decideAction({...view,holeCards:cards}, personality, 'medium', mulberry32(1)).action;
      if (a.type === 'raise') { tiers.add(handTier(cards)); jam = a; }
    }
    const cut = Math.max(...tiers);
    expect([...tiers].sort()).toEqual(Array.from({length:cut}, (_,i) => i+1));
    cuts.push(cut);
  }
  state = applyAction(state,jam!).state;
  while (state.actionOn !== viewer) state = applyAction(state,{type:'fold'}).state;
  const range = modelOpponentRanges(buildDecisionView(state,viewer)).find(p => p.seatIndex === bot)!.range;
  const mean = (t:number) => { const c = range.filter(x => handTier(x.cards) === t); return c.reduce((n,x) => n+x.weight,0)/c.length; };
  for (let t = 1; t <= 8; t++) expect(mean(t)).toBeCloseTo(cuts.filter(cut => cut >= t).length / cuts.length, 1);
});
/**
 * Calibration against the real thing: uniform-archetype, jittered, medium bots dealt uniform hands play each public line;
 * the lines they actually complete give the true archetype posterior, mean tier and hero showdown equity.
 */
describe('archetype mixture matches simulated jittered bots', () => {
  const ids = Object.keys(PERSONALITIES);
  const SEED = Number(process.env.CALIBRATION_SEED ?? 0);
  const maxGap = (truth: Record<string, number>, model: Record<string, number>) => Math.max(...ids.map(id => Math.abs(truth[id] - model[id])));
  const handsWithout = (dead: Card[]) => { const deck = freshDeck().filter(c => !dead.includes(c)); const out: [Card,Card][] = []; for (let i=0;i<deck.length;i++) for (let j=i+1;j<deck.length;j++) out.push([deck[i],deck[j]]); return out; };
  const table = (seats: number, hero: number, stack = 2000): TableConfig => ({ smallBlind:10, bigBlind:20, buttonIndex:0, seats:Array.from({length:seats}, (_,i) => ({id:`p${i}`,name:`P${i}`,stack,isHero:i===hero})) });
  type Line = [seat: number, action: PlayerAction][];
  /** Replays a public line; the target seat's own actions must be what its bot actually chooses, or the deal is rejected (null). */
  const play = (start: GameState, line: Line, target: number, personality: Personality, rng: Rng): GameState | null => {
    let state = start;
    for (const [seat, action] of line) {
      if (state.actionOn !== seat) throw new Error(`line expects seat ${seat}, ${state.actionOn} is on action`);
      if (seat === target && decideAction(buildDecisionView(state,seat), personality, 'medium', rng).action.type !== action.type) return null;
      state = applyAction(state,action).state;
    }
    return state;
  };
  const truthOf = (count: Record<string, number>, total: number) => Object.fromEntries(ids.map(id => [id, count[id] / total]));
  const F: PlayerAction = {type:'fold'}, X: PlayerAction = {type:'check'}, C: PlayerAction = {type:'call'}, bet = (amount: number): PlayerAction => ({type:'raise',amount});
  const open = bet(60);

  // Six-max seats: 0 BTN, 1 SB, 2 BB, 3 UTG, 4 HJ, 5 CO; the viewer is whoever acts after the line.
  it.each<[string, Line, number, number?, number?]>([
    ['UTG open', [[3,open]], 3],
    ['UTG limp', [[3,C]], 3],
    ['HJ 3-bet vs UTG open', [[3,open],[4,bet(180)]], 4],
    ['HJ flat vs UTG open', [[3,open],[4,C]], 4],
    // The bot raises its option with tiers 1-2 only (~4% of hands), so the off-policy floor alone shifts the mean tier ~0.4.
    ['BB free-option raise over a UTG limp', [[3,C],[4,F],[5,F],[0,F],[1,F],[2,bet(110)]], 2, 2000, 0.6],
    ['15BB BTN calls an SB 3-bet (25%-of-stack call cap)', [[3,F],[4,F],[5,F],[0,open],[1,bet(180)],[2,F],[0,C]], 0, 300],
  ])('%s: archetype posterior within 0.05, mean tier within tolerance, tier 1-3 shares within 0.1', (_name, line, target, stack, tierTolerance = 0.25) => {
    const dealt = startHand(table(6,0,stack),3).state;
    const end = play(dealt, line, -1, PERSONALITIES.shark, mulberry32(0))!;
    const view = buildDecisionView(end, end.actionOn!);
    const hands = handsWithout([...view.holeCards, ...view.board]), rng = mulberry32(5 + SEED);
    const count: Record<string, number> = Object.fromEntries(ids.map(id => [id,0]));
    let total = 0, tiers = 0;
    const byTier = new Array<number>(9).fill(0);
    for (const id of ids) for (let k = 0; k < 20; k++) {
      const personality = jitterPersonality(PERSONALITIES[id], rng);
      for (let h = k % 3; h < hands.length; h += 3) {
        const start = { ...dealt, players: dealt.players.map((p, i) => i === target ? { ...p, holeCards: hands[h] } : p) };
        if (!play(start, line, target, personality, rng)) continue;
        count[id]++; total++; tiers += handTier(hands[h]); byTier[handTier(hands[h])]++;
      }
    }
    expect(maxGap(truthOf(count,total), archetypePosterior(view).find(p => p.seatIndex === target)!.posterior)).toBeLessThan(0.05);
    const range = modelOpponentRanges(view).find(p => p.seatIndex === target)!.range;
    expect(Math.abs(meanTier(range) - tiers / total)).toBeLessThan(tierTolerance);
    // Premium tiers pin the cut itself: the floor's junk share can mask an off-by-one in the mean.
    for (const tier of [1, 2, 3]) expect(Math.abs(tierShare(range, tier) - byTier[tier] / total)).toBeLessThan(0.1);
  });

  const board: Card[] = ['Ks','8d','4c','2h','7s'];
  // Heads-up: bot seat 0 (button), hero seat 1. Three-way: BTN 0 holds JJ and is scripted, hero SB 1, bot BB 2.
  it.each<[string, number, [Card,Card], Line, number, Record<number,[Card,Card]>?]>([
    ['open, three barrels; top pair', 2, ['Kh','Qc'], [[0,open],[1,C],[1,X],[0,bet(70)],[1,C],[1,X],[0,bet(150)],[1,C],[1,X],[0,bet(300)]], 0],
    ['open, flop bet, turn check-back, river bet; top pair', 2, ['Kh','Qc'], [[0,open],[1,C],[1,X],[0,bet(70)],[1,C],[1,X],[0,X],[1,X],[0,bet(150)]], 0],
    ['open, check, check, river bet; top pair', 2, ['Kh','Qc'], [[0,open],[1,C],[1,X],[0,X],[1,X],[0,X],[1,X],[0,bet(80)]], 0],
    ['limp, three barrels; set', 2, ['8h','8c'], [[0,C],[1,X],[1,X],[0,bet(30)],[1,C],[1,X],[0,bet(60)],[1,C],[1,X],[0,bet(120)]], 0],
    ['three-way: BB bot bets the flop into two, checks the turn, bets the river', 3, ['Kh','Qc'], [[0,C],[1,C],[2,X],[1,X],[2,bet(40)],[0,C],[1,C],[1,X],[2,X],[0,X],[1,X],[2,bet(100)],[0,C]], 2, {0:['Jd','Jc']}],
  ])('%s: archetype posterior within 0.05 and hero equity within 0.05', (_name, seats, hero, line, target, others = {}) => {
    const cfg = table(seats, 1);
    const heroRank = evaluate7([...hero, ...board]);
    const share = (cards: Card[]) => { const rank = evaluate7([...cards, ...board]); return heroRank < rank ? 1 : heroRank === rank ? 0.5 : 0; };
    const deal = (bot: [Card,Card]) => {
      const holes = cfg.seats.map((_, i) => i === 1 ? hero : i === target ? bot : others[i]);
      const order: Card[] = [];
      for (let round = 0; round < 2; round++) for (let i = 1; i <= seats; i++) order.push(holes[i % seats][round]);
      return [...order, ...board, ...freshDeck().filter(c => !order.includes(c) && !board.includes(c))];
    };
    const hands = handsWithout([...hero, ...board, ...Object.values(others).flat()]), rng = mulberry32(11 + SEED);
    const count: Record<string, number> = Object.fromEntries(ids.map(id => [id,0]));
    let total = 0, wins = 0, last: GameState | undefined;
    for (let rep = 0; rep < 25; rep++) for (const id of ids) {
      const personality = jitterPersonality(PERSONALITIES[id], rng);
      for (const bot of hands) {
        const end = play(startHandWithDeck(cfg, deal(bot), 1, 'calibration').state, line, target, personality, rng);
        if (!end) continue;
        count[id]++; total++; wins += share(bot); last = end;
      }
    }
    expect(total).toBeGreaterThan(500);
    const view = buildDecisionView(last!,1);
    expect(maxGap(truthOf(count,total), archetypePosterior(view).find(p => p.seatIndex === target)!.posterior)).toBeLessThan(0.05);
    const range = modelOpponentRanges(view).find(p => p.seatIndex === target)!.range;
    const modeled = range.reduce((n,c) => n + c.weight * share(c.cards), 0) / range.reduce((n,c) => n + c.weight, 0);
    expect(Math.abs(modeled - wins / total)).toBeLessThan(0.05);
  });
});
