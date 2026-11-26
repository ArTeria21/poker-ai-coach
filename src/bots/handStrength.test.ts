import { describe, expect, it } from 'vitest';
import type { Card } from '../engine/types';
import { postflopStrength } from './handStrength';

describe('straight draw ace boundaries', () => {
  it.each<{ name: string; hole: [Card, Card]; board: Card[] }>([
    { name: 'AKQJ', hole: ['Ah', 'Ks'], board: ['Qc', 'Jd', '4s'] },
    { name: 'A234', hole: ['Ah', '2s'], board: ['3c', '4d', '9s'] },
  ])('recognizes $name as a four-out gutshot', ({ hole, board }) => {
    expect(postflopStrength(hole, board).straightDraw).toBe('gutshot');
  });

  it.each<{ name: string; hole: [Card, Card]; board: Card[] }>([
    { name: '2345', hole: ['2h', '3s'], board: ['4c', '5d', '9s'] },
    { name: 'TJQK', hole: ['Qh', 'Ks'], board: ['Jc', 'Td', '4s'] },
  ])('keeps $name open-ended', ({ hole, board }) => {
    expect(postflopStrength(hole, board).straightDraw).toBe('oesd');
  });

  it('does not count repeated ranks as another straight rank', () => {
    expect(postflopStrength(['Ah', 'Ks'], ['Qc', 'Qd', '4s']).straightDraw).toBeNull();
  });

  it('does not report a draw for a made straight', () => {
    const info = postflopStrength(['Ah', 'Ks'], ['Qc', 'Jd', 'Ts']);
    expect(info.madeCategory).toBe(4);
    expect(info.straightDraw).toBeNull();
  });

  it('does not report a draw on the river', () => {
    expect(postflopStrength(['2h', '3s'], ['4c', '5d', '9s', 'Kh', 'Qd']).straightDraw).toBeNull();
  });
});

describe('draws require a personal hole-card contribution', () => {
  it('rejects a flush draw made entirely from the board', () => {
    const info = postflopStrength(['Ah', 'Ad'], ['Ks', 'Qs', '8s', '2s']);
    expect(info.flushDraw).toBe(false);
    expect(info.strength).toBe(0.5); // overpair, without a phantom draw bonus
  });

  it.each<{ hole: [Card, Card]; board: Card[] }>([
    { hole: ['As', 'Ad'], board: ['Ks', 'Qs', '8s'] },
    { hole: ['As', 'Js'], board: ['Ks', 'Qs', '8d'] },
  ])('keeps a real flush draw with hole $hole', ({ hole, board }) => {
    expect(postflopStrength(hole, board).flushDraw).toBe(true);
  });

  it('rejects a straight draw made entirely from the board', () => {
    expect(postflopStrength(['Ah', 'Kd'], ['5s', '6c', '7h', '8d']).straightDraw).toBeNull();
  });

  it.each<{ hole: [Card, Card]; board: Card[] }>([
    { hole: ['5h', 'Kd'], board: ['5s', '6c', '7h', '8d'] },
    { hole: ['2h', '2d'], board: ['2s', '3c', '4h', '5d'] },
  ])('does not count duplicated board ranks in hole $hole as a personal draw', ({ hole, board }) => {
    expect(postflopStrength(hole, board).straightDraw).toBeNull();
  });

  it('finds a personal gutshot even when the board has an open-ended draw', () => {
    expect(postflopStrength(['Th', 'Kd'], ['5s', '6c', '7h', '8d']).straightDraw).toBe('gutshot');
  });

  it.each<{ hole: [Card, Card]; board: Card[] }>([
    { hole: ['Ah', 'Kd'], board: ['3s', '4c', '5h', '6d'] },
    { hole: ['3h', 'Kd'], board: ['5s', '6c', '7h', '8d'] },
    { hole: ['2h', 'As'], board: ['2c', '3d', '4c', '6d'] },
  ])('rejects a lower personal straight when the same out makes a higher board straight', ({ hole, board }) => {
    expect(postflopStrength(hole, board).straightDraw).toBeNull();
  });

  it.each<{ hole: [Card, Card]; board: Card[] }>([
    { hole: ['3h', 'Kd'], board: ['4s', '5c', '6h', '8d'] },
    { hole: ['2h', 'Ks'], board: ['3c', '4d', '5c', '7d'] },
  ])('reports a gutshot when only one open end makes a personal straight', ({ hole, board }) => {
    const info = postflopStrength(hole, board);
    expect(info.madeCategory).toBe(8); // K-high; no completed straight yet
    expect(info.straightDraw).toBe('gutshot');
  });

  it('reports no draws for a made flush or on the river', () => {
    const madeFlush = postflopStrength(['As', 'Js'], ['Ks', 'Qs', '8s']);
    expect(madeFlush.madeCategory).toBe(3);
    expect(madeFlush.flushDraw).toBe(false);
    expect(madeFlush.straightDraw).toBeNull();
    const river = postflopStrength(['As', 'Js'], ['Ks', 'Qs', '8d', '3c', '2h']);
    expect(river.flushDraw).toBe(false);
    expect(river.straightDraw).toBeNull();
  });
});
