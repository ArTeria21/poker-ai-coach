import type { Card } from '../engine/types';
import { rankIndex, suitIndex } from '../engine/deck';
import { analyzeHand, bestStraightHigh } from '../engine/handEval';

export interface StrengthInfo {
  /** 0..1 heuristic — made hand plus draw potential. */
  strength: number;
  /** Made-hand category 0 (straight flush) .. 8 (high card). */
  madeCategory: number;
  flushDraw: boolean;
  straightDraw: 'oesd' | 'gutshot' | null;
  description: string;
}

/** Tunable heuristic weights. */
const BASE_BY_CATEGORY: Record<number, number> = {
  0: 0.99, // straight flush
  1: 0.98, // quads
  2: 0.92, // full house
  3: 0.85, // flush
  4: 0.8, // straight
  5: 0.7, // trips
  6: 0.55, // two pair
  // pair handled specially below
  8: 0.1, // high card
};
const FLUSH_DRAW_BONUS = 0.18;
const OESD_BONUS = 0.14;
const GUTSHOT_BONUS = 0.06;

/**
 * Fast, explainable postflop strength for bot decisions (NOT for the coach —
 * the coach uses real Monte Carlo equity). Board must have 3-5 cards.
 */
export function postflopStrength(hole: [Card, Card], board: Card[]): StrengthInfo {
  const all = [...hole, ...board];
  const analysis = analyzeHand(all);
  const category = analysis.category;

  let base: number;
  if (category === 7) {
    base = pairStrength(hole, board);
  } else {
    base = BASE_BY_CATEGORY[category];
    // A pair on board making our "two pair" is weaker than two live pairs;
    // keep simple for now — tier data can be tuned later.
    if (category === 8) {
      // ace-high is worth a little more than nothing
      const hiRank = Math.max(rankIndex(hole[0]), rankIndex(hole[1]));
      base = hiRank >= 11 ? 0.16 : 0.08;
    }
  }

  // draws only exist while there are cards to come
  const flushDraw = board.length < 5 && category > 3 && hasFlushDraw(hole, board);
  const straightDraw = board.length < 5 && category > 4 ? straightDrawType(hole, board) : null;

  let strength = base;
  if (board.length < 5 && base < 0.6) {
    if (flushDraw) strength += FLUSH_DRAW_BONUS;
    if (straightDraw === 'oesd') strength += OESD_BONUS;
    else if (straightDraw === 'gutshot') strength += GUTSHOT_BONUS;
  }
  return {
    strength: Math.min(0.97, strength),
    madeCategory: category,
    flushDraw,
    straightDraw,
    description: analysis.description,
  };
}

/** How good is our one pair? Overpair > top pair > middle > bottom/under. */
function pairStrength(hole: [Card, Card], board: Card[]): number {
  const h1 = rankIndex(hole[0]);
  const h2 = rankIndex(hole[1]);
  const boardRanks = board.map(rankIndex);
  const topBoard = Math.max(...boardRanks);

  const pocketPair = h1 === h2;
  if (pocketPair) {
    if (h1 > topBoard) return 0.5; // overpair
    if (boardRanks.every((r) => r !== h1) && h1 > Math.min(...boardRanks)) return 0.35;
    return 0.28; // underpair
  }
  // paired one of our hole cards with the board
  const pairedRank = boardRanks.includes(h1) ? h1 : boardRanks.includes(h2) ? h2 : -1;
  if (pairedRank === -1) return 0.3; // board pair, we play a kicker
  if (pairedRank === topBoard) {
    const kicker = pairedRank === h1 ? h2 : h1;
    return kicker >= 10 ? 0.48 : 0.42; // top pair, good/weak kicker
  }
  const sortedBoard = [...boardRanks].sort((a, b) => b - a);
  if (pairedRank >= sortedBoard[1]) return 0.35; // middle pair
  return 0.3; // bottom pair
}

function hasFlushDraw(hole: [Card, Card], board: Card[]): boolean {
  const suitCounts = [0, 0, 0, 0];
  for (const c of [...hole, ...board]) suitCounts[suitIndex(c)]++;
  return suitCounts.some((n, suit) => n === 4 && hole.some((c) => suitIndex(c) === suit));
}

function straightDrawType(hole: [Card, Card], board: Card[]): 'oesd' | 'gutshot' | null {
  const present = new Array<boolean>(13).fill(false);
  for (const c of [...hole, ...board]) present[rankIndex(c)] = true;
  const boardPresent = new Array<boolean>(13).fill(false);
  for (const c of board) boardPresent[rankIndex(c)] = true;
  const personalOuts = present.map((hasRank, rank) => {
    if (hasRank) return false;
    const completed = present.map((has, r) => has || r === rank);
    const completedBoard = boardPresent.map((has, r) => has || r === rank);
    return bestStraightHigh(completed) > bestStraightHigh(completedBoard);
  });
  const at = (r: number) => present[r === -1 ? 12 : r]; // ace plays low

  // open-ended: 4 consecutive ranks with room to fill on either side
  for (let lo = 0; lo <= 8; lo++) {
    if (
      at(lo) && at(lo + 1) && at(lo + 2) && at(lo + 3) &&
      personalOuts[lo === 0 ? 12 : lo - 1] && personalOuts[lo + 4]
    ) {
      return 'oesd';
    }
  }
  return personalOuts.some(Boolean) ? 'gutshot' : null;
}
