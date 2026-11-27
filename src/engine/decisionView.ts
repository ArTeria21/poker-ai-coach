import type { Card } from '../cards/deck';
import { legalActions } from './bettingRules';
import { firstToReceive, positionOfSeat, totalPot, type GameState, type LegalActions, type Position, type PublicAction, type Street } from './types';

/**
 * The acting seat's information set: its own hole cards plus public table
 * state and history. Bots, grading and public range inference all decide from
 * this projection and never see the GameState itself, so hidden-card leakage
 * is impossible by construction. Opponents' personalities are likewise absent:
 * they exist only in TableController's private state.
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

export interface DecisionView {
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

/** Builds the information set for the seat currently on action. */
export function buildDecisionView(state: GameState, seatIndex: number): DecisionView {
  const la = legalActions(state);
  if (!la || la.seatIndex !== seatIndex) {
    throw new Error(`buildDecisionView: seat ${seatIndex} is not on action`);
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
