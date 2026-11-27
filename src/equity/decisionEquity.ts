import type { DecisionView } from '../engine/decisionView';
import { modelOpponentRanges } from '../bots/opponentRanges';
import { buildPots } from '../engine/potManager';
import { chipAmount } from '../math/pokerMath';
import { icmEquities, icmOutcomeEV } from '../math/icm';
import { monteCarloEquity } from './monteCarlo';

/** Public capped-call projection; no opponent action or future street is invented. */
export function decisionFacts(view: DecisionView) {
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
export function decisionEquity(view: DecisionView, opts: { iterations: number; seed: number }) {
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
  const seats = view.publicPlayers.map(p => p.seatIndex);
  const contestants = view.publicPlayers.filter(p => !p.folded).map(p => p.seatIndex);
  let prize: { callEV: number; range: number } | null = null;
  // With two players left, prize equity is linear in chips, so the chip EV already decides.
  if (view.payouts && facts.terminal && contestants.length === 2 && seats.length >= 3) {
    const hero = seats.indexOf(view.seatIndex), villain = contestants.find(s => s !== view.seatIndex)!;
    const folded = view.publicPlayers.map(p => p.stack + (p.seatIndex === villain ? view.pot : 0));
    const settle = (winners: number[]) => {
      const stacks = view.publicPlayers.map(p => p.stack - (p.seatIndex === view.seatIndex ? view.toCall : 0));
      if (facts.refund) stacks[seats.indexOf(facts.refund.seatIndex)] += facts.refund.amount;
      for (const pot of facts.pots) {
        const eligible = clockwise.filter(s => pot.eligible.includes(s));
        const split = eligible.some(s => winners.includes(s)) ? eligible.filter(s => winners.includes(s)) : eligible;
        split.forEach((s, i) => { stacks[seats.indexOf(s)] += Math.floor(pot.amount / split.length) + Number(i < pot.amount % split.length); });
      }
      return stacks;
    };
    const win = settle([view.seatIndex]), lose = settle([villain]);
    prize = {
      callEV: icmOutcomeEV(folded, view.payouts, hero, [
        { probability: result.win, stacks: win },
        { probability: result.tie, stacks: settle(contestants) },
        { probability: Math.max(0, 1 - result.win - result.tie), stacks: lose },
      ]).delta,
      range: icmEquities(win, view.payouts)[hero] - icmEquities(lose, view.payouts)[hero],
    };
  }
  return {
    ...result, ...facts, participantSeats, prize,
    conditionalChipEV: result.expectedAward! + facts.heroRefund - facts.call,
    model: facts.terminal ? 'terminal' as const : 'conditional-checkdown' as const,
    assumptions: ['Heuristic public opponent ranges; folded-card likelihoods are not modeled.', prize
      ? 'Projected call then no future bets or folds; prize EV is exact ICM of the settled win/tie/loss stacks versus the fold, ignoring future blinds and skill.'
      : 'Projected call then no future bets or folds; ICM and future equity realization are not included.'],
  };
}
