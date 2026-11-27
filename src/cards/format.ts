import type { Card } from './deck';

const SUIT_SYMBOL: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function suitSymbol(card: Card): string {
  return SUIT_SYMBOL[card[1]];
}

export function rankLabel(card: Card): string {
  return card[0] === 'T' ? '10' : card[0];
}

/** Human card text for logs and messages, e.g. "10♠ A♥". */
export function formatCards(cards: Card[]): string {
  return cards.map((card) => rankLabel(card) + suitSymbol(card)).join(' ');
}
