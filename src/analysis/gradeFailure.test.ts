import { expect, it, vi } from 'vitest';
import { decisionEquity } from '../decision/decisionEquity';
import { RangeSamplingError } from '../equity/monteCarlo';
import { startHand } from '../engine/gameStateMachine';
import { buildDecisionView } from '../engine/decisionView';
import { gradeDecision } from './gradeHand';
vi.mock('../decision/decisionEquity',async original=>({...await original<typeof import('../decision/decisionEquity')>(),decisionEquity:vi.fn()}));
it('returns uncertain on exhausted sampling and propagates programmer validation errors',()=>{
  const view=buildDecisionView(startHand({smallBlind:5,bigBlind:10,buttonIndex:0,seats:[0,1].map(i=>({id:`p${i}`,name:'P',stack:1000,isHero:i===0}))},42).state,0);
  vi.mocked(decisionEquity).mockImplementationOnce(()=>{throw new RangeSamplingError('budget');});
  expect(gradeDecision(view,{type:'call'})).toMatchObject({verdict:'uncertain',model:null});
  vi.mocked(decisionEquity).mockImplementationOnce(()=>{throw new Error('bad input');});
  expect(()=>gradeDecision(view,{type:'call'})).toThrow('bad input');
});
