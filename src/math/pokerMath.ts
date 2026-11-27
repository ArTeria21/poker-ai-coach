import { freshDeck, rankIndex, suitIndex, validateCards, type Card } from '../cards/deck';
import { bestStraightHigh, handCategory, evaluate7 } from '../cards/handEval';

export function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
}
export function chipAmount(value: number, name: string): void {
  nonnegative(value, name);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer chip amount`);
}
function probability(value: number): void {
  nonnegative(value, 'Probability');
  if (value > 1) throw new Error('Probability must be at most 1');
}

/** Pot includes the opponent's bet, excludes the hero's prospective call. Free check costs zero. */
export function potOdds(potBeforeCall: number, call: number): number {
  chipAmount(potBeforeCall, 'Pot'); chipAmount(call, 'Call');
  chipAmount(potBeforeCall + call, 'Final pot');
  return call === 0 ? 0 : call / (potBeforeCall + call);
}

export interface StreetStack { behind: number; streetBet: number }
/** Pairwise current-street cover, including each player's already committed street bet. */
export function effectiveStack(hero: StreetStack, opponent: StreetStack) {
  for (const player of [hero, opponent]) {
    chipAmount(player.behind, 'Stack'); chipAmount(player.streetBet, 'Street bet');
    chipAmount(player.behind + player.streetBet, 'Street total');
  }
  const totalStreetCover = Math.min(hero.behind + hero.streetBet, opponent.behind + opponent.streetBet);
  return {
    totalStreetCover,
    heroAdditionalCover: Math.max(0, totalStreetCover - hero.streetBet),
    opponentAdditionalCover: Math.max(0, totalStreetCover - opponent.streetBet),
  };
}

/** SPR uses effective chips behind; a zero pot has no defined ratio. */
export function spr(effectiveBehind: number, pot: number): { status: 'finite' | 'undefined'; value: number | null } {
  chipAmount(effectiveBehind, 'Stack'); chipAmount(pot, 'Pot');
  return pot === 0 ? { status: 'undefined', value: null } : { status: 'finite', value: effectiveBehind / pot };
}

/** Terminal pot-share EV versus folding; no future bets, rake or side pots. */
export function terminalCallEV(potBeforeCall: number, call: number, showdownPotShare: number): number {
  potOdds(potBeforeCall, call); probability(showdownPotShare);
  return showdownPotShare * (potBeforeCall + call) - call;
}

/** Heads-up terminal raise model: additional matched exposure only, excluding uncalled excess/refunds; no future bets, rake or side pots. */
export function headsUpRaiseEV(opts: { pot: number; heroCost: number; opponentCall: number; foldProbability: number; equityWhenCalled: number }): number {
  const { pot, heroCost, opponentCall, foldProbability, equityWhenCalled } = opts;
  chipAmount(pot, 'Pot'); chipAmount(heroCost, 'Hero cost'); chipAmount(opponentCall, 'Opponent call');
  chipAmount(pot + heroCost + opponentCall, 'Final pot');
  probability(foldProbability); probability(equityWhenCalled);
  return foldProbability * pot + (1 - foldProbability) * (equityWhenCalled * (pot + heroCost + opponentCall) - heroCost);
}

const straightHigh = (cards: Card[]) => bestStraightHigh(Array.from({ length: 13 }, (_, r) => cards.some(c => rankIndex(c) === r)));

/** Structural completion cards are not clean winning outs or showdown equity. */
export function drawCompletionOuts(opts: { hero: [Card, Card]; board: Card[]; knownOpponents?: [Card, Card][] }) {
  const { hero, board, knownOpponents = [] } = opts;
  if (hero.length !== 2 || knownOpponents.some(h => h.length !== 2) || knownOpponents.length > 5) throw new Error('Invalid hands');
  if (![3, 4, 5].includes(board.length)) throw new Error('Board needs 3, 4 or 5 cards');
  const known = [...hero, ...board, ...knownOpponents.flat()];
  validateCards(known);
  const pool = freshDeck().filter(c => !known.includes(c));
  const all = [...hero, ...board];
  const flush: Card[] = [], straight: Card[] = [], categoryImprovement: Card[] = [];
  const winning: Card[] = [], tying: Card[] = [];
  const currentCategory = handCategory(all);
  const currentStraight = straightHigh(all);
  for (const card of board.length < 5 ? pool : []) {
    const next = [...all, card], nextBoard = [...board, card];
    const suit = suitIndex(card);
    if (all.filter(c => suitIndex(c) === suit).length === 4 && hero.some(c => suitIndex(c) === suit)) flush.push(card);
    if (currentStraight < 0 && straightHigh(next) > straightHigh(nextBoard)) straight.push(card);
    if (handCategory(next) < currentCategory) categoryImprovement.push(card);
    if (knownOpponents.length) {
      const value = evaluate7(next);
      const opponents = knownOpponents.map(h => evaluate7([...h, ...nextBoard]));
      const best = Math.min(...opponents);
      if (value < best) winning.push(card);
      else if (value === best) tying.push(card);
    }
  }
  const union = [...new Set([...flush, ...straight])];
  return {
    flush, straight, union, categoryImprovement,
    unseenCards: pool.length,
    nextCardProbability: union.length / pool.length,
    /** Current leaders after one card, including turn comparisons on the flop; never terminal equity. */
    nextCardLeaders: knownOpponents.length ? { winning, tying } : null,
  };
}
