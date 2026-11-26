import { expect, it, vi } from 'vitest';
import { decisionEquity } from '../equity/decisionEquity';
import { RangeSamplingError } from '../equity/monteCarlo';
import { startHand, applyAction } from '../engine/gameStateMachine';
import { buildBotView, decideAction } from './botDecision';
import { PERSONALITIES } from './personalities';
import { mulberry32 } from '../engine/rng';

vi.mock('../equity/decisionEquity', async importOriginal => ({
  ...await importOriginal<typeof import('../equity/decisionEquity')>(), decisionEquity: vi.fn(),
}));

it('falls back explicitly on sampling exhaustion, and propagates validation/programmer errors', () => {
  const config={smallBlind:5,bigBlind:10,buttonIndex:0,seats:[0,1].map(i=>({id:`p${i}`,name:`P${i}`,stack:1000,isHero:false}))};
  const start=startHand(config,42).state;
  const state=applyAction(start,{type:'raise',amount:40}).state;
  const view=buildBotView(state,state.actionOn!);
  vi.mocked(decisionEquity).mockImplementationOnce(()=>{throw new RangeSamplingError('budget');});
  const decision=decideAction(view,PERSONALITIES.shark,'hard',mulberry32(15));
  expect(decision.trace.join(' ')).toContain('sampling budget exhausted');
  expect(()=>applyAction(state,decision.action)).not.toThrow();
  vi.mocked(decisionEquity).mockImplementationOnce(()=>{throw new Error('Invalid cards');});
  expect(()=>decideAction(view,PERSONALITIES.shark,'hard',mulberry32(15))).toThrow('Invalid cards');
});
