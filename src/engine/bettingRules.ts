import type { GameState, LegalActions } from './types';

/**
 * Legal actions for the player currently on action, or null if no action is
 * expected (between streets or hand complete).
 *
 * No-limit rules implemented here:
 * - Min opening bet = one big blind.
 * - Min raise = current bet + the last full bet/raise increment.
 * - An all-in for less than a full raise is allowed (maxTo). For a player who
 *   already acted, short all-ins re-open raising only when their cumulative
 *   increase since that player's last action reaches the last full increment.
 */
export function legalActions(state: GameState): LegalActions | null {
  if (state.phase === 'complete' || state.actionOn === null) return null;
  const p = state.players[state.actionOn];
  const opponents = state.players.filter((q) => q !== p && !q.folded);
  const canRaise = opponents.some((q) => !q.allIn);
  // Against only all-ins, match real commitments rather than a nominal short BB.
  const currentBet = canRaise
    ? state.currentBet
    : Math.max(p.streetBet, ...opponents.map((q) => q.streetBet));
  const toCall = currentBet - p.streetBet;

  const la: LegalActions = {
    seatIndex: p.seatIndex,
    fold: true,
    check: toCall === 0,
  };
  if (toCall > 0) {
    la.call = { amount: Math.min(toCall, p.stack), allIn: p.stack <= toCall };
  }

  const maxTo = p.streetBet + p.stack;
  if (canRaise && (!p.hasActed || toCall >= state.lastRaiseAmount) && maxTo > state.currentBet) {
    const fullMin =
      state.currentBet === 0
        ? state.config.bigBlind
        : state.currentBet + state.lastRaiseAmount;
    la.raise = { minTo: Math.min(fullMin, maxTo), maxTo };
  }
  return la;
}
