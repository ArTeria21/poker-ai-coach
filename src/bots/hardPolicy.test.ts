import { expect, it } from 'vitest';
import { startHand, startHandWithDeck, applyAction } from '../engine/gameStateMachine';
import { freshDeck } from '../cards/deck';
import type { PlayerAction } from '../engine/types';
import { decideAction } from './botDecision';
import { buildDecisionView } from '../engine/decisionView';
import { PERSONALITIES } from './personalities';
import { mulberry32 } from '../random';
import { modelOpponentRanges } from './opponentRanges';
import { handTier } from './preflopTiers';

const config={smallBlind:5,bigBlind:10,buttonIndex:0,seats:[0,1,2].map(i=>({id:`p${i}`,name:`P${i}`,stack:1000,isHero:i===0}))};
it('hard faced-price decisions actually depend on modeled public ranges',()=>{
  // Heads-up, hero BB with ace-high on Ks 8d 4c 2h 7s facing a river bet at the same pot odds (25.8%) after two public lines.
  const hu={smallBlind:10,bigBlind:20,buttonIndex:0,seats:[0,1].map(i=>({id:`p${i}`,name:`P${i}`,stack:2000,isHero:i===1}))};
  const hero=['Ah','4d'], board=['Ks','8d','4c','2h','7s'];
  const rest=freshDeck().filter(c=>![...hero,...board].includes(c));
  const X:PlayerAction={type:'check'},C:PlayerAction={type:'call'},bet=(amount:number):PlayerAction=>({type:'raise',amount});
  const facing=(line:PlayerAction[])=>{
    let state=startHandWithDeck(hu,[hero[0],rest[0],hero[1],rest[1],...board,...rest.slice(2)],1,'ranges').state;
    for(const a of line) state=applyAction(state,a).state;
    return buildDecisionView(state,1);
  };
  const barrels=facing([bet(60),C,X,bet(70),C,X,bet(150),C,X,bet(300)]);
  const checkedDown=facing([bet(60),C,X,X,X,X,X,bet(64)]);
  expect(barrels.toCall/(barrels.pot+barrels.toCall)).toBeCloseTo(checkedDown.toCall/(checkedDown.pot+checkedDown.toCall),2);
  const a=decideAction(barrels,PERSONALITIES.shark,'hard',mulberry32(12));
  const b=decideAction(checkedDown,PERSONALITIES.shark,'hard',mulberry32(12));
  expect(a.action.type).toBe('fold');
  expect(b.action.type).toBe('call');
  expect(a.trace.join(' ')).toContain('range MC');
});
it('uses short-stack shove/fold across modes, capped to matched coverage',()=>{
  const state=startHand({...config,seats:config.seats.map(p=>({...p,stack:50}))},42).state;
  for(const difficulty of ['easy','medium','hard'] as const) {
    const view=buildDecisionView(state,0);view.holeCards=['As','Kd'];
    expect(decideAction(view,PERSONALITIES.shark,difficulty,mulberry32(5)).action).toEqual({type:'raise',amount:50});
  }
  const deep=startHand({...config,seats:config.seats.map((p,i)=>({...p,stack:i===0?1000:50}))},42).state;
  const view=buildDecisionView(deep,0);view.holeCards=['As','Kd'];
  expect(decideAction(view,PERSONALITIES.shark,'medium',mulberry32(5)).action).toEqual({type:'raise',amount:50});
});
it('keeps a deep hero deep when a second deep opponent remains',()=>{
  const state=startHand({...config,seats:config.seats.map((p,i)=>({...p,stack:i===1?10:1000}))},42).state;
  const view=buildDecisionView(state,0);view.holeCards=['As','Kd'];
  expect(decideAction(view,PERSONALITIES.shark,'medium',mulberry32(5)).trace.join(' ')).not.toContain('short-stack');
});
it('models the same observed 5BB shove wider than a 100BB shove',()=>{
  const views=[50,1000].map(stack=>{
    let state=startHand({...config,seats:config.seats.map(p=>({...p,stack}))},42).state;
    state=applyAction(state,{type:'raise',amount:stack}).state;
    return buildDecisionView(state,state.actionOn!);
  });
  const mean=(i:number)=>{const range=modelOpponentRanges(views[i]).find(p=>p.seatIndex===0)!.range;return range.reduce((s,c)=>s+handTier(c.cards)*c.weight,0)/range.reduce((s,c)=>s+c.weight,0);};
  expect(mean(0)).toBeGreaterThan(mean(1)+1);
});
it('uses preflop initiative even after another player bets a later street',()=>{
  let state=startHand(config,42).state;
  state=applyAction(state,{type:'raise',amount:30}).state;
  state=applyAction(state,{type:'call'}).state;
  state=applyAction(state,{type:'call'}).state;
  state=applyAction(state,{type:'raise',amount:10}).state;
  state=applyAction(state,{type:'call'}).state;
  expect(buildDecisionView(state,0).iAmLastAggressor).toBe(true);
});
it('returns the same seeded decision after private holes, future deck and seed are replaced',()=>{
  let state=startHand(config,42,'public').state;
  state=applyAction(state,{type:'call'}).state;
  state=applyAction(state,{type:'raise',amount:40}).state;
  state=applyAction(state,{type:'fold'}).state;
  const changed=structuredClone(state);changed.seed=0;changed.deck.reverse();changed.players[1].holeCards=['XX','YY'];
  expect(decideAction(buildDecisionView(changed,0),PERSONALITIES.shark,'hard',mulberry32(19))).toEqual(decideAction(buildDecisionView(state,0),PERSONALITIES.shark,'hard',mulberry32(19)));
});
