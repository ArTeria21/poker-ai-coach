import { describe, expect, it } from 'vitest';
import type { Card } from '../cards/deck';
import { bluffRevealCheck } from './bluffReveal';
import { PERSONALITIES } from '../bots/personalities';

const always: () => number = () => 0; // rng that always passes the chance roll
const never: () => number = () => 0.999;

describe('bluffRevealCheck', () => {
  it('the Maniac shows a postflop bluff when the roll hits', () => {
    const desc = bluffRevealCheck(PERSONALITIES.maniac, ['7h', '2c'], ['Ks', '8d', '3c'], always);
    expect(desc).toEqual({ description: 'King high', semiBluff: false });
  });

  it('shows junk preflop steals by hand label', () => {
    const desc = bluffRevealCheck(PERSONALITIES.maniac, ['9h', '3c'], [], always);
    expect(desc).toEqual({ description: '93o', semiBluff: false });
  });

  it('never reveals a real hand — that would be free information', () => {
    const desc = bluffRevealCheck(PERSONALITIES.maniac, ['As', 'Ah'], ['Ad', '8d', '3c'], always);
    expect(desc).toBeNull();
  });

  it('labels a live flush draw before the river as a semi-bluff', () => {
    const desc = bluffRevealCheck(PERSONALITIES.maniac, ['Qh', 'Jh'], ['Kh', '7h', '2c'], always);
    expect(desc).toEqual({ description: 'King high', semiBluff: true });
  });

  it.each<[[Card, Card], Card[], string]>([
    [['3c', '4d'], ['As', 'Ad', 'Ah', 'Ac', '2d'], '43o (playing the board)'],
    [['3c', '4d'], ['2h', '5h', '8h', 'Jh', 'Kh'], '43o (playing the board)'],
    [['3c', '4d'], ['7c', '7h', '7d', 'Ks'], '43o (playing the board)'],
    [['2c', '2d'], ['5c', '5h', '4h', '4s'], '22 (playing the board)'],
  ])('describes the hole cards %j, not a hand the board made', (hole, board, description) => {
    expect(bluffRevealCheck(PERSONALITIES.maniac, hole, board, always)?.description).toBe(description);
  });

  it('respects the personality chance roll', () => {
    const desc = bluffRevealCheck(PERSONALITIES.maniac, ['7h', '2c'], ['Ks', '8d', '3c'], never);
    expect(desc).toBeNull();
  });

  it('personality ordering: the Maniac shows off far more than the Nit', () => {
    expect(PERSONALITIES.maniac.showBluffChance).toBeGreaterThan(PERSONALITIES.nit.showBluffChance * 10);
  });
});
