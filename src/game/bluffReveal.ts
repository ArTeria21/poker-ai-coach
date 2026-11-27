import type { Card } from '../cards/deck';
import type { Rng } from '../random';
import type { Personality } from '../decision/personalities';
import { postflopStrength } from '../decision/handStrength';
import { analyzeHand } from '../cards/handEval';
import { handLabel, handTier } from '../decision/preflopTiers';

/**
 * After a bot wins without showdown: does it flip over the bluff, and what
 * do we call the hand? Pure — the controller supplies the randomness.
 * Returns the hand description to show (semiBluff: a live draw before the
 * river), or null to muck quietly.
 */
export function bluffRevealCheck(
  personality: Personality,
  holeCards: [Card, Card],
  board: Card[],
  rng: Rng,
): { description: string; semiBluff: boolean } | null {
  if (rng() > personality.showBluffChance) return null;
  if (board.length < 3) return handTier(holeCards) >= 6 ? { description: handLabel(holeCards), semiBluff: false } : null;
  const info = postflopStrength(holeCards, board);
  if (info.strength >= 0.38) return null;
  // Never present a combination the board made as the bot's own hand.
  const playsBoard = info.madeCategory < 8 && (board.length === 5 ? analyzeHand(board).category === info.madeCategory : info.boardMade);
  return { description: playsBoard ? `${handLabel(holeCards)} (playing the board)` : info.description, semiBluff: board.length < 5 && (info.flushDraw || !!info.straightDraw) };
}
