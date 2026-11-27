import type { Position } from '../engine/types';

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * All bot behavior is data. Tuning a personality = editing numbers here;
 * the Phase 2 statistical playtest asserts measured VPIP/PFR match intent.
 */
export interface Personality {
  /** Private archetype id; never published. */
  id: string;
  /** Plays hands of tier <= this, per position. */
  vpipTierByPosition: Record<Position, number>;
  /** Of the hands they play, fraction opened with a raise vs limped/called. */
  pfrRatio: number;
  /** Postflop bet/raise appetite multiplier (1 = balanced). */
  aggressionFactor: number;
  /** Chance to fire with air in bluffable spots. */
  bluffFrequency: number;
  /** 0..1 — tolerance for calling at bad pot odds (the Fish's defining flaw). */
  callStationFactor: number;
  /** 0..1 — how much facing a raise scares them off marginal hands. */
  foldToAggression: number;
  /** Chance to flip over a successful bluff after winning without showdown. */
  showBluffChance: number;
}

export const PERSONALITIES: Record<string, Personality> = {
  shark: {
    id: 'shark',
    vpipTierByPosition: { UTG: 3, HJ: 4, CO: 5, BTN: 6, SB: 5, BB: 6 },
    pfrRatio: 0.75,
    aggressionFactor: 1.2,
    bluffFrequency: 0.15,
    callStationFactor: 0.05,
    foldToAggression: 0.5,
    showBluffChance: 0.12,
  },
  rock: {
    id: 'rock',
    vpipTierByPosition: { UTG: 2, HJ: 2, CO: 3, BTN: 3, SB: 3, BB: 4 },
    pfrRatio: 0.4,
    aggressionFactor: 0.7,
    bluffFrequency: 0.02,
    callStationFactor: 0,
    foldToAggression: 0.8,
    showBluffChance: 0.03,
  },
  maniac: {
    id: 'maniac',
    vpipTierByPosition: { UTG: 6, HJ: 6, CO: 7, BTN: 8, SB: 7, BB: 8 },
    pfrRatio: 0.9,
    aggressionFactor: 2.2,
    bluffFrequency: 0.35,
    callStationFactor: 0.15,
    foldToAggression: 0.15,
    showBluffChance: 0.55,
  },
  fish: {
    id: 'fish',
    vpipTierByPosition: { UTG: 6, HJ: 6, CO: 7, BTN: 7, SB: 7, BB: 8 },
    pfrRatio: 0.15,
    aggressionFactor: 0.5,
    bluffFrequency: 0.05,
    callStationFactor: 0.6,
    foldToAggression: 0.3,
    showBluffChance: 0.1,
  },
  nit: {
    id: 'nit',
    vpipTierByPosition: { UTG: 2, HJ: 2, CO: 2, BTN: 3, SB: 2, BB: 3 },
    pfrRatio: 0.55,
    aggressionFactor: 0.8,
    bluffFrequency: 0.01,
    callStationFactor: 0,
    foldToAggression: 0.9,
    showBluffChance: 0.02,
  },
};

/** Gaussian-ish noise amplitude applied to bot hand-strength reads. */
export const DIFFICULTY_NOISE: Record<Difficulty, number> = {
  easy: 0.15,
  medium: 0.07,
  hard: 0.03,
};
