import { randInt, shuffleInPlace, type Rng } from '../engine/rng';
import { PERSONALITIES, type Personality } from './personalities';

export const BOT_COUNT = 5;

/** Neutral first names: none hints at a playing style. */
export const BOT_NAMES = [
  'Adam', 'Bella', 'Carlos', 'Dina', 'Emil', 'Freya', 'Gabriel', 'Hana', 'Ivan', 'Julia',
  'Kofi', 'Lena', 'Mateo', 'Nadia', 'Oscar', 'Priya', 'Ravi', 'Sofia', 'Tomas', 'Uma',
  'Viktor', 'Wen', 'Yara', 'Zoltan', 'Amir', 'Clara', 'Diego', 'Elif', 'Hugo', 'Ingrid',
  'Jonas', 'Leila', 'Marek', 'Noor', 'Pablo', 'Rhea', 'Stefan', 'Tess', 'Yusuf', 'Zoe',
] as const;

/** Decorative seat figurines: public, cosmetic, and drawn independently of name and archetype. */
export const AVATARS = [
  'shield', 'sword', 'moon', 'anchor', 'owl', 'fox', 'cat', 'rocket',
  'cactus', 'mushroom', 'key', 'compass', 'shark', 'octopus', 'feather',
] as const;
export type Avatar = (typeof AVATARS)[number];

/**
 * Multiplicative jitter amplitude for continuous parameters. Integer
 * vpipTierByPosition stays exact: one tier step moves VPIP far more than ±12%.
 * Identity-safe against decideAction's cutoffs (callStationFactor > 0.3,
 * foldToAggression > 0.6) for every archetype; lineup.test.ts proves the bounds.
 */
export const JITTER = 0.12;
const JITTERED = ['pfrRatio', 'aggressionFactor', 'bluffFrequency', 'callStationFactor', 'foldToAggression', 'showBluffChance'] as const;

export interface BotSeat {
  id: string;
  name: string;
  avatar: Avatar;
  /** Private: only TableController may hold this. */
  personality: Personality;
}

export function jitterPersonality(base: Personality, rng: Rng): Personality {
  const out: Personality = { ...base, vpipTierByPosition: { ...base.vpipTierByPosition } };
  for (const key of JITTERED) {
    const value = base[key] * (1 + JITTER * (2 * rng() - 1));
    out[key] = key === 'aggressionFactor' ? value : Math.min(1, value); // the rest are probabilities
  }
  return out;
}

/** Five unique neutral names, ids bot-1..bot-5, independently drawn (with replacement) jittered archetypes, and five unique avatars. */
export function generateLineup(rng: Rng, heroName = 'You'): BotSeat[] {
  const hero = heroName.trim().toLowerCase();
  const names = shuffleInPlace(BOT_NAMES.filter((n) => n.toLowerCase() !== hero), rng).slice(0, BOT_COUNT);
  const archetypes = Object.values(PERSONALITIES);
  const personalities = names.map(() => jitterPersonality(archetypes[randInt(rng, archetypes.length)], rng));
  // Drawn last so adding avatars left every seeded name and archetype draw unchanged.
  const avatars = shuffleInPlace([...AVATARS], rng).slice(0, BOT_COUNT);
  return names.map((name, i) => ({ id: `bot-${i + 1}`, name, avatar: avatars[i], personality: personalities[i] }));
}
