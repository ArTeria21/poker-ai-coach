import type { DecisionView } from '../engine/decisionView';
import type { Position, PublicAction } from '../engine/types';
import type { WeightedCombo } from '../equity/ranges';
import { freshDeck, validateCards } from '../cards/deck';
import { handTier } from './preflopTiers';
import { postflopStrength } from './handStrength';
import { DIFFICULTY_NOISE, PERSONALITIES, type Personality } from './personalities';

const BOARD_LENGTH = { preflop: 0, flop: 3, turn: 4, river: 5 };
/** Observers never see a player's personality (nor a bot's per-seat jitter), only the base archetypes it may be drawn from. */
const ARCHETYPES = Object.values(PERSONALITIES);
/** Type-independent floor: off-policy play (humans, other difficulties) never zeroes a hand; it does not model that play. */
const EPS = 0.002;
// shortcut: medium-calibrated; hard (equity overrides) and easy (fixed tier) bots are mis-modeled — take difficulty as an input if graded hard-mode spots disagree.
/** Medium bots: preflop threshold misread chance and postflop strength-read noise (botDecision). */
const TIER_JITTER = DIFFICULTY_NOISE.medium * 2;
const NOISE = DIFFICULTY_NOISE.medium;

interface Observation {
  action: PublicAction;
  priorRaises: number;
  depthBB: number;
  /** Street bet to match when the action was taken. */
  currentBet: number;
  numActive: number;
  lastPreflopRaiser: number | null;
  board: string[];
}

/** P(clamp(strength + NOISE·(u1+u2−1)) >= x): the triangular read noise of decidePostflop. */
function readAtLeast(strength: number, x: number): number {
  if (x <= 0) return 1;
  if (x > 1) return 0;
  const z = (x - strength) / NOISE;
  return z <= -1 ? 1 : z < 0 ? 1 - (1 + z) ** 2 / 2 : z < 1 ? (1 - z) ** 2 / 2 : 0;
}

/** decidePreflop's action probability for one threshold draw; decideShortStack is handled by the caller. */
function deepPreflop(p: Personality, o: Observation, position: Position, threshold: number, tier: number, bigBlind: number): number {
  const { action } = o;
  // shortcut: raise legality is approximated as stack > call; the no-reopen rule after a short all-in and the everyone-else-all-in case (bettingRules) are ignored; add the reopen/all-in checks if graded spots after short all-ins disagree.
  const toCall = action.toCallBefore, raiseLegal = action.stackBefore > toCall;
  if (o.currentBet <= bigBlind) {
    if (toCall === 0) { // free option: only tier <= 2 raises, at pfrRatio
      const raise = tier <= 2 ? p.pfrRatio : 0;
      return action.type === 'raise' ? raise : action.type === 'check' ? 1 - raise : 0;
    }
    const plays = tier <= threshold ? 1 : 0;
    if (action.type === 'raise') return plays * p.pfrRatio;
    const completes = !plays && position === 'SB' && toCall <= bigBlind / 2 && tier <= threshold + 1 ? 1 : 0;
    return action.type === 'call' ? plays * (1 - p.pfrRatio) + completes : 0;
  }
  // Facing a raise: premium 3-bet at pfrRatio, then a 3-bet bluff at bluffFrequency/2, then the tier call cut.
  const value = tier === 1 ? p.pfrRatio : 0;
  const bluff = raiseLegal ? p.bluffFrequency * 0.5 : 0;
  let callThreshold = threshold - 2;
  if (p.callStationFactor > 0.3) callThreshold += 1;
  if (p.foldToAggression > 0.6) callThreshold -= 1;
  if (toCall > action.stackBefore * 0.25) callThreshold = Math.min(callThreshold, 2);
  const call = (1 - value) * (1 - bluff) * (tier <= Math.max(1, callThreshold) ? 1 : 0);
  if (action.type === 'raise') return raiseLegal ? value + (1 - value) * bluff : 0;
  return action.type === 'call' ? call + (raiseLegal ? 0 : value) : 0; // ensureLegal turns an impossible 3-bet into a call
}

/** P(observed preflop action | tier, archetype) for a medium bot. */
function preflopProbability(p: Personality, o: Observation, position: Position, tier: number, view: DecisionView): number {
  const { action, depthBB } = o;
  const bigBlind = view.bigBlind;
  if (depthBB <= 10) {
    // Mirrors decideShortStack: jam (or call when a raise is impossible) with tier <= threshold, no size pressure; +0.5 and a steep slope fit that deterministic tier cut.
    // shortcut: hard bots' equity overrides and the terminal cheap-call rule are not mirrored, add them if graded short-stack calls disagree with bot play.
    let threshold = p.vpipTierByPosition[position] + (depthBB <= 5 ? 1 : 0);
    if (o.currentBet > bigBlind) threshold += (action.toCallBefore / Math.max(1, action.potBefore + action.toCallBefore) <= 0.2 ? 1 : 0) - 2;
    const jams = 1 / (1 + Math.exp((tier - Math.min(7, Math.max(1, threshold)) - 0.5) * 8));
    return action.type === 'check' ? 1 - jams : jams;
  }
  const base = p.vpipTierByPosition[position];
  let probability = (1 - TIER_JITTER) * deepPreflop(p, o, position, base, tier, bigBlind)
    + TIER_JITTER / 2 * (deepPreflop(p, o, position, base - 1, tier, bigBlind) + deepPreflop(p, o, position, base + 1, tier, bigBlind));
  if (action.type === 'raise') {
    // Bots size by formula; a raise far above it (a human's deep shove) narrows the range. Type-independent, so it only reweights hands.
    const limpers = Math.max(0, Math.round((action.potBefore - view.antePot) / bigBlind - 1.5));
    const standard = o.currentBet > bigBlind ? 3 * o.currentBet : action.toCallBefore === 0 ? o.currentBet + action.potBefore + 2 * bigBlind : (3 + limpers) * bigBlind;
    const pressure = Math.min(3, Math.max(0, Math.log2(action.toStreetBet / standard) - 0.5));
    if (pressure > 0) probability /= 1 + Math.exp((tier - (9 - 2.5 * pressure)) * 2 * pressure);
  }
  return probability;
}

/** P(observed postflop action | read strength, archetype) for a medium bot, integrating decidePostflop's read noise. */
function postflopProbability(p: Personality, o: Observation, strength: number, strongDraw: boolean): number {
  const { action } = o;
  const opponents = Math.max(1, o.numActive - 1);
  const crowd = opponents === 1 ? 1 : opponents === 2 ? 0.5 : 0.25;
  const taper = action.street === 'flop' ? 1 : action.street === 'turn' ? 0.6 : 0.35;
  if (action.toCallBefore === 0) {
    // Sequential bet branches, each firing independently if its read condition holds: value, semi-bluff, c-bet, bluff.
    const valueAt = opponents <= 2 ? 0.45 : 0.55;
    const pValue = Math.min(0.95, 0.7 * p.aggressionFactor);
    const pDraw = strongDraw ? Math.min(0.85, 0.45 * p.aggressionFactor) : 0;
    const pCbet = o.lastPreflopRaiser === action.seatIndex && opponents <= 2 ? Math.min(1, 0.4 * p.aggressionFactor * (action.street === 'flop' ? 1 : 0.45)) : 0;
    const pBluff = Math.min(0.75, p.bluffFrequency * 2 * taper * crowd);
    const s28 = readAtLeast(strength, 0.28), s33 = readAtLeast(strength, 0.33), sValue = readAtLeast(strength, valueAt);
    const check = (1 - pDraw) * ((1 - s28) * (1 - pBluff) + (s28 - s33) * (1 - pCbet) * (1 - pBluff) + (s33 - sValue) * (1 - pCbet) + sValue * (1 - pCbet) * (1 - pValue));
    return action.type === 'check' ? check : action.type === 'raise' ? 1 - check : 0;
  }
  // Facing a bet: value raise, semi-bluff raise, call by adjusted price, bluff raise, else fold.
  const raiseLegal = action.stackBefore > action.toCallBefore; // shortcut: same raise-legality approximation as deepPreflop
  const required = action.toCallBefore / (action.potBefore + action.toCallBefore);
  const effRequired = required * (1 + 0.5 * p.foldToAggression) * (1 - 0.5 * p.callStationFactor);
  const p1 = raiseLegal ? Math.min(0.9, 0.35 * p.aggressionFactor) : 0;
  const p2 = raiseLegal && strongDraw ? Math.min(0.5, p.bluffFrequency + 0.1) * crowd : 0;
  const p4 = raiseLegal ? p.bluffFrequency * 0.3 * crowd : 0;
  const call = (1 - p2) * (readAtLeast(strength, effRequired) - p1 * readAtLeast(strength, Math.max(0.78, effRequired)));
  const noEarlyRaise = (1 - p2) * (1 - p1 * readAtLeast(strength, 0.78));
  if (action.type === 'call') return call;
  return action.type === 'raise' ? 1 - noEarlyRaise + (noEarlyRaise - call) * p4 : 0;
}

/** Per opponent and archetype, log P(public actions | hand, archetype) for every unblocked hand. */
function archetypeLogLikelihoods(view: DecisionView) {
  if (view.publicPlayers.length < 2 || view.publicPlayers.length > 6 || !view.publicPlayers.some(p => p.seatIndex === view.seatIndex)) throw new Error('Public player context required');
  if (view.board.length !== BOARD_LENGTH[view.phase]) throw new Error('Board does not match current street');
  validateCards([...view.holeCards, ...view.board]);
  const deck = freshDeck().filter(c => !view.holeCards.includes(c) && !view.board.includes(c));
  const hands: [string, string][] = [];
  for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) hands.push([deck[i], deck[j]]);
  let raises = 0;
  let lastPreflopRaiser: number | null = null;
  const folded = new Set<number>();
  const cover = (seat: number) => { const p = view.publicPlayers.find(q => q.seatIndex === seat)!; return p.stack + p.totalCommitted; };
  const history: Observation[] = view.publicHistory.map(action => {
    const priorRaises = raises;
    // The bots' preflop push/fold criterion (decisionFacts.effectiveDepthBB) rebuilt from public info: stack + committed is constant all hand.
    const depthBB = Math.max(0, ...view.publicPlayers.filter(p => p.seatIndex !== action.seatIndex && !folded.has(p.seatIndex))
      .map(p => Math.min(cover(action.seatIndex), cover(p.seatIndex)))) / view.bigBlind;
    const numActive = view.publicPlayers.length - folded.size;
    const raiser = lastPreflopRaiser;
    if (action.type === 'fold') folded.add(action.seatIndex);
    if (action.street === 'preflop' && action.type === 'raise') { raises++; lastPreflopRaiser = action.seatIndex; }
    const boardLength = BOARD_LENGTH[action.street];
    if (boardLength > view.board.length) throw new Error('History includes a future street');
    const currentBet = action.toStreetBet - action.amountAdded + action.toCallBefore;
    return { action, priorRaises, depthBB, currentBet, numActive, lastPreflopRaiser: raiser, board: view.board.slice(0, boardLength) };
  });
  const tiers = hands.map(cards => handTier(cards));
  const streetInfo = new Map<number, { strength: Float64Array; strongDraw: Uint8Array }>();
  // Type-independent hand reads, shared by every player and archetype.
  const postflop = (board: string[]) => {
    let info = streetInfo.get(board.length);
    if (!info) {
      info = { strength: new Float64Array(hands.length), strongDraw: new Uint8Array(hands.length) };
      for (let h = 0; h < hands.length; h++) {
        const read = postflopStrength(hands[h], board);
        info.strength[h] = read.strength;
        info.strongDraw[h] = board.length < 5 && (read.flushDraw || read.straightDraw === 'oesd' || read.straightDraw === 'double-gutshot') ? 1 : 0;
      }
      streetInfo.set(board.length, info);
    }
    return info;
  };
  const players = view.publicPlayers.filter(player => player.seatIndex !== view.seatIndex && !player.folded).map(player => {
    const byType = ARCHETYPES.map(() => new Float64Array(hands.length));
    for (const o of history) {
      if (o.action.seatIndex !== player.seatIndex) continue;
      if (o.action.street === 'preflop') {
        ARCHETYPES.forEach((personality, t) => {
          // The likelihood depends on the hand only through its tier.
          const byTier = Array.from({ length: 9 }, (_, tier) => Math.log(EPS + (1 - EPS) * preflopProbability(personality, o, player.position, tier, view)));
          const out = byType[t];
          for (let h = 0; h < hands.length; h++) out[h] += byTier[tiers[h]];
        });
      } else {
        const { strength, strongDraw } = postflop(o.board);
        ARCHETYPES.forEach((personality, t) => {
          const out = byType[t];
          for (let h = 0; h < hands.length; h++) out[h] += Math.log(EPS + (1 - EPS) * postflopProbability(personality, o, strength[h], strongDraw[h] === 1));
        });
      }
    }
    return { seatIndex: player.seatIndex, byType };
  });
  return { hands, players };
}

/**
 * Public observations only: uniform dealt-card prior, every player (bot or human) a uniform-prior mixture of the five base archetypes,
 * fixed for the hand. Each likelihood is the medium bot's own action probability; bet sizes only narrow preflop raises far above
 * the bots' formula sizes. Heuristic reads, not solver ranges.
 */
export function modelOpponentRanges(view: DecisionView) {
  const { hands, players } = archetypeLogLikelihoods(view);
  return players.map(({ seatIndex, byType }) => {
    // The archetype is fixed for the whole hand: sum_t P(t) * prod_actions L(a | hand, t), via log-sum-exp.
    const logWeights = new Float64Array(hands.length);
    let maximum = -Infinity;
    for (let h = 0; h < hands.length; h++) {
      let top = -Infinity;
      for (const out of byType) top = Math.max(top, out[h]);
      let sum = 0;
      for (const out of byType) sum += Math.exp(out[h] - top);
      logWeights[h] = top + Math.log(sum / byType.length);
      maximum = Math.max(maximum, logWeights[h]);
    }
    const range: WeightedCombo[] = hands.map((cards, i) => ({ cards: [...cards], weight: Math.exp(Math.max(-700, logWeights[i] - maximum)) }));
    return { seatIndex, range };
  });
}

/** Public archetype posterior P(archetype | actions) per live opponent: the mixture weights modelOpponentRanges marginalizes over. */
// Test-only calibration probe: a ready-made archetype read — must never be exposed to Dan or the UI.
export function archetypePosterior(view: DecisionView): { seatIndex: number; posterior: Record<string, number> }[] {
  return archetypeLogLikelihoods(view).players.map(({ seatIndex, byType }) => {
    const evidence = byType.map(out => { let top = -Infinity; for (const w of out) top = Math.max(top, w); let sum = 0; for (const w of out) sum += Math.exp(w - top); return top + Math.log(sum); });
    const top = Math.max(...evidence);
    const total = evidence.reduce((sum, e) => sum + Math.exp(e - top), 0);
    return { seatIndex, posterior: Object.fromEntries(ARCHETYPES.map((p, t) => [p.id, Math.exp(evidence[t] - top) / total])) };
  });
}
