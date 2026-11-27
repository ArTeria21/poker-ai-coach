import { expect, it } from 'vitest';
import type { Card, GameState, PlayerAction, TableConfig } from '../engine/types';
import type { ReplayStep } from '../engine/replay';
import { startHand, startHandWithDeck, applyAction } from '../engine/gameStateMachine';
import { freshDeck } from '../engine/deck';
import { buildBotView, decideAction } from '../bots/botDecision';
import { PERSONALITIES } from '../bots/personalities';
import { mulberry32 } from '../engine/rng';
import { gradeDecision, gradeHand, gradeHandFromSteps } from './gradeHand';

function fixture(holes:[Card,Card][], board:Card[], stacks=holes.map(()=>1000), ante=0) {
  const config:TableConfig={smallBlind:5,bigBlind:10,bigBlindAnte:ante,buttonIndex:0,seats:stacks.map((stack,i)=>({id:`p${i}`,name:`P${i}`,stack,isHero:i===0}))};
  const deal:Card[]=[];for(let r=0;r<2;r++) for(let i=1;i<=holes.length;i++)deal.push(holes[i%holes.length][r]);
  const used=new Set([...deal,...board]);
  if(used.size!==deal.length+board.length)throw new Error('Duplicate rigged cards');
  return startHandWithDeck(config,[...deal,...board,...freshDeck().filter(c=>!used.has(c))],42,'grade-fixture').state;
}
const act=(state:GameState,action:PlayerAction)=>applyAction(state,action).state;
function passTo(state:GameState,street:string) {while(state.phase!==street)state=act(state,{type:buildBotView(state,state.actionOn!).legal.check?'check':'call'});return state;}
const grade=(state:GameState,action:PlayerAction)=>gradeDecision(buildBotView(state,state.actionOn!),action);

it('flags free folds factually, rejects illegal actions and copies canonical snapshots',()=>{
  let state=fixture([['As','Kd'],['5h','5c']],['Qh','7c','2d','3h','9c']);state=act(state,{type:'call'});
  const result=grade(state,{type:'fold'});expect(result).toMatchObject({basis:'facts',category:'FOLD_WHEN_FREE',model:null});
  expect(()=>grade(state,{type:'raise',amount:1})).toThrow('illegal');
  const view=buildBotView(state,state.actionOn!);const checked=gradeDecision(view,{type:'check',seatIndex:99} as PlayerAction);
  view.board.push('XX');expect(checked.board).toEqual([]);expect(checked.action).toEqual({type:'check'});
});
it('uses actual preflop prices including a 100BB shove, without a fictitious BB discount',()=>{
  const results=[20,90,250,1000].map(amount=>{
    let state=fixture([['As','Ad'],['Kh','Kd'],['9h','8h']],['2c','5d','7s','Jc','Qd']);
    state=act(state,{type:'raise',amount});state=act(state,{type:'fold'});
    return grade(state,{type:'call'});
  });
  expect(results.map(g=>g.facts.toCall)).toEqual([10,80,240,990]);
  expect(results[3].category).toBe('CALL_WITHOUT_ODDS');
  expect(results[3].basis).toBe('chip-ev-model');
  expect(results[3].note).toContain('chips');
});
it('distinguishes the same raise symbol at a normal opening size and deep shove size',()=>{
  const state=fixture([['Th','9h'],['As','Ad'],['Kc','Kd']],['2c','5d','8s','Jc','Qd']);
  expect(grade(state,{type:'raise',amount:30}).verdict).toBe('good');
  const shoved=grade(state,{type:'raise',amount:1000});
  expect(shoved).toMatchObject({verdict:'mistake',basis:'sizing-model',category:'WILD_RAISE'});
  expect(shoved.facts).toMatchObject({amountAdded:1000,raiseIncrement:990,matchedAdded:1000});
});
it('separates ordinary flop call uncertainty from closed all-in chip EV',()=>{
  const faced=(stack:number)=>{
    let state=fixture([['Ah','9h'],['Kc','Kd']],['Kh','7h','2c','3s','8d'],[stack,stack]);
    state=passTo(state,'flop');return act(state,{type:'raise',amount:stack===50?40:30});
  };
  const ordinary=grade(faced(1000),{type:'call'});
  expect(ordinary.verdict).toBe('uncertain');expect(ordinary.model?.horizon).toBe('conditional-checkdown');
  expect(ordinary.facts.draws?.nextCardProbability).toBe(9/47);
  const closed=grade(faced(50),{type:'call'});
  expect(closed.model?.horizon).toBe('terminal');expect(closed.model?.assumptions.join(' ')).toContain('Chip EV is not prize EV');
});
it('keeps a hero all-in with two live opponents conditional, and a river call pending another response conditional',()=>{
  let state=fixture([['Ah','9h'],['Kc','Kd'],['Qs','Qd']],['Kh','7h','2c','3s','8d'],[50,500,500]);
  state=passTo(state,'flop');state=act(state,{type:'raise',amount:40});state=act(state,{type:'call'});
  expect(grade(state,{type:'call'}).model?.horizon).toBe('conditional-checkdown');
  state=fixture([['Ah','9h'],['Kc','Kd'],['Qs','Qd']],['Kh','7h','2c','3s','8d']);
  state=passTo(state,'river');state=act(state,{type:'check'});state=act(state,{type:'check'});state=act(state,{type:'raise',amount:30});
  expect(grade(state,{type:'call'}).model?.horizon).toBe('conditional-checkdown');
  state=act(state,{type:'call'});
  expect(grade(state,{type:'call'}).model?.horizon).toBe('terminal');
});
it('allows actual AK continuation bets and personal flush-draw semi-bluffs without a .62 equity gate',()=>{
  const faced=(holes:[Card,Card][],board:Card[])=>{
    let state=fixture(holes,board);state=act(state,{type:'raise',amount:30});state=act(state,{type:'call'});state=act(state,{type:'fold'});return act(state,{type:'check'});
  };
  const cbet=grade(faced([['As','Kd'],['5h','5c'],['9s','9c']],['Qh','7c','2d','3h','Tc']),{type:'raise',amount:30});
  expect(cbet.verdict).toBe('good');expect(cbet.note).toContain('continuation');
  const semi=grade(faced([['Ah','9h'],['Kc','Kd'],['Qs','Qd']],['Kh','7h','2c','3s','8d']),{type:'raise',amount:30});
  expect(semi.verdict).toBe('good');expect(semi.note).toContain('semi-bluff');
});
it('flags tiny river value sizing without forcing checks to be missed value',()=>{
  let state=fixture([['As','Ks'],['5h','5c']],['Qs','Js','Ts','2d','3c']);
  state=act(state,{type:'raise',amount:400});state=act(state,{type:'call'});state=passTo(state,'river');state=act(state,{type:'check'});
  expect(grade(state,{type:'raise',amount:10})).toMatchObject({verdict:'minor',category:'SIZING'});
  expect(grade(state,{type:'check'})).toMatchObject({verdict:'uncertain'});
});
it('does not turn SE=0 on a tied board into proof of a small chip edge',()=>{
  let state=fixture([['2c','3d'],['4c','5d']],['As','Ks','Qs','Js','Ts']);state=passTo(state,'river');state=act(state,{type:'raise',amount:990});
  const result=grade(state,{type:'call'});expect(result.verdict).toBe('uncertain');
  expect(result.model?.samplingBand.low).toBeLessThan(0);expect(result.model?.samplingBand.high).toBeGreaterThan(0);
});
it('grades every pre-action identically in live calls and batch, ignoring future/private data',()=>{
  let state=fixture([['7h','2c'],['Ah','Kd'],['9s','9c']],['Ks','8d','3c','Jh','4d']);
  const steps:ReplayStep[]=[{state,events:[]}];const live=[];
  while(state.phase!=='complete'){
    const seatIndex=state.actionOn!;const action:PlayerAction={type:buildBotView(state,seatIndex).legal.check?'check':'call'};
    if(seatIndex===0)live.push(grade(state,action));
    const result=applyAction(state,action);state=result.state;steps.push({...result,action,seatIndex});
  }
  expect(gradeHandFromSteps('grade-fixture',steps,0).decisions).toEqual(live);
  const before=structuredClone(steps[0].state);before.seed=11;before.deck.reverse();before.players[1].holeCards=['XX','YY'];
  expect(grade(before,{type:'call'})).toEqual(live[0]);
  steps.at(-1)!.state.board=['XX'];expect(gradeHandFromSteps('grade-fixture',steps,0).decisions).toEqual(live);
 });
it('uses the identical seed replay grading path for real seeded hands',()=>{
  let state=startHand({smallBlind:5,bigBlind:10,buttonIndex:0,seats:[0,1].map(i=>({id:`p${i}`,name:`P${i}`,stack:1000,isHero:i===0}))},42,'seeded-grades').state;
  const initial=state;const live=[];
  while(state.phase!=='complete'){
    const action:PlayerAction={type:buildBotView(state,state.actionOn!).legal.check?'check':'call'};
    if(state.actionOn===0)live.push(grade(state,action));
    state=act(state,action);
  }
  expect(gradeHand({handId:initial.handId,config:initial.config,seed:initial.seed,actions:state.actionHistory},0).decisions).toEqual(live);
});
it('grades a three-bet and three barrels into an overbet against the public range rather than ATC',()=>{
  let state=fixture([['Ad','2c'],['Ts','9h']],['As','Kh','Qd','Jc','3s'],[2000,2000]);
  for(const action of [
    {type:'raise',amount:20},{type:'raise',amount:60},{type:'call'},
    {type:'raise',amount:100},{type:'call'},{type:'raise',amount:220},{type:'call'},{type:'raise',amount:1200},
  ] as PlayerAction[])state=act(state,action);
  const folded=grade(state,{type:'fold'}),called=grade(state,{type:'call'});
  expect(folded).toMatchObject({verdict:'good',basis:'chip-ev-model'});
  expect(called.category).toBe('CALL_WITHOUT_ODDS');expect(called.model!.showdownEquity).toBeLessThan(.3); // top pair, weak kicker: 71% vs any two cards
  expect(folded.note).toContain('prize EV');
});
it('caps unmatched nominal raises and does not penalize a required minimum as an oversized alternative',()=>{
  const short=fixture([['Th','9h'],['As','Ad'],['Kc','Kd']],['2c','5d','8s','Jc','Qd'],[1000,50,50]);
  const raised=grade(short,{type:'raise',amount:1000});
  expect(raised.facts.matchedAdded).toBe(50);expect(raised.category).not.toBe('WILD_RAISE');
  let state=fixture([['As','Ad'],['Kc','Kd'],['Th','9h']],['2c','5d','8s','Jc','Qd']);
  state=act(state,{type:'raise',amount:500});state=act(state,{type:'fold'});
  const view=buildBotView(state,2);
  expect(gradeDecision(view,{type:'raise',amount:view.legal.raise!.minTo}).category).not.toBe('SIZING');
});
it('keeps pure bluffs uncertain without inventing a raise EV or WILD_RAISE error',()=>{
  let state=fixture([['6h','5h'],['As','Ad']],['Kc','Qd','8s','2c','3d']);state=passTo(state,'river');state=act(state,{type:'check'});
  const result=grade(state,{type:'raise',amount:20});
  expect(result).toMatchObject({verdict:'uncertain',basis:'sizing-model'});
  expect(result.model).toHaveProperty('callChipEV');expect(result.model).not.toHaveProperty('conditionalChipEV');
});
it('uses the neutral positional prior for the same opening hand UTG versus button',()=>{
  const holes:[Card,Card][]=[['As','7s'],['Kc','Kd'],['Qh','Qd'],['Ah','7h'],['Jc','Jd'],['Tc','Td']];
  const state=fixture(holes,['2c','5d','8s','9c','3d']);
  // Six handed action starts at seat 3 (UTG); both tested hands are A7s.
  const early=grade(state,{type:'raise',amount:30});
  let late=act(state,{type:'fold'});late=act(late,{type:'fold'});late=act(late,{type:'fold'});
  expect(buildBotView(late,0).position).toBe('BTN');
  const button=grade(late,{type:'raise',amount:30});
  expect(early.category).toBe('LOOSE_PREFLOP');expect(button.verdict).toBe('good');
});
it('pins the 25BB / 3-player starting-hand gate and the 40BB jam/sizing floor',()=>{
  const board:Card[]=['2c','5d','8s','9c','3d'];
  const open=(stacks:number[],amount:number)=>grade(fixture(([['7h','2d'],['Kc','Kd'],['Qh','Qd']] as [Card,Card][]).slice(0,stacks.length),board,stacks),{type:'raise',amount});
  expect(open([250,1000,1000],30).verdict).toBe('uncertain');
  expect(open([260,1000,1000],30).category).toBe('LOOSE_PREFLOP');
  expect(open([1000,1000],30).verdict).toBe('uncertain'); // heads-up
  expect(open([410,1000,1000],410)).toMatchObject({verdict:'mistake',category:'WILD_RAISE'}); // first-in open-jam
  const rejam=(stack:number,action:PlayerAction)=>{let state=fixture([['Kc','Kd'],['Qh','Qd'],['As','8h']],board,[1000,1000,stack]);state=act(state,{type:'raise',amount:30});state=act(state,{type:'fold'});return grade(state,action);};
  expect(rejam(100,{type:'fold'}).verdict).toBe('uncertain'); // 10BB A8o fold is not praised by 100BB priors
  expect(rejam(220,{type:'raise',amount:220}).verdict).toBe('uncertain');
  expect(['WILD_RAISE','SIZING']).not.toContain(rejam(400,{type:'raise',amount:400}).category);
  expect(rejam(410,{type:'raise',amount:200}).category).toBe('SIZING');
  expect(rejam(1000,{type:'raise',amount:1000})).toMatchObject({verdict:'mistake',category:'WILD_RAISE'});
});
it('recognizes a genuine open-ended semi-bluff separately from a gutshot',()=>{
  let state=fixture([['6h','7h'],['As','Ad']],['4c','5d','Ks','2c','Qd']);
  state=passTo(state,'flop');state=act(state,{type:'check'});
  const result=grade(state,{type:'raise',amount:10});
  expect(result.verdict).toBe('good');expect(result.note).toContain('open-ended');
});
it('treats a double gutshot as a strong semi-bluff draw without calling it open-ended',()=>{
  let state=fixture([['8h','Td'],['As','Ad']],['6c','9s','Qd','2c','3d']);
  state=passTo(state,'flop');state=act(state,{type:'check'});
  const result=grade(state,{type:'raise',amount:10});
  expect(result.verdict).toBe('good');expect(result.note).toContain('double-gutshot');expect(result.note).not.toContain('open-ended');
});
it.each<[[Card,Card],Card[]]>([
  [['7c','2d'],['As','Ah','Ad','Ks','Kh']],[['3c','4d'],['2h','5h','8h','Jh','Kh']],[['3c','4d'],['9s','Th','Jd','Qc','Ks']],[['3c','4d'],['As','Ad','Ah','Ac','2d']],
])('does not credit a hand played off the board %j as value',(hole,board)=>{
  let state=fixture([hole,['6c','6d']],board);state=act(state,{type:'raise',amount:200});state=passTo(state,'river');state=act(state,{type:'check'});
  expect(grade(state,{type:'raise',amount:200}).verdict).toBe('uncertain'); // half pot
  expect(grade(state,{type:'raise',amount:20}).category).toBeUndefined(); // tiny size: no "missed value" SIZING
});
it('does not call a heuristic value raise good when the modeled equity says it is behind',()=>{
  // A 3-high flush (heuristically strong) vs a 3-bet, flop check-raise and two barrels: the modeled range holds the bigger flushes and boats.
  let state=fixture([['2s','3c'],['Kd','Kh']],['Qs','As','Tc','Ts','7s']);
  for(const action of [{type:'raise',amount:30},{type:'raise',amount:90},{type:'call'},{type:'check'},{type:'raise',amount:70},{type:'raise',amount:200},{type:'call'},{type:'raise',amount:150},{type:'call'},{type:'raise',amount:150}] as PlayerAction[])state=act(state,action);
  expect(state.phase).toBe('river');
  const result=grade(state,{type:'raise',amount:450});
  expect(result.model!.showdownEquity).toBeLessThan(0.5);expect(result.verdict).toBe('uncertain');
});
it('does not flag a tiny bet as missed value when draw bonuses, not a made flush, push strength high',()=>{
  let state=fixture([['8h','8d'],['As','Kc']],['6h','7h','9h','9d','2c']);state=act(state,{type:'raise',amount:200});
  state=passTo(state,'turn');state=act(state,{type:'check'});
  expect(grade(state,{type:'raise',amount:10}).category).toBeUndefined(); // two pair + FD + OESD = 0.87
});
it('keeps a positive chip-EV tournament fold uncertain and out of generic mistake counts',()=>{
  let state=fixture([['As','Ks'],['5h','5c']],['Qs','Js','Ts','2d','3c']);
  state=passTo(state,'river');state=act(state,{type:'raise',amount:990});
  const result=grade(state,{type:'fold'});
  expect(result.model!.samplingBand.low).toBeGreaterThan(0);
  expect(result).toMatchObject({verdict:'uncertain',basis:'chip-ev-model'});
  expect(result.category).toBeUndefined();
  const after=applyAction(state,{type:'fold'});
  const batch=gradeHandFromSteps(state.handId,[{state,events:[]},{...after,action:{type:'fold'},seatIndex:0}],0);
  expect(batch.mistakes).toBe(0);expect(batch.blunders).toBe(0);
});
it('quotes the price against eligible awards, excluding inaccessible side pots and unmatched excess',()=>{
  for(const ante of [0,10]) {
    let state=fixture([['Kh','Kd'],['As','Ad'],['Qs','Qd']],['2c','5d','8s','Jc','9d'],[50,200,200],ante);
    state=act(state,{type:'call'});state=act(state,{type:'raise',amount:200});state=act(state,{type:'call'});
    const result=grade(state,{type:'call'});
    expect(result.facts.contestablePot).toBe(150+ante);
    expect(result.facts.netCallCost).toBe(40);
    expect(result.facts.requiredPotShare).toBe(40/(150+ante));
    expect(result.facts).not.toHaveProperty('rawRequiredEquity');
  }
});
it('grades bubble all-in calls on ICM prize EV, not chip EV',()=>{
  const spot=(hero:[Card,Card],payouts?:number[])=>{
    let state=fixture([['2c','3d'],['6c','7d'],hero],[],[50,150,100],10);state=act(state,{type:'fold'});state=act(state,{type:'raise',amount:90});
    return buildBotView({...state,config:{...state.config,payouts}},2);
  };
  expect(gradeDecision(spot(['Kh','Qd']),{type:'call'}).verdict).toBe('good');
  const call=gradeDecision(spot(['Kh','Qd'],[0.65,0.35]),{type:'call'});
  expect(call).toMatchObject({verdict:'mistake',basis:'prize-ev-model',category:'CALL_WITHOUT_ODDS'});
  expect(call.model!.prize!.samplingBand.high).toBeLessThan(0);
  expect(gradeDecision(spot(['Kh','Qd'],[0.65,0.35]),{type:'fold'})).toMatchObject({verdict:'good',basis:'prize-ev-model'});
  expect(gradeDecision(spot(['Ah','Ad'],[0.65,0.35]),{type:'call'})).toMatchObject({verdict:'good',basis:'prize-ev-model'});
  expect(gradeDecision(spot(['7h','2s'],[0.65,0.35]),{type:'call'}).verdict).toBe('blunder');
  const bot=(hero:[Card,Card],payouts?:number[])=>decideAction(spot(hero,payouts),PERSONALITIES.shark,'hard',mulberry32(1)).action.type;
  expect([bot(['Kh','Qd'],[0.65,0.35]),bot(['Kh','Qd']),bot(['Ah','Ad'],[0.65,0.35])]).toEqual(['fold','call','call']);
  // Multiway all-in with three players left: no prize model, so no verdict.
  for(const hero of [['Ah','Ad'],['7h','2s']] as [Card,Card][]){
    let state=fixture([['2c','3d'],['6c','7d'],hero],[],[50,150,100],10);state=act(state,{type:'raise',amount:50});state=act(state,{type:'raise',amount:150});
    const multi=gradeDecision(buildBotView({...state,config:{...state.config,payouts:[0.65,0.35]}},2),{type:'call'});
    expect(multi.model!.prize).toBeNull();expect(multi).toMatchObject({verdict:'uncertain',basis:'chip-ev-model'});
  }
  // Heads-up: chip EV decides, and blunder severity stays in chips.
  let hu=fixture([['As','Kd'],['7h','2s']],[],[1000,300]);hu=act(hu,{type:'raise',amount:300});
  expect(gradeDecision(buildBotView({...hu,config:{...hu.config,payouts:[0.65,0.35]}},1),{type:'call'})).toMatchObject({verdict:'blunder',basis:'chip-ev-model'});
});
