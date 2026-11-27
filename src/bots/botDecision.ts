import type { Card, GameState, LegalActions, PlayerAction, Position, Street, PublicAction } from '../engine/types';
import { positionOfSeat, totalPot, firstToReceive } from '../engine/types';
import { legalActions } from '../engine/bettingRules';
import type { Rng } from '../engine/rng';
import { handTier, handLabel } from './preflopTiers';
import { postflopStrength } from './handStrength';
import { decisionFacts, decisionEquity } from '../equity/decisionEquity';
import { RangeSamplingError } from '../equity/monteCarlo';
import { DIFFICULTY_NOISE, type Difficulty, type Personality } from './personalities';

/**
 * Everything a bot may legitimately know when deciding. Constructed from the
 * game state by buildBotView — bots never see the GameState itself, so hole
 * card leakage is impossible by construction. Opponents' personalities are
 * likewise absent: they exist only in TableController's private state.
 */
export interface PublicPlayer {
  id: string;
  seatIndex: number;
  position: Position;
  stack: number;
  streetBet: number;
  totalCommitted: number;
  folded: boolean;
  allIn: boolean;
  hasActed: boolean;
}

export interface BotView {
  handId: string;
  decisionIndex: number;
  buttonIndex: number | null;
  firstToReceiveSeat: number;
  publicPlayers: PublicPlayer[];
  publicHistory: PublicAction[];
  seatIndex: number;
  holeCards: [Card, Card];
  board: Card[];
  phase: Street;
  position: Position;
  /** Total chips in the pot (all commitments so far). */
  pot: number;
  /** Actual ante paid this hand; dead money is not a limper's live bet. */
  antePot: number;
  toCall: number;
  currentBet: number;
  myStreetBet: number;
  myStack: number;
  bigBlind: number;
  /** Tournament prize shares by place; absent for chip-EV-only hands. */
  payouts?: number[];
  legal: LegalActions;
  numActive: number;
  /** True when this seat made the final preflop raise (continuation-bet initiative). */
  iAmLastAggressor?: boolean;
}

export interface BotDecision {
  action: PlayerAction;
  /** Human-readable reasoning trail — debugging now, teaching feature later. */
  trace: string[];
}

/** Builds the information set for the seat currently on action. */
export function buildBotView(state: GameState, seatIndex: number): BotView {
  const la = legalActions(state);
  if (!la || la.seatIndex !== seatIndex) {
    throw new Error(`buildBotView: seat ${seatIndex} is not on action`);
  }
  const p = state.players[seatIndex];
  if (state.phase === 'complete') throw new Error('hand is complete');
  return {
    seatIndex,
    handId: state.handId,
    decisionIndex: state.actionHistory.length,
    buttonIndex: state.buttonIndex,
    firstToReceiveSeat: firstToReceive(state.players.length, state.smallBlindIndex, state.bigBlindIndex),
    publicPlayers: state.players.map(q => ({
      id: q.id, seatIndex: q.seatIndex, position: positionOfSeat(state, q.seatIndex),
      stack: q.stack, streetBet: q.streetBet, totalCommitted: q.totalCommitted,
      folded: q.folded, allIn: q.allIn, hasActed: q.hasActed,
    })),
    publicHistory: state.actionHistory.map(action => ({ ...action })),
    holeCards: [...p.holeCards],
    board: [...state.board],
    phase: state.phase,
    position: positionOfSeat(state, seatIndex),
    pot: totalPot(state),
    antePot: state.antePot,
    toCall: la.call?.amount ?? 0,
    currentBet: state.currentBet,
    myStreetBet: p.streetBet,
    myStack: p.stack,
    bigBlind: state.config.bigBlind,
    payouts: state.config.payouts && [...state.config.payouts],
    legal: la,
    numActive: state.players.filter((q) => !q.folded).length,
    iAmLastAggressor: state.actionHistory.filter(a => a.street === 'preflop' && a.type === 'raise').at(-1)?.seatIndex === seatIndex,
  };
}

export function decideAction(
  view: BotView,
  personality: Personality,
  difficulty: Difficulty,
  rng: Rng,
): BotDecision {
  const trace: string[] = [];
  let equity: ReturnType<typeof decisionEquity> | undefined;
  if (difficulty === 'hard' && view.toCall > 0 && (view.phase !== 'preflop' || view.currentBet > view.bigBlind)) {
    try {
      equity = decisionEquity(view, { iterations: 1000, seed: Math.floor(rng() * 4294967296) });
      trace.push(`range MC: ${(equity.equity * 100).toFixed(1)}% showdown share; ${equity.model} call chip EV ${equity.conditionalChipEV.toFixed(1)}`);
    } catch (error) {
      if (!(error instanceof RangeSamplingError)) throw error;
      trace.push('Range sampling budget exhausted: using the hand-strength heuristic fallback.');
    }
  }
  const facts = decisionFacts(view);
  const raw = view.phase === 'preflop' && facts.effectiveDepthBB <= 10
    ? decideShortStack(view, personality, facts, equity, trace)
    : view.phase === 'preflop'
      ? decidePreflop(view, personality, difficulty, rng, trace, equity)
      : decidePostflop(view, personality, difficulty, rng, trace, equity);
  return { action: ensureLegal(raw, view, trace), trace };
}

// ---------------------------------------------------------------------------

function decidePreflop(
  view: BotView,
  p: Personality,
  difficulty: Difficulty,
  rng: Rng,
  trace: string[],
  equity?: ReturnType<typeof decisionEquity>,
): PlayerAction {
  const tier = handTier(view.holeCards);
  const label = handLabel(view.holeCards);
  let threshold = difficulty === 'easy' ? 5 : p.vpipTierByPosition[view.position];
  // occasional misread — bigger on lower difficulty
  const jitterChance = DIFFICULTY_NOISE[difficulty] * 2;
  if (rng() < jitterChance) {
    threshold += rng() < 0.5 ? -1 : 1;
    trace.push('feeling it: threshold jittered');
  }
  trace.push(`${label} is tier ${tier}; plays tier <= ${threshold} from ${view.position}`);

  const facingRaise = view.currentBet > view.bigBlind;

  if (!facingRaise) {
    if (view.toCall === 0) {
      // BB option (or checked to us)
      if (tier <= 2 && rng() < p.pfrRatio) {
        trace.push('premium with a free option: raising');
        return raiseTo(view.currentBet + Math.round(view.pot + 2 * view.bigBlind));
      }
      trace.push('taking the free look');
      return { type: 'check' };
    }
    if (tier <= threshold) {
      if (rng() < p.pfrRatio) {
        const limpers = Math.max(0, Math.round((view.pot - view.antePot) / view.bigBlind - 1.5));
        trace.push(`open-raising (${limpers} limpers ahead)`);
        return raiseTo((3 + limpers) * view.bigBlind);
      }
      trace.push('limping in');
      return { type: 'call' };
    }
    if (view.position === 'SB' && view.toCall <= view.bigBlind / 2 && tier <= threshold + 1) {
      trace.push('completing the small blind cheap');
      return { type: 'call' };
    }
    trace.push('below threshold: folding');
    return { type: 'fold' };
  }

  // facing a raise
  if (equity && !modeledCallIsPlayable(equity, view, p, trace)) return { type: 'fold' };
  if (tier === 1 && rng() < p.pfrRatio) {
    trace.push('premium vs raise: 3-betting');
    return raiseTo(view.currentBet * 3);
  }
  if (view.legal.raise && rng() < p.bluffFrequency * 0.5) {
    trace.push('3-bet bluffing');
    return raiseTo(view.currentBet * 3);
  }
  let callThreshold = threshold - 2;
  if (p.callStationFactor > 0.3) callThreshold += 1;
  if (p.foldToAggression > 0.6) callThreshold -= 1;
  if (view.toCall > view.myStack * 0.25) callThreshold = Math.min(callThreshold, 2);
  callThreshold = Math.max(1, callThreshold); // premiums never fold to a raise
  if (equity || tier <= callThreshold) {
    trace.push(`calling the raise (tier ${tier} <= ${callThreshold})`);
    return { type: 'call' };
  }
  trace.push(`folding to the raise (tier ${tier} > ${callThreshold})`);
  return { type: 'fold' };
}

function decidePostflop(
  view: BotView,
  p: Personality,
  difficulty: Difficulty,
  rng: Rng,
  trace: string[],
  equity?: ReturnType<typeof decisionEquity>,
): PlayerAction {
  const info = postflopStrength(view.holeCards, view.board);
  const noise = (rng() + rng() - 1) * DIFFICULTY_NOISE[difficulty];
  const s = Math.max(0, Math.min(1, info.strength + noise));
  trace.push(
    `${info.description} (strength ${info.strength.toFixed(2)}${info.flushDraw ? ' +FD' : ''}${info.straightDraw ? ` +${info.straightDraw}` : ''}, read ${s.toFixed(2)})`,
  );

  // Bluffing context: bluff heads-up far more than multi-way, and taper
  // across streets so bots fire the flop more than they triple-barrel.
  const opponents = Math.max(1, view.numActive - 1);
  const crowd = opponents === 1 ? 1 : opponents === 2 ? 0.5 : 0.25;
  const taper = view.phase === 'flop' ? 1 : view.phase === 'turn' ? 0.6 : 0.35;
  const hasStrongDraw = view.board.length < 5 && (info.flushDraw || info.straightDraw === 'oesd' || info.straightDraw === 'double-gutshot');

  if (view.toCall === 0) {
    if (s > (opponents <= 2 ? 0.45 : 0.55) && rng() < Math.min(0.95, 0.7 * p.aggressionFactor)) {
      trace.push('value betting ~60% pot');
      return raiseTo(view.myStreetBet + Math.round(0.6 * view.pot));
    }
    if (hasStrongDraw && rng() < Math.min(0.85, 0.45 * p.aggressionFactor)) {
      trace.push('semi-bluffing the draw: they fold now, or I hit later');
      return raiseTo(view.myStreetBet + Math.round(0.6 * view.pot));
    }
    if (
      view.iAmLastAggressor &&
      opponents <= 2 &&
      s >= 0.28 &&
      rng() < 0.4 * p.aggressionFactor * (view.phase === 'flop' ? 1 : 0.45)
    ) {
      trace.push('continuation bet: told a strong story preflop, sticking to it');
      return raiseTo(view.myStreetBet + Math.round(0.5 * view.pot));
    }
    if (s < 0.33 && view.board.length >= 3 && rng() < Math.min(0.75, p.bluffFrequency * 2 * taper * crowd)) {
      trace.push('bluffing at it');
      return raiseTo(view.myStreetBet + Math.round(0.6 * view.pot));
    }
    trace.push('checking');
    return { type: 'check' };
  }

  const required = view.toCall / (view.pot + view.toCall);
  const effRequired = required * (1 + 0.5 * p.foldToAggression) * (1 - 0.5 * p.callStationFactor);
  trace.push(`facing ${view.toCall} into ${view.pot}: need ${(required * 100).toFixed(0)}% (adjusted ${(effRequired * 100).toFixed(0)}%)`);

  // The modeled showdown share overrules the heuristic: never raise "for value" when it says we are not ahead.
  if (s >= 0.78 && (!equity || equity.equity >= 0.5) && view.legal.raise && rng() < Math.min(0.9, 0.35 * p.aggressionFactor)) {
    trace.push('raising for value');
    return raiseTo(Math.round(view.currentBet * 2.5));
  }
  if (hasStrongDraw && view.legal.raise && rng() < Math.min(0.5, p.bluffFrequency + 0.1) * crowd) {
    trace.push('semi-bluff raising the draw');
    return raiseTo(Math.round(view.currentBet * 2.5));
  }
  if (equity ? modeledCallIsPlayable(equity, view, p, trace) : s >= effRequired) {
    trace.push('calling: strength beats the price');
    return { type: 'call' };
  }
  if (view.legal.raise && rng() < p.bluffFrequency * 0.3 * crowd) {
    trace.push('bluff-raising');
    return raiseTo(Math.round(view.currentBet * 2.5));
  }
  trace.push('folding: too weak for the price');
  return { type: 'fold' };
}

/** Conditional checkdown equity needs a realization policy while betting remains; this is not proven action EV. */
function modeledCallIsPlayable(equity: ReturnType<typeof decisionEquity>, view: BotView, p: Personality, trace: string[]): boolean {
  if (equity.prize) {
    trace.push(`ICM: call vs fold ${(100 * equity.prize.callEV).toFixed(2)}% prize equity.`);
    return equity.prize.callEV >= 0;
  }
  const realization = equity.terminal ? 1 : Math.min(1, (view.phase === 'flop' ? 0.72 : 0.85) + 0.15 * p.callStationFactor);
  const value = equity.expectedAward! * realization + equity.heroRefund - equity.call;
  if (!equity.terminal) trace.push(`Conditional checkdown realization heuristic: ${(100 * realization).toFixed(0)}%, policy value ${value.toFixed(1)} chips.`);
  return value >= 0;
}

/** Lowest heads-up preflop equity of any hand vs AA,KK,QQ,AKs (tier <= 1): 14.19% (Q2o) by exact enumeration, rounded down. */
const MIN_EQUITY_VS_TIER1 = 0.13; // shortcut: a human may shove only AA (weakest hands ~6.2%, A9o), so 6.2-13% prices can be -EV vs them; and on a bubble ICM can make such cheap calls -$EV too (hard bots use prize EV there); use the range model on all difficulties if that matters

/** Positional <=10BB push/fold heuristic, not a solved equilibrium or ICM strategy. */
function decideShortStack(view: BotView, p: Personality, facts: ReturnType<typeof decisionFacts>, equity: ReturnType<typeof decisionEquity> | undefined, trace: string[]): PlayerAction {
  const depth = facts.effectiveDepthBB;
  const tier = handTier(view.holeCards);
  const facingRaise = view.currentBet > view.bigBlind;
  let threshold = p.vpipTierByPosition[view.position] + (depth <= 5 ? 1 : 0);
  if (facingRaise) {
    threshold -= 2;
    if (view.toCall / Math.max(1, view.pot + view.toCall) <= 0.2) threshold += 1;
    if (equity && !modeledCallIsPlayable(equity, view, p, trace)) {
      trace.push(`short-stack: modeled call loses ${equity.prize ? 'prize equity' : 'chips'}; folding.`);
      return { type: 'fold' };
    }
    if (equity && facts.terminal) {
      trace.push(`short-stack: terminal call, modeled ${equity.prize ? 'prize' : 'chip'} EV is non-negative; calling.`);
      return { type: 'call' };
    }
  }
  // Price vs the contestable pot (uncalled excess is refunded): below any hand's equity vs the tightest shove range.
  if (facts.terminal && view.toCall > 0 && view.numActive === 2 && facts.call / facts.contestablePot < MIN_EQUITY_VS_TIER1) {
    trace.push(`short-stack: terminal call priced ${(100 * facts.call / facts.contestablePot).toFixed(1)}% is below any hand's equity; calling.`);
    return { type: 'call' };
  }
  trace.push(`short-stack: ${depth.toFixed(1)}BB matched cover; positional push/fold heuristic tier <= ${Math.min(7, threshold).toFixed(1)}.`);
  if (tier <= Math.min(7, Math.max(1, threshold))) {
    if (view.legal.raise) return raiseTo(Math.min(view.legal.raise.maxTo, Math.round(depth * view.bigBlind)));
    if (view.legal.call) return { type: 'call' };
  }
  return { type: view.legal.check ? 'check' : 'fold' };
}

function raiseTo(target: number): PlayerAction {
  return { type: 'raise', amount: Math.round(target) };
}

/**
 * Guarantees the decision is legal: clamps raises into bounds and degrades
 * gracefully (raise → call → check → fold). Bots must never crash the engine.
 */
function ensureLegal(action: PlayerAction, view: BotView, trace: string[]): PlayerAction {
  const legal = view.legal;
  switch (action.type) {
    case 'raise': {
      if (legal.raise) {
        const amount = Math.max(legal.raise.minTo, Math.min(legal.raise.maxTo, Math.round(action.amount ?? 0)));
        return { type: 'raise', amount };
      }
      trace.push('(raise unavailable — downgrading)');
      if (legal.call) return { type: 'call' };
      return { type: 'check' };
    }
    case 'call':
      if (legal.call) return action;
      return { type: 'check' };
    case 'check':
      if (legal.check) return action;
      if (legal.call) return { type: 'call' };
      return { type: 'fold' };
    case 'fold':
      // never fold when checking is free
      if (legal.check) {
        trace.push('(free to check — not folding)');
        return { type: 'check' };
      }
      return action;
  }
}
