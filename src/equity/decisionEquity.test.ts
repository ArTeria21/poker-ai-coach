import { expect, it } from 'vitest';
import { decisionFacts, decisionEquity } from './decisionEquity';
import { icmEquities } from '../math/icm';
import { buildDecisionView, type DecisionView } from '../engine/decisionView';
import { startHand, applyAction } from '../engine/gameStateMachine';
import { legalActions } from '../engine/bettingRules';

const config={smallBlind:5,bigBlind:10,buttonIndex:0,seats:[0,1,2].map(i=>({id:`p${i}`,name:`P${i}`,stack:1000,isHero:i===0}))};
function projection(commitments:number[], stacks:number[]):DecisionView {
  const view=buildDecisionView(startHand(config,42).state,0);
  view.antePot=30; view.phase='river'; view.board=['2c','5d','8h','Js','9c']; view.holeCards=['Kh','Kd'];
  view.toCall=0; view.myStreetBet=commitments[0]; view.myStack=stacks[0]; view.currentBet=Math.max(...commitments);
  view.publicPlayers.forEach((p,i)=>{p.totalCommitted=commitments[i];p.streetBet=commitments[i];p.stack=stacks[i];p.allIn=stacks[i]===0;p.hasActed=true;});
  view.pot=commitments.reduce((a,b)=>a+b,30);
  return view;
}
it('projects side pots, refunds and maximum pairwise cover without mutating the view',()=>{
  const view=projection([50,200,50],[0,0,0]);
  const facts=decisionFacts(view);
  expect(facts.refund).toEqual({seatIndex:1,amount:150});
  expect(facts.pots).toEqual([{amount:180,eligible:[0,1,2]}]);
  expect(facts.terminal).toBe(true);
  const deep=projection([0,0,0],[1000,10,1000]);
  expect(decisionFacts(deep).effectiveDepthBB).toBe(100);
  const before=structuredClone(deep); decisionFacts(deep); expect(deep).toEqual(before);
});
it('matches engine terminal closure after legal calls/checks across real streets',()=>{
  let state=startHand(config,19).state;
  let checked=0;
  while(state.phase!=='complete') {
    const legal=legalActions(state)!;
    const view=buildDecisionView(state,legal.seatIndex);
    const action=legal.check ? {type:'check' as const} : {type:'call' as const};
    const result=applyAction(state,action).state;
    expect(decisionFacts(view).terminal).toBe(result.phase==='complete');
    state=result; checked++;
  }
  expect(checked).toBeGreaterThan(6);
});
it('keeps incomplete one-able-player responses conditional and recognizes a closing all-in call',()=>{
  let state=startHand({...config,seats:config.seats.slice(0,2).map(p=>({...p,stack:100}))},42).state;
  state=applyAction(state,{type:'raise',amount:100}).state;
  const view=buildDecisionView(state,state.actionOn!);
  expect(decisionFacts(view).terminal).toBe(true);
  expect(applyAction(state,{type:'call'}).state.phase).toBe('complete');
});
it('returns public, seeded conditional checkdown EV and no full modeled ranges',()=>{
  const view=buildDecisionView(startHand(config,42).state,0);
  const opts={iterations:500,seed:15};
  const result=decisionEquity(view,opts);
  expect(result.model).toBe('conditional-checkdown');
  expect(result.conditionalChipEV).toBeCloseTo(result.expectedAward!+result.heroRefund-result.call);
  expect(result.participantSeats).toEqual([0,1,2]);
  expect(result).not.toHaveProperty('opponentRanges');
  expect(decisionEquity(view,opts)).toEqual(result);
});
it('settles a tied two-contestant tournament call into conserved ICM stacks with the engine odd chip',()=>{
  const view=projection([50,100,15],[950,900,985]);
  view.board=['As','Ks','Qs','Js','Ts'];view.holeCards=['2c','3d'];view.toCall=50;view.payouts=[0.65,0.35];
  view.publicPlayers[2].folded=true;
  const result=decisionEquity(view,{iterations:50,seed:3});
  expect(result.tie).toBe(1);
  // Pot 245 splits 123 to seat 1 (first clockwise from the SB) and 122 to the hero; the folder keeps 985.
  expect(result.prize!.callEV).toBeCloseTo(icmEquities([1022,1023,985],[0.65,0.35])[0]-icmEquities([950,1095,985],[0.65,0.35])[0],12);
  expect(result.prize!.range).toBeCloseTo(icmEquities([1145,900,985],[0.65,0.35])[0]-icmEquities([900,1145,985],[0.65,0.35])[0],12);
  const short=projection([50,300,15],[200,700,985]);
  short.board=view.board;short.holeCards=view.holeCards;short.toCall=200;short.myStack=200;short.payouts=view.payouts;short.publicPlayers[2].folded=true;
  const refunded=decisionEquity(short,{iterations:50,seed:3});
  // The villain's unmatched 50 returns to the villain in every settled outcome.
  expect(refunded.refund).toEqual({seatIndex:1,amount:50});
  expect(refunded.prize!.callEV).toBeCloseTo(icmEquities([272,1023,985],[0.65,0.35])[0]-icmEquities([200,1095,985],[0.65,0.35])[0],12);
});
