import { describe, expect, it } from 'vitest';
import { mulberry32, type Rng } from '../random';
import { AVATARS, BOT_COUNT, BOT_NAMES, JITTER, generateLineup, jitterPersonality } from './lineup';
import { PERSONALITIES, type Personality } from './personalities';

const ARCHETYPES = Object.keys(PERSONALITIES);
const LOW: Rng = () => 0;
const HIGH: Rng = () => 1 - 2 ** -40;
/** Every bound is monotone in one parameter, so the all-low and all-high corners are its exhaustive extremes. */
const corners = (id: string) => [jitterPersonality(PERSONALITIES[id], LOW), jitterPersonality(PERSONALITIES[id], HIGH)];
const lineups = (n: number) => Array.from({ length: n }, (_, seed) => generateLineup(mulberry32(seed)));

describe('lineup generator', () => {
  it('is deterministic per seed and draws five unique neutral seats', () => {
    expect(generateLineup(mulberry32(7))).toEqual(generateLineup(mulberry32(7)));
    expect(BOT_NAMES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(BOT_NAMES).size).toBe(BOT_NAMES.length);
    for (const name of BOT_NAMES) expect(name).toMatch(/^[A-Z][a-z]+$/);
    for (const lineup of lineups(500)) {
      expect(lineup.map((b) => b.id)).toEqual(['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5']);
      expect(new Set(lineup.map((b) => b.name)).size).toBe(BOT_COUNT);
      for (const bot of lineup) expect(BOT_NAMES).toContain(bot.name);
      expect(new Set(lineup.map((b) => b.avatar)).size).toBe(BOT_COUNT);
      for (const bot of lineup) expect(AVATARS).toContain(bot.avatar);
    }
    expect(new Set(AVATARS).size).toBe(AVATARS.length);
    expect(new Set(lineups(500).flat().map((b) => b.avatar))).toEqual(new Set(AVATARS));
  });

  it('draws avatars independently of the archetype', () => {
    const byAvatar = new Map<string, Map<string, number>>();
    for (const bot of lineups(5000).flat()) {
      const row = byAvatar.get(bot.avatar) ?? new Map<string, number>();
      row.set(bot.personality.id, (row.get(bot.personality.id) ?? 0) + 1);
      byAvatar.set(bot.avatar, row);
    }
    // Each avatar appears ~5000 * 5/15 ≈ 1667 times; every archetype keeps ~1/5 share (sd ≈ 0.01).
    for (const row of byAvatar.values()) {
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      for (const id of ARCHETYPES) expect(Math.abs((row.get(id) ?? 0) / total - 0.2)).toBeLessThan(0.05);
    }
  });

  it('never gives a bot the hero name', () => {
    for (let seed = 0; seed < 300; seed++) {
      expect(generateLineup(mulberry32(seed), 'Adam').map((b) => b.name)).not.toContain('Adam');
      expect(generateLineup(mulberry32(seed), ' zoe ').map((b) => b.name)).not.toContain('Zoe');
    }
  });

  it('draws archetypes uniformly with replacement, independent of seat ids and names', () => {
    const all = lineups(5000);
    const counts = new Map(ARCHETYPES.map((id) => [id, 0]));
    const bySeat = new Map<string, Map<string, number>>();
    const byName = new Map<string, Map<string, number>>();
    const tally = (m: Map<string, Map<string, number>>, key: string, type: string) => {
      const row = m.get(key) ?? new Map<string, number>();
      row.set(type, (row.get(type) ?? 0) + 1);
      m.set(key, row);
    };
    for (const lineup of all) for (const bot of lineup) {
      const type = bot.personality.id;
      counts.set(type, counts.get(type)! + 1);
      tally(bySeat, bot.id, type);
      tally(byName, bot.name, type);
    }
    for (const id of ARCHETYPES) expect(counts.get(id)! / (5000 * BOT_COUNT)).toBeCloseTo(0.2, 1.4); // ±0.02, ~8 sd
    // Conditional on a seat id or a name, every archetype still has ~1/5 share.
    for (const rows of [bySeat, byName]) for (const row of rows.values()) {
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      for (const id of ARCHETYPES) expect(Math.abs((row.get(id) ?? 0) / total - 0.2)).toBeLessThan(0.1);
    }
    const repeats = all.map((lineup) => Math.max(...ARCHETYPES.map((id) => lineup.filter((b) => b.personality.id === id).length)));
    expect(repeats.filter((r) => r >= 2).length / all.length).toBeCloseTo(1 - 120 / 3125, 1); // P(all distinct) = 5!/5^5
    expect(repeats.some((r) => r >= 3)).toBe(true);
  });

  it('jitters continuous parameters within ±JITTER, keeps probabilities in [0,1] and the tier table exact', () => {
    const lineup = lineups(300).flat();
    for (const { personality: p } of [...lineup, ...ARCHETYPES.flatMap((id) => corners(id).map((personality) => ({ personality })))]) {
      const base = PERSONALITIES[p.id];
      expect(p.vpipTierByPosition).toEqual(base.vpipTierByPosition);
      for (const key of ['pfrRatio', 'aggressionFactor', 'bluffFrequency', 'callStationFactor', 'foldToAggression', 'showBluffChance'] as const) {
        expect(p[key]).toBeGreaterThanOrEqual(Math.min(base[key] * (1 - JITTER), 1) - 1e-12);
        expect(p[key]).toBeLessThanOrEqual(base[key] * (1 + JITTER) + 1e-12);
        if (key !== 'aggressionFactor') expect(p[key]).toBeLessThanOrEqual(1);
      }
    }
    // Two bots of one archetype are not clones.
    const sharks = lineup.filter((b) => b.personality.id === 'shark').map((b) => b.personality.pfrRatio);
    expect(new Set(sharks).size).toBe(sharks.length);
  });

  it('can never move a bot across decideAction cutoffs or out of its archetype identity (exhaustive corners)', () => {
    for (const id of ARCHETYPES) for (const p of corners(id)) {
      const base = PERSONALITIES[id];
      expect(p.callStationFactor > 0.3).toBe(base.callStationFactor > 0.3);
      expect(p.foldToAggression > 0.6).toBe(base.foldToAggression > 0.6);
    }
    const range = (id: string, key: keyof Personality) => corners(id).map((p) => p[key] as number);
    const others = (id: string) => ARCHETYPES.filter((o) => o !== id);
    const maxOf = (ids: string[], key: keyof Personality) => Math.max(...ids.flatMap((o) => range(o, key)));
    const minOf = (ids: string[], key: keyof Personality) => Math.min(...ids.flatMap((o) => range(o, key)));
    // The defining traits stay strictly separated from every other archetype's jitter band.
    expect(Math.min(...range('maniac', 'aggressionFactor'))).toBeGreaterThan(maxOf(others('maniac'), 'aggressionFactor'));
    expect(Math.min(...range('maniac', 'bluffFrequency'))).toBeGreaterThan(maxOf(others('maniac'), 'bluffFrequency'));
    expect(Math.min(...range('fish', 'callStationFactor'))).toBeGreaterThan(maxOf(others('fish'), 'callStationFactor'));
    expect(Math.max(...range('fish', 'pfrRatio'))).toBeLessThan(minOf(others('fish'), 'pfrRatio'));
    expect(Math.max(...range('shark', 'foldToAggression'))).toBeLessThan(Math.min(...range('rock', 'foldToAggression'), ...range('nit', 'foldToAggression')));
    expect(Math.min(...range('shark', 'pfrRatio'))).toBeGreaterThan(Math.max(...range('rock', 'pfrRatio'), ...range('nit', 'pfrRatio'), ...range('fish', 'pfrRatio')));
  });
});
