import type { GameState, LegalActions } from './types';

/**
 * Legal actions for the player currently on action, or null if no action is
 * expected (between streets or hand complete).
 *
 * No-limit rules implemented here:
 * - Min opening bet = one big blind.
 * - Min raise = current bet + the last full bet/raise increment.
 * - An all-in for less than a full raise is allowed (maxTo), but it does NOT
 *   re-open action: a player who already acted (hasActed) keeps no raise
 *   rights — full raises reset hasActed for everyone else, short all-ins don't.
 */
export function legalActions(state: GameState): LegalActions | null {
  if (state.phase === 'complete' || state.actionOn === null) return null;
  const p = state.players[state.actionOn];
  const toCall = state.currentBet - p.streetBet;

  const la: LegalActions = {
    seatIndex: p.seatIndex,
    fold: true,
    check: toCall === 0,
  };
  if (toCall > 0) {
    la.call = { amount: Math.min(toCall, p.stack), allIn: p.stack <= toCall };
  }

  const maxTo = p.streetBet + p.stack;
  if (!p.hasActed && maxTo > state.currentBet) {
    const fullMin =
      state.currentBet === 0
        ? state.config.bigBlind
        : state.currentBet + state.lastRaiseAmount;
    la.raise = { minTo: Math.min(fullMin, maxTo), maxTo };
  }
  return la;
}
