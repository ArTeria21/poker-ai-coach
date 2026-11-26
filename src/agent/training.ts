import type { CoachSnapshot } from './contract';
import type { ActionType } from '../engine/types';
import { rankIndex, suitIndex } from '../engine/deck';
import { handTier } from '../bots/preflopTiers';
import { potOdds } from '../math/pokerMath';

/**
 * Training Mode state machine: decides when the table locks and when Dan gets an automatic request.
 * Pure: the caller feeds table/chat events and acts on the returned request.
 */

export type Mode = 'free' | 'training';
export type GateKind = 'decision' | 'review';

/** The one thing Dan can unlock: a hero decision (`<handId>#<decisionIndex>`) or the hand's review (`<handId>#review`). */
export interface Gate {
  id: string;
  kind: GateKind;
  locked: boolean;
}

/** Free Play keeps no gate, so it can never hold a lock. */
export type TrainingState =
  | { mode: 'free'; handId: string | null }
  | {
    mode: 'training';
    handId: string | null;
    /** The hand is substantive: a gate opened, the hero put chips in voluntarily, or the user chatted. */
    engaged: boolean;
    /** Latest gate of this hand; an unlocked one stays recorded so it never re-triggers. */
    gate: Gate | null;
  };

export type TrainingEvent =
  /** `key` is the decision gate id; `obvious` comes from `obviousPreflopSpot`. */
  | { type: 'heroTurn'; key: string; obvious: boolean }
  | { type: 'heroActed'; action: ActionType }
  | { type: 'handComplete'; heroDealt: boolean }
  | { type: 'newHand'; handId: string }
  | { type: 'released'; gateId: string }
  | { type: 'userMessage' }
  /** `currentKey`: the decision gate the hero is facing, or the review gate id once the hand is complete. */
  | { type: 'modeChanged'; mode: Mode; currentKey?: string }
  | { type: 'reset' };

export interface TrainingRequest {
  kind: GateKind;
  gateId: string;
}

export interface Step {
  state: TrainingState;
  request?: TrainingRequest;
}

/** Request-side gate: what the chat request was sent for. */
export type RequestGate = Pick<Gate, 'id' | 'kind'>;
/** Text prefix of the automatic trigger messages the app sends as the user. */
export const TRIGGER_PREFIX = '[Тренировка]';

export const decisionGateId = (handId: string, decisionIndex: number) => `${handId}#${decisionIndex}`;
export const reviewGateId = (handId: string) => `${handId}#review`;
const decisionIndexOf = (gateId: string) => Number(gateId.slice(gateId.lastIndexOf('#') + 1));

export const initialTrainingState = (mode: Mode): TrainingState =>
  mode === 'free' ? { mode, handId: null } : { mode, handId: null, engaged: false, gate: null };

export function step(state: TrainingState, event: TrainingEvent): Step {
  const same = { state };
  switch (event.type) {
    case 'reset':
      return { state: initialTrainingState(state.mode) };
    case 'newHand':
      // Repeated delivery of the same hand must not drop its gate.
      if (event.handId === state.handId) return same;
      return { state: { ...initialTrainingState(state.mode), handId: event.handId } };
    case 'modeChanged':
      if (event.mode === state.mode) return same;
      if (event.mode === 'free') return { state: { mode: 'free', handId: state.handId } };
      // Training starts at the next trigger: the decision or finished hand on screen is recorded as handled.
      return {
        state: {
          mode: 'training', handId: state.handId, engaged: false,
          gate: event.currentKey
            ? { id: event.currentKey, kind: event.currentKey.endsWith('#review') ? 'review' : 'decision', locked: false }
            : null,
        },
      };
  }
  if (state.mode === 'free') return same;
  const { gate, handId } = state;

  switch (event.type) {
    case 'heroTurn': {
      // Another hand's key, an earlier decision, or anything after the hand ended is stale; ignoring it can only leave the table unlocked.
      if (handId === null || !event.key.startsWith(`${handId}#`) || gate?.kind === 'review') return same;
      if (gate && decisionIndexOf(event.key) <= decisionIndexOf(gate.id)) return same;
      if (event.obvious && !state.engaged) {
        return { state: { ...state, gate: { id: event.key, kind: 'decision', locked: false } } };
      }
      return {
        state: { ...state, engaged: true, gate: { id: event.key, kind: 'decision', locked: true } },
        request: { kind: 'decision', gateId: event.key },
      };
    }
    case 'heroActed':
      // Only voluntary chips make a hand substantive; a free check does not.
      return event.action === 'call' || event.action === 'raise' ? { state: { ...state, engaged: true } } : same;
    case 'userMessage':
      // Chat after the hand ended does not reopen it for review.
      return gate?.kind === 'review' ? same : { state: { ...state, engaged: true } };
    case 'handComplete': {
      if (handId === null || gate?.kind === 'review') return same;
      // Recorded even when unlocked, so repeated completion events stay no-ops.
      const review: Gate = { id: reviewGateId(handId), kind: 'review', locked: state.engaged && event.heroDealt };
      return { state: { ...state, gate: review }, request: review.locked ? { kind: 'review', gateId: review.id } : undefined };
    }
    case 'released':
      // A late answer carries an older gate id and must not unlock the current one. "Continue without Dan" releases the failed request's gate.
      return gate?.locked && gate.id === event.gateId ? { state: { ...state, gate: { ...gate, locked: false } } } : same;
  }
}

/** Seats where a ≤ 15 BB stack plays push/fold, so even junk can be a shove or a call. */
const PUSH_FOLD_SEATS = new Set(['CO', 'BTN', 'SB', 'BB']);
const PUSH_FOLD_BB = 15;
const LATE_SEATS = new Set(['CO', 'BTN', 'SB']);
/** Depth at which a late seat re-shoves over a late open with the better junk. */
const RESTEAL_BB = 25;
/** Required equity at or below which a call is worth calculating, even with junk. */
const ALL_IN_PRICE = 0.4;
const RAISE_PRICE = 0.25;
const NINE = rankIndex('9c');

/**
 * Preflop spot that Training Mode may skip: offsuit tier-8 junk with an obvious fold (or a free check).
 * Conservative: any doubt means "discuss", since a false "obvious" skips a real decision.
 */
export function obviousPreflopSpot(s: CoachSnapshot): boolean {
  const { cards, position, effectiveStackBB } = s.hero;
  const legal = s.legalActions;
  if (s.street !== 'preflop' || !cards || !position || !legal || effectiveStackBB === null) return false;
  if (handTier(cards) < 8 || suitIndex(cards[0]) === suitIndex(cards[1])) return false;
  const short = effectiveStackBB <= PUSH_FOLD_BB;
  if (short && PUSH_FOLD_SEATS.has(position)) return false;
  if (legal.check) return true;
  // Heads-up the SB completes or defends far too cheaply for any junk to be automatic.
  if (s.players.filter((p) => p.position !== null).length === 2) return false;

  const [a, b] = cards.map(rankIndex);
  const nineHigh = Math.max(a, b) <= NINE;
  const worst = nineHigh && Math.abs(a - b) >= 5; // 72o 82o 83o 92o 93o 94o
  const raises = s.history.filter((h) => h.action === 'raise');
  if (raises.length > 0) {
    const allIn = s.history.some((h) => h.allIn);
    if (potOdds(s.pot, legal.call?.amount ?? 0) <= (allIn ? ALL_IN_PRICE : RAISE_PRICE)) return false;
    if (allIn) return true;
    // The BB closes the action at a discount, so it defends wide against a plain raise.
    if (position === 'BB') return worst;
    // Re-shove (or limp-shove) over a single late open when either stack is shallow; a short opener counts too.
    const open = raises[0];
    const depth = Math.min(effectiveStackBB, open.stackBefore / s.tournament.bigBlind);
    return raises.length === 1 && LATE_SEATS.has(open.position) && depth <= RESTEAL_BB ? worst : true;
  }
  // Unopened or limped. Deep early seats fold all junk; a short UTG/HJ can shove the better junk.
  if ((position === 'UTG' || position === 'HJ') && !short) return true;
  if (position === 'CO') return nineHigh;
  return worst;
}
