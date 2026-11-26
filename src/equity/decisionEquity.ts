import type { BotView } from '../bots/botDecision';
import { modelOpponentRanges } from '../bots/opponentRanges';
import { buildPots } from '../engine/potManager';
import { chipAmount } from '../math/pokerMath';
import { monteCarloEquity } from './monteCarlo';

/** Public capped-call projection; no opponent action or future street is invented. */
export function decisionFacts(view: BotView) {
  chipAmount(view.toCall, 'Call');
  if (view.toCall > view.myStack || view.bigBlind <= 0) throw new Error('Invalid call or blind');
  const hero = view.publicPlayers.find(p => p.seatIndex === view.seatIndex);
  if (!hero || hero.folded) throw new Error('Missing active hero');
  const players = view.publicPlayers.map(p => p.seatIndex === view.seatIndex ? {
    ...p, stack: p.stack - view.toCall, streetBet: p.streetBet + view.toCall,
    totalCommitted: p.totalCommitted + view.toCall, allIn: p.stack === view.toCall, hasActed: true,
  } : { ...p });
  const active = players.filter(p => !p.folded);
  const able = active.filter(p => p.stack > 0);
  const terminal = able.length <= 1
    ? !able.length || active.every(p => p.streetBet <= able[0].streetBet)
    : view.phase === 'river' && able.every(p => p.hasActed && p.streetBet >= view.currentBet);
  const built = buildPots(players, view.antePot);
  const effectiveCover = Math.max(0, ...view.publicPlayers.filter(p => !p.folded && p.seatIndex !== hero.seatIndex)
    .map(p => Math.min(hero.stack + hero.streetBet, p.stack + p.streetBet)));
  return {
    call: view.toCall,
    pots: built.pots,
    refund: built.uncalled,
    heroRefund: built.uncalled?.seatIndex === view.seatIndex ? built.uncalled.amount : 0,
    terminal,
    effectiveCover,
    effectiveBehind: Math.max(0, effectiveCover - hero.streetBet),
    effectiveDepthBB: effectiveCover / view.bigBlind,
    contestablePot: built.pots.filter(p => p.eligible.includes(view.seatIndex)).reduce((sum,p) => sum + p.amount, 0),
  };
}

/** One shared joint simulation for every side pot, retaining short opponents as card blockers. */
export function decisionEquity(view: BotView, opts: { iterations: number; seed: number }) {
  const facts = decisionFacts(view);
  const modeled = modelOpponentRanges(view);
  const participantSeats = [view.seatIndex, ...modeled.map(p => p.seatIndex)];
  const index = (seat: number) => {
    const participant = participantSeats.indexOf(seat);
    if (participant < 0) throw new Error('Pot participant missing from public ranges');
    return participant;
  };
  const clockwise = view.publicPlayers.map(p => p.seatIndex).sort((a,b) =>
    (a - view.firstToReceiveSeat + view.publicPlayers.length) % view.publicPlayers.length -
    (b - view.firstToReceiveSeat + view.publicPlayers.length) % view.publicPlayers.length);
  const result = monteCarloEquity({
    hero: view.holeCards, board: view.board, opponents: 0,
    opponentRanges: modeled.map(p => p.range),
    iterations: opts.iterations, seed: opts.seed,
    pots: facts.pots.map(p => ({ amount: p.amount, eligible: p.eligible.map(index) })),
    oddChipOrder: clockwise.filter(seat => participantSeats.includes(seat)).map(index),
  });
  return {
    ...result, ...facts, participantSeats,
    conditionalChipEV: result.expectedAward! + facts.heroRefund - facts.call,
    model: facts.terminal ? 'terminal' as const : 'conditional-checkdown' as const,
    assumptions: ['Heuristic public opponent ranges; folded-card likelihoods are not modeled.', 'Projected call then no future bets or folds; ICM and future equity realization are not included.'],
  };
}
