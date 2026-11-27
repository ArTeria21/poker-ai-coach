import { freshDeck, rankIndex, suitIndex, type Card } from '../cards/deck';
import { analyzeHand, bestStraightHigh, evaluate7 } from '../cards/handEval';

export interface StrengthInfo {
  /** 0..1 heuristic — made hand plus draw potential. */
  strength: number;
  /** Made-hand category 0 (straight flush) .. 8 (high card). */
  madeCategory: number;
  flushDraw: boolean;
  /** double-gutshot: two personal completing ranks without four in a row — 8 outs like an OESD. */
  straightDraw: 'oesd' | 'double-gutshot' | 'gutshot' | null;
  description: string;
  /** Pair, two pair or trips made only by board ranks: we play kickers. */
  boardMade: boolean;
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

  const h = hole.map(rankIndex);
  const highCard = Math.max(...h) >= 11 ? 0.16 : 0.08; // ace/king-high is worth a little more than nothing
  const counts = new Array<number>(13).fill(0);
  for (const c of all) counts[rankIndex(c)]++;
  // The pair/trips ranks that play in the best five; none of ours means we only play kickers.
  const madeRanks = counts.flatMap((n, r) => (n >= 2 ? [r] : [])).reverse().slice(0, category === 6 ? 2 : 1);
  const boardMade = category >= 5 && !madeRanks.some((r) => h.includes(r));
  const categoryBase = category === 8 || boardMade ? highCard : category === 7 ? pairStrength(hole, board) : BASE_BY_CATEGORY[category];
  // A made hand is never worth more than its standing on this board (e.g. quads or a straight played off the board).
  const base = Math.min(categoryBase, handStrengthNow(hole, board));

  // draws only exist while there are cards to come
  const flushDraw = board.length < 5 && category > 3 && hasFlushDraw(hole, board);
  const straightDraw = board.length < 5 && category > 4 ? straightDrawType(hole, board) : null;

  let strength = base;
  if (board.length < 5 && base < 0.6) {
    if (flushDraw) strength += FLUSH_DRAW_BONUS;
    if (straightDraw === 'gutshot') strength += GUTSHOT_BONUS;
    else if (straightDraw) strength += OESD_BONUS;
  }
  return {
    strength: Math.min(0.97, strength),
    madeCategory: category,
    flushDraw,
    straightDraw,
    description: analysis.description,
    boardMade,
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
  const pairedRank = boardRanks.includes(h1) ? h1 : h2;
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

function straightDrawType(hole: [Card, Card], board: Card[]): StrengthInfo['straightDraw'] {
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
  const outRanks = personalOuts.filter(Boolean).length;
  return outRanks >= 2 ? 'double-gutshot' : outRanks === 1 ? 'gutshot' : null;
}

/** Opponent hand values for every two-card holding on a board, overall and per card (for exact hero-card blocker removal). */
interface BoardHoldings { all: number[]; byCard: Map<Card, number[]> }
const BOARD_CACHE = new Map<string, BoardHoldings>();
const BOARD_CACHE_SIZE = 8; // one hand's flop/turn/river plus replays; opponentRanges queries ~1.2k holdings per board

function boardHoldings(board: Card[]): BoardHoldings {
  const key = [...board].sort().join('');
  const cached = BOARD_CACHE.get(key);
  if (cached) return cached;
  const deck = freshDeck().filter((c) => !board.includes(c));
  const byCard = new Map<Card, number[]>(deck.map((c) => [c, []]));
  const all: number[] = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const value = evaluate7([deck[i], deck[j], ...board]);
      all.push(value);
      byCard.get(deck[i])!.push(value);
      byCard.get(deck[j])!.push(value);
    }
  }
  const holdings = { all: all.sort((a, b) => a - b), byCard };
  for (const list of byCard.values()) list.sort((a, b) => a - b);
  if (BOARD_CACHE.size >= BOARD_CACHE_SIZE) BOARD_CACHE.delete(BOARD_CACHE.keys().next().value!);
  BOARD_CACHE.set(key, holdings);
  return holdings;
}

/** Count of sorted values strictly below `value` (phe: lower is better). */
function below(sorted: number[], value: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Standard hand strength: (wins + ties/2) / N against every unseen two-card holding on the current board. */
function handStrengthNow(hole: [Card, Card], board: Card[]): number {
  const { all, byCard } = boardHoldings(board);
  const value = evaluate7([...hole, ...board]);
  const [a, b] = [byCard.get(hole[0])!, byCard.get(hole[1])!];
  // Inclusion-exclusion drops holdings using our cards; our own pair sits in both card lists, so add it back once.
  const better = below(all, value) - below(a, value) - below(b, value);
  const notWorse = below(all, value + 1) - below(a, value + 1) - below(b, value + 1) + 1;
  const n = all.length - a.length - b.length + 1;
  const ties = notWorse - better;
  return (n - notWorse + ties / 2) / n;
}
