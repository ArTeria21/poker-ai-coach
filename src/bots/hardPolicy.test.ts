import { expect, it } from 'vitest';
import { startHand, applyAction } from '../engine/gameStateMachine';
import { buildBotView, decideAction } from './botDecision';
import { PERSONALITIES } from './personalities';
import { mulberry32 } from '../engine/rng';
import { modelOpponentRanges } from './opponentRanges';
import { handTier } from './preflopTiers';

const config={smallBlind:5,bigBlind:10,buttonIndex:0,seats:[0,1,2].map(i=>({id:`p${i}`,name:`P${i}`,stack:1000,isHero:i===0,personalityId:'shark'}))};
it('hard faced-price decisions actually depend on modeled public ranges',()=>{
  let state=startHand(config,42).state;
  state=applyAction(state,{type:'call'}).state;
  state=applyAction(state,{type:'raise',amount:1000}).state;
  state=applyAction(state,{type:'fold'}).state;
  const view=buildBotView(state,0); view.holeCards=['Qs','Qd'];
  const tight=structuredClone(view);tight.publicPlayers[1].personalityId='nit';
  const loose=structuredClone(view);loose.publicPlayers[1].personalityId='maniac';
  const a=decideAction(tight,PERSONALITIES.shark,'hard',mulberry32(12));
  const b=decideAction(loose,PERSONALITIES.shark,'hard',mulberry32(12));
  expect(a.action.type).toBe('fold');
  expect(b.action.type).toBe('call');
  expect(a.trace.join(' ')).toContain('range MC');
});
it('uses short-stack shove/fold across modes, capped to matched coverage',()=>{
  const state=startHand({...config,seats:config.seats.map(p=>({...p,stack:50}))},42).state;
  for(const difficulty of ['easy','medium','hard'] as const) {
    const view=buildBotView(state,0);view.holeCards=['As','Kd'];
    expect(decideAction(view,PERSONALITIES.shark,difficulty,mulberry32(5)).action).toEqual({type:'raise',amount:50});
  }
  const deep=startHand({...config,seats:config.seats.map((p,i)=>({...p,stack:i===0?1000:50}))},42).state;
  const view=buildBotView(deep,0);view.holeCards=['As','Kd'];
  expect(decideAction(view,PERSONALITIES.shark,'medium',mulberry32(5)).action).toEqual({type:'raise',amount:50});
});
it('keeps a deep hero deep when a second deep opponent remains',()=>{
  const state=startHand({...config,seats:config.seats.map((p,i)=>({...p,stack:i===1?10:1000}))},42).state;
  const view=buildBotView(state,0);view.holeCards=['As','Kd'];
  expect(decideAction(view,PERSONALITIES.shark,'medium',mulberry32(5)).trace.join(' ')).not.toContain('short-stack');
});
it('models the same observed 5BB shove wider than a 100BB shove',()=>{
  const views=[50,1000].map(stack=>{
    let state=startHand({...config,seats:config.seats.map(p=>({...p,stack}))},42).state;
    state=applyAction(state,{type:'raise',amount:stack}).state;
    return buildBotView(state,state.actionOn!);
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
  expect(buildBotView(state,0).iAmLastAggressor).toBe(true);
});
it('returns the same seeded decision after private holes, future deck and seed are replaced',()=>{
  let state=startHand(config,42,'public').state;
  state=applyAction(state,{type:'call'}).state;
  state=applyAction(state,{type:'raise',amount:40}).state;
  state=applyAction(state,{type:'fold'}).state;
  const changed=structuredClone(state);changed.seed=0;changed.deck.reverse();changed.players[1].holeCards=['XX','YY'];
  expect(decideAction(buildBotView(changed,0),PERSONALITIES.shark,'hard',mulberry32(19))).toEqual(decideAction(buildBotView(state,0),PERSONALITIES.shark,'hard',mulberry32(19)));
});
