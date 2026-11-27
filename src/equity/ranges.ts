import { RANKS, SUITS, validateCards, type Card } from '../cards/deck';

/** Uniform concrete combos; overlapping notation never increases a combo's weight. */
export function parseRange(range: string, blockers: Card[] = []): [Card, Card][] {
  validateCards(blockers);
  if (typeof range !== 'string' || !range.trim()) throw new Error('Empty range');
  if (/,,|,\s*,|^,|,$/.test(range.trim())) throw new Error('Empty range token');
  const blocked = new Set(blockers);
  const combos = new Map<string, [Card, Card]>();
  const add = (a: Card, b: Card) => {
    validateCards([a, b]);
    if (blocked.has(a) || blocked.has(b)) return;
    const hand: [Card, Card] = a < b ? [a, b] : [b, a];
    combos.set(hand.join(''), hand);
  };
  const expand = (hi: number, lo: number, suit: string) => {
    for (const a of SUITS) for (const b of SUITS) {
      if (hi === lo && a >= b) continue;
      if (suit === 's' && a !== b || suit === 'o' && a === b) continue;
      add(RANKS[hi] + a, RANKS[lo] + b);
    }
  };
  const klass = (token: string) => {
    const match = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/.exec(token);
    if (!match) throw new Error(`Invalid range token: ${token}`);
    const hi = RANKS.indexOf(match[1]), lo = RANKS.indexOf(match[2]);
    if (hi < lo || hi === lo && match[3]) throw new Error(`Invalid range class: ${token}`);
    return { hi, lo, suit: match[3] };
  };
  for (const token of range.trim().split(/[\s,]+/)) {
    if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/.test(token)) {
      add(token.slice(0, 2), token.slice(2));
    } else if (token.includes('-')) {
      const parts = token.split('-');
      if (parts.length !== 2) throw new Error('Invalid range interval');
      const a = klass(parts[0]), b = klass(parts[1]);
      if (a.suit !== b.suit) throw new Error('Mixed interval suits');
      if (a.hi === a.lo && b.hi === b.lo) {
        for (let r = Math.min(a.hi, b.hi); r <= Math.max(a.hi, b.hi); r++) expand(r, r, '');
      } else if (a.hi === b.hi && a.lo < a.hi && b.lo < b.hi) {
        for (let r = Math.min(a.lo, b.lo); r <= Math.max(a.lo, b.lo); r++) expand(a.hi, r, a.suit);
      } else throw new Error('Unsupported range interval');
    } else {
      const plus = token.endsWith('+');
      const { hi, lo, suit } = klass(plus ? token.slice(0, -1) : token);
      if (!plus) expand(hi, lo, suit);
      else if (hi === lo) for (let r = hi; r < RANKS.length; r++) expand(r, r, '');
      else for (let r = lo; r < hi; r++) expand(hi, r, suit);
    }
  }
  if (!combos.size) throw new Error('Range has no unblocked combos');
  return [...combos.values()];
}

export interface WeightedCombo { cards: [Card, Card]; weight: number }
export type OpponentRange = string | WeightedCombo[];

/** Explicit combo weights; duplicate unordered hands are rejected rather than silently changing their likelihood. */
export function concreteRange(range: OpponentRange, blockers: Card[]): WeightedCombo[] {
  if (typeof range === 'string') return parseRange(range, blockers).map(cards => ({ cards, weight: 1 }));
  validateCards(blockers);
  if (!Array.isArray(range)) throw new Error('Invalid weighted range');
  const seen = new Set<string>();
  const result: WeightedCombo[] = [];
  for (const combo of range) {
    if (!combo || !Array.isArray(combo.cards) || combo.cards.length !== 2) throw new Error('Combo needs two cards');
    validateCards(combo.cards);
    if (!Number.isFinite(combo.weight) || combo.weight < 0) throw new Error('Combo weight must be finite and nonnegative');
    const [a, b] = combo.cards;
    const cards: [Card, Card] = a < b ? [a,b] : [b,a];
    const key = cards.join('');
    if (seen.has(key)) throw new Error('Duplicate weighted combo');
    seen.add(key);
    if (combo.weight > 0 && !cards.some(c => blockers.includes(c))) result.push({ cards, weight: combo.weight });
  }
  if (!result.length) throw new Error('Range has no positive unblocked combos');
  return result;
}
