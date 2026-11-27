import type { PlayerAction, Street } from '../engine/types';
import type { Card } from '../cards/deck';
import { replayHand, type HandRecord, type ReplayStep } from '../engine/replay';
import { hashSeed } from '../random';
import { buildDecisionView, type DecisionView } from '../engine/decisionView';
import { handTier, handLabel } from '../bots/preflopTiers';
import { PERSONALITIES } from '../bots/personalities';
import { postflopStrength } from '../bots/handStrength';
import { decisionEquity, decisionFacts } from '../equity/decisionEquity';
import { RangeSamplingError } from '../equity/monteCarlo';
import { drawCompletionOuts, spr } from '../math/pokerMath';

export type Verdict = 'good' | 'minor' | 'mistake' | 'blunder' | 'uncertain';
export type MistakeCategory = 'CALL_WITHOUT_ODDS' | 'LOOSE_PREFLOP' | 'FOLD_WHEN_FREE' | 'WILD_RAISE' | 'SIZING';
export interface DecisionGrade {
  handId: string;
  decisionIndex: number;
  seatIndex: number;
  street: Street;
  board: Card[];
  action: PlayerAction;
  actionText: string;
  verdict: Verdict;
  category?: MistakeCategory;
  basis: 'facts' | 'chip-ev-model' | 'prize-ev-model' | 'range-model' | 'sizing-model';
  note: string;
  facts: {
    pot: number;
    toCall: number;
    contestablePot: number;
    netCallCost: number;
    /** Required fraction of eligible chip awards, not whole-field showdown equity; null with no eligible pot. */
    requiredPotShare: number | null;
    amountAdded: number;
    raiseTo: number | null;
    raiseIncrement: number;
    matchedAdded: number;
    matchedRaiseIncrement: number;
    effectiveDepthBB: number;
    spr: ReturnType<typeof spr>;
    draws: ReturnType<typeof drawCompletionOuts> | null;
  };
  model: {
    showdownEquity: number;
    callChipEV: number;
    horizon: 'terminal' | 'conditional-checkdown';
    expectedAward: number;
    heroRefund: number;
    samplingBand: { confidence: number; low: number; high: number; halfWidth: number };
    /** ICM prize equity of call minus fold, in payout units; null outside terminal two-contestant tournament spots with 3+ players. */
    prize: { callEV: number; samplingBand: { confidence: number; low: number; high: number; halfWidth: number } } | null;
    assumptions: string[];
  } | null;
}
export interface HandGrade {
  handId: string;
  decisions: DecisionGrade[];
  summary: string;
  mistakes: number;
  blunders: number;
}
const ITERATIONS = 1000;

/** Same public decision identity and sampling budget for live and replay; never uses the deal seed. */
const decisionSeed = (view: DecisionView) => hashSeed(`${view.handId}:${view.decisionIndex}:${view.seatIndex}`);

export function gradeHand(record: HandRecord, heroSeatIndex: number): HandGrade {
  return gradeHandFromSteps(record.handId, replayHand(record).steps, heroSeatIndex);
}
export function gradeHandFromSteps(handId: string, steps: ReplayStep[], heroSeatIndex: number): HandGrade {
  const decisions: DecisionGrade[] = [];
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    if (step.seatIndex === heroSeatIndex && step.action) {
      const before = buildDecisionView(steps[i - 1].state, heroSeatIndex);
      decisions.push(gradeDecision(before, step.action));
    }
  }
  const counts = (verdict: Verdict) => decisions.filter(d => d.verdict === verdict).length;
  const summary = (['good', 'minor', 'mistake', 'blunder', 'uncertain'] as const).filter(v => counts(v)).map(v => `${counts(v)} ${v}`).join(' · ');
  return { handId, decisions, summary: summary || 'no decisions to grade', mistakes: counts('mistake'), blunders: counts('blunder') };
}

/** Grades the pre-action information set; model-based conclusions are explicitly scoped to chip EV, ICM prize EV or heuristics. */
export function gradeDecision(view: DecisionView, input: PlayerAction): DecisionGrade {
  const legal = view.legal;
  let valid = false;
  switch (input.type) {
    case 'fold':
      valid = legal.fold;
      break;
    case 'check':
      valid = legal.check;
      break;
    case 'call':
      valid = !!legal.call;
      break;
    case 'raise':
      valid = !!legal.raise && Number.isSafeInteger(input.amount)
        && input.amount! >= legal.raise.minTo && input.amount! <= legal.raise.maxTo;
      break;
  }
  if (!valid) throw new Error('Cannot grade an illegal action');
  const action: PlayerAction = input.type === 'raise' ? { type: 'raise', amount: input.amount } : { type: input.type };
  const projection = decisionFacts(view);
  const opponents = view.publicPlayers.filter(p => p.seatIndex !== view.seatIndex && !p.folded);
  const raiseTo = action.type === 'raise' ? action.amount! : null;
  const added = raiseTo === null ? action.type === 'call' ? view.toCall : 0 : raiseTo - view.myStreetBet;
  const matchedTo = raiseTo === null ? 0 : Math.min(raiseTo, Math.max(0, ...opponents.map(p => p.stack + p.streetBet)));
  const grade: DecisionGrade = {
    handId: view.handId, decisionIndex: view.decisionIndex, seatIndex: view.seatIndex,
    street: view.phase, board: [...view.board], action,
    actionText: action.type === 'raise' ? `Raise to ${raiseTo}` : action.type === 'call' ? `Call ${view.toCall}` : action.type,
    verdict: 'uncertain', basis: 'range-model', note: 'The available model does not establish the value of this action.', model: null,
    facts: {
      pot: view.pot, toCall: view.toCall, amountAdded: added,
      contestablePot: projection.contestablePot,
      netCallCost: projection.call - projection.heroRefund,
      requiredPotShare: projection.contestablePot > 0
        ? (projection.call - projection.heroRefund) / projection.contestablePot
        : null,
      raiseTo, raiseIncrement: raiseTo === null ? 0 : raiseTo - view.currentBet,
      matchedAdded: raiseTo === null ? added : Math.max(0, matchedTo - view.myStreetBet),
      matchedRaiseIncrement: raiseTo === null ? 0 : Math.max(0, matchedTo - view.currentBet),
      effectiveDepthBB: projection.effectiveDepthBB,
      spr: spr(projection.effectiveBehind, view.pot),
      draws: view.phase === 'preflop' ? null : drawCompletionOuts({ hero: view.holeCards, board: view.board }),
    },
  };
  const verdict = (
    value: Verdict,
    basis: DecisionGrade['basis'],
    note: string,
    category?: MistakeCategory,
  ): DecisionGrade => ({ ...grade, verdict: value, basis, note, ...(category ? { category } : {}) });
  if (action.type === 'fold' && view.toCall === 0) {
    return verdict(
      'mistake',
      'facts',
      'Checking was free. Folding gives up the hand unnecessarily; no chip-loss amount is inferred.',
      'FOLD_WHEN_FREE',
    );
  }
  try {
    const eq = decisionEquity(view, { iterations: ITERATIONS, seed: decisionSeed(view) });
    const hoeffding = Math.sqrt(Math.log(40) / (2 * ITERATIONS));
    const halfWidth = eq.contestablePot * hoeffding;
    const prizeHalfWidth = eq.prize ? eq.prize.range * hoeffding : 0;
    grade.model = {
      showdownEquity: eq.equity, callChipEV: eq.conditionalChipEV, horizon: eq.model,
      expectedAward: eq.expectedAward!, heroRefund: eq.heroRefund,
      samplingBand: { confidence: 0.95, low: eq.conditionalChipEV - halfWidth, high: eq.conditionalChipEV + halfWidth, halfWidth },
      prize: eq.prize && { callEV: eq.prize.callEV, samplingBand: { confidence: 0.95, low: eq.prize.callEV - prizeHalfWidth, high: eq.prize.callEV + prizeHalfWidth, halfWidth: prizeHalfWidth } },
      assumptions: [
        ...eq.assumptions,
        '95% bounded-award Hoeffding band covers sampling uncertainty only, not range-model uncertainty.',
        'All modeled awards and chip EV describe a hypothetical capped call, not the chosen raise or fold.',
        eq.prize ? 'ICM prize EV is not a solved strategy.' : 'Chip EV is not prize EV, an ICM recommendation or a solved strategy.',
        'Structural draw probabilities use uniform unseen next cards, not range-conditioned clean winning outs.',
      ],
    };
  } catch (error) {
    if (!(error instanceof RangeSamplingError)) throw error;
    return verdict(
      'uncertain',
      'range-model',
      'Range sampling budget was exhausted; no replacement ATC estimate or reliable verdict is available.',
    );
  }
  if ((action.type === 'call' || action.type === 'fold') && projection.terminal) {
    const prize = grade.model!.prize;
    const players = view.publicPlayers.length;
    if (view.payouts && players >= 3 && !prize) {
      return verdict('uncertain', 'chip-ev-model', 'Multiway terminal pot with three or more players left: chip EV does not decide tournament calls, and multiway prize EV is not modeled.');
    }
    const band = prize ? prize.samplingBand : grade.model!.samplingBand;
    const basis = prize ? 'prize-ev-model' : 'chip-ev-model';
    const model = prize ? 'terminal ICM prize-EV model' : 'terminal chip-EV model';
    // Two players left: prize equity is linear in chips, so chip EV sign is the prize EV sign; heads-up blunder severity stays in chips.
    const scope = view.payouts && !prize ? ' With two players left, prize EV is linear in chips, so its sign matches; severity is in chips.' : '';
    const value = prize ? `${(100 * prize.callEV / view.payouts!.reduce((a, b) => a + b, 0)).toFixed(2)}% of the prize pool vs folding` : `${grade.model!.callChipEV.toFixed(1)} chips`;
    if (band.low <= 0 && band.high >= 0) {
      return verdict('uncertain', basis, `The ${model} sampling band overlaps zero (${value}); range uncertainty adds further limits.${scope}`);
    }
    const callWins = band.low > 0;
    if (action.type === 'fold' && callWins) {
      return verdict(
        'uncertain',
        basis,
        `The ${model} favors calling (${value}), but fold errors are not asserted from heuristic opponent ranges.${scope}`,
      );
    }
    if ((action.type === 'call') === callWins) {
      return verdict('good', basis, `Reasonable under the ${model} (call ${value}); ${view.payouts ? 'range accuracy remains' : 'prize EV and range accuracy remain'} unproven.${scope}`);
    }
    // Blunder beyond max(BB, 30% of the call) chips; for prize EV, those chips at the average chip value.
    const chips = Math.max(view.bigBlind, view.toCall * 0.3);
    const threshold = prize ? chips * view.payouts!.reduce((a, b) => a + b, 0) / view.publicPlayers.reduce((sum, p) => sum + p.stack, view.pot) : chips;
    return verdict(
      -band.high > threshold ? 'blunder' : 'mistake',
      basis,
      prize
        ? `The ${model} band is negative (${value}): this call loses tournament equity versus folding under these ranges, whatever it does in chips; model uncertainty is separate.`
        : `The terminal modeled chip-EV band is negative. This call loses chips under these ranges; model uncertainty is separate.${scope}`,
      'CALL_WITHOUT_ODDS',
    );
  }
  const tier = handTier(view.holeCards);
  const positionalPrior = PERSONALITIES.shark.vpipTierByPosition[view.position];
  // The 6-max 100BB starting-hand priors below say nothing about push/fold depths or heads-up ranges.
  if (view.phase === 'preflop' && action.type !== 'check' && (projection.effectiveDepthBB <= 25 || view.publicPlayers.length < 3)) {
    return verdict('uncertain', 'range-model', 'Short-stacked or heads-up preflop: push/fold EV needs opponent calling ranges, which this grader does not model.');
  }
  if (action.type === 'raise') {
    const ratio = grade.facts.matchedRaiseIncrement / Math.max(1, view.pot + view.toCall);
    const forced = legal.raise!.minTo === legal.raise!.maxTo;
    const minimumRaise = raiseTo === legal.raise!.minTo;
    if (view.phase === 'preflop') {
      if (!minimumRaise &&
        !forced &&
        projection.effectiveDepthBB > 40 && // re-jamming over an open is standard up to ~40BB
        tier >= 3 &&
        grade.facts.matchedAdded > Math.max(10 * view.bigBlind, view.myStack * 0.5)) {
        return verdict(
          'mistake',
          'sizing-model',
          `${handLabel(view.holeCards)} commits a large matched portion of a deep stack. This is a sizing heuristic, not a computed raise EV.`,
          'WILD_RAISE',
        );
      }
      if (!minimumRaise && !forced && projection.effectiveDepthBB > 40 && view.currentBet > view.bigBlind && matchedTo > 5 * view.currentBet && tier >= 2) {
        return verdict(
          'minor',
          'sizing-model',
          'This re-raise is unusually large relative to the prior raise; opponent fold/call responses are not modeled.',
          'SIZING',
        );
      }
      if (tier > positionalPrior) {
        return verdict(
          tier >= 7 ? 'mistake' : 'minor',
          'range-model',
          'This starting hand is outside a conservative positional raising prior; no exact raise EV is claimed.',
          'LOOSE_PREFLOP',
        );
      }
      const typicalSize = (view.currentBet <= view.bigBlind && matchedTo <= 5 * view.bigBlind)
        || (view.currentBet > view.bigBlind && matchedTo <= 4 * view.currentBet);
      if (tier <= positionalPrior && typicalSize) {
        return verdict(
          'good',
          'sizing-model',
          'A plausible positional raise size for this starting hand; raise EV and ICM are not established.',
        );
      }
    } else {
      const info = postflopStrength(view.holeCards, view.board);
      if (!forced && info.madeCategory <= 3 && info.strength >= 0.85 && ratio < 0.1) { // flush or better that really stands on this board (no draw bonus at category <= 3)
        return verdict(
          'minor',
          'sizing-model',
          'This very small value size may miss value; opponent response and slow-play benefits remain unknown.',
          'SIZING',
        );
      }
      if (view.board.length < 5 && (info.flushDraw || info.straightDraw === 'oesd' || info.straightDraw === 'double-gutshot') && ratio >= 0.25 && ratio <= 1.2) {
        return verdict(
          'good',
          'sizing-model',
          `A genuine personal ${info.flushDraw ? 'flush draw' : info.straightDraw === 'oesd' ? 'open-ended straight draw' : 'double-gutshot straight draw'} supports a plausible semi-bluff size. Fold equity and action EV are not proven.`,
        );
      }
      const cbet = view.phase === 'flop' && view.iAmLastAggressor && !view.publicHistory.some(a => a.street === view.phase && a.type === 'raise') && view.toCall === 0;
      const dry = new Set(view.board.map(c => c[1])).size >= 2 && Math.max(...view.board.map(c => view.board.filter(b => b[1] === c[1]).length)) <= 2;
      if (cbet && dry && handLabel(view.holeCards).startsWith('AK') && ratio >= 0.25 && ratio <= 0.8) {
        return verdict(
          'good',
          'sizing-model',
          'A plausible AK continuation bet with real preflop initiative; fold equity is an explicit unmeasured assumption.',
        );
      }
      if (info.strength >= 0.6 && grade.model!.showdownEquity >= 0.5 && ratio >= 0.2 && ratio <= 1.5) {
        return verdict(
          'good',
          'sizing-model',
          'A plausible value size under the hand-strength heuristic; response ranges and raise EV remain unknown.',
        );
      }
    }
    return verdict(
      'uncertain',
      'sizing-model',
      'A raise changes opponent fold/call responses. Without that model, its action EV is uncertain, including possible bluffs.',
    );
  }
  if (view.phase === 'preflop') {
    const pressure = view.toCall > Math.max(5 * view.bigBlind, 0.25 * view.myStack);
    const raisePressure = view.currentBet > 3 * view.bigBlind ? 2 : view.currentBet > view.bigBlind ? 1 : 0;
    const callPrior = pressure ? Math.min(2, positionalPrior) : Math.max(1, positionalPrior - raisePressure);
    if (action.type === 'call' && tier > callPrior && pressure) {
      return verdict(
        'mistake',
        'range-model',
        'This expensive preflop call conflicts with a conservative starting-hand prior. Conditional checkdown equity does not prove its EV.',
        'LOOSE_PREFLOP',
      );
    }
    if (action.type === 'call' && tier > callPrior) {
      return verdict(
        'minor',
        'range-model',
        'Voluntarily entering with this weak starting hand falls outside the positional prior; this is a heuristic warning.',
        'LOOSE_PREFLOP',
      );
    }
    if (action.type === 'call' && tier <= callPrior && view.currentBet <= 3 * view.bigBlind) {
      return verdict(
        'good',
        'range-model',
        'A plausible starting hand at a modest preflop price; future realization and ICM remain unknown.',
      );
    }
    if (action.type === 'fold' && tier > callPrior) {
      return verdict(
        'good',
        'range-model',
        'A reasonable conservative preflop fold under the price and starting-hand heuristic, without a prize-EV claim.',
      );
    }
  }
  return verdict(
    'uncertain',
    'range-model',
    action.type === 'check'
      ? 'Checking can preserve slow plays or control the pot; this model does not prove missed value.'
      : 'Betting or opponent responses remain possible. Full-runout equity and next-card draw hits do not prove this action EV.',
  );
}
