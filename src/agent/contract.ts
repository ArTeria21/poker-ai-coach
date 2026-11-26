import { z } from 'zod';
import type { DecisionGrade } from '../analysis/gradeHand';

/** shortcut: plain sliding window of chat messages sent to the model, older turns are dropped; upgrade to compaction when sessions get long. */
export const WINDOW_MESSAGES = 20;

/**
 * Public table snapshot handed to the coach LLM. Chip amounts are integers;
 * `...BB` fields are the same amount in big blinds of the current hand.
 * Never contains unrevealed bot cards, the deck, or seeds.
 */
const chips = z.number().int().nonnegative();
const bigBlinds = z.number().nonnegative();
const card = z.string().regex(/^[2-9TJQKA][cdhs]$/);
const cards = z.tuple([card, card]);
const name = z.string().min(1).max(40);
const position = z.enum(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
const blinds = z.object({ smallBlind: chips, bigBlind: chips, bigBlindAnte: chips });

export const coachSnapshotSchema = z.object({
  status: z.enum(['heroToAct', 'botsActing', 'handComplete', 'tournamentComplete']),
  awaitingNextHand: z.boolean(),
  /** Public engine hand id (`<tournamentId>-hand-N`); keys the training gates. */
  handId: z.string().min(1).max(100),
  handNumber: z.number().int().positive(),
  street: z.enum(['preflop', 'flop', 'turn', 'river', 'complete']),
  tournament: blinds.extend({
    level: z.number().int().positive(),
    handsPlayedAtLevel: z.number().int().nonnegative(),
    handsPerLevel: z.number().int().positive(),
    nextLevel: blinds.nullable(),
    playersRemaining: z.number().int().min(1).max(6),
    payoutSharesByPlace: z.array(z.number().min(0).max(1)).max(6),
  }),
  players: z.array(z.object({
    seat: z.number().int().min(0).max(5),
    name,
    isHero: z.boolean(),
    botProfile: z.string().max(200).nullable(),
    position: position.nullable(),
    stack: chips,
    stackBB: bigBlinds,
    streetBet: chips,
    committedThisHand: chips,
    folded: z.boolean(),
    allIn: z.boolean(),
    isActing: z.boolean(),
    eliminated: z.boolean(),
    finishPlace: z.number().int().min(1).max(6).nullable(),
    shownCards: cards.nullable(),
    showdownDescription: z.string().max(200).nullable(),
    wonThisHand: chips.nullable(),
  })).min(2).max(6),
  hero: z.object({
    name,
    cards: cards.nullable(),
    position: position.nullable(),
    stack: chips,
    stackBB: bigBlinds,
    /** Chips the hero can still commit that the deepest live opponent covers. */
    effectiveStack: chips.nullable(),
    effectiveStackBB: bigBlinds.nullable(),
    /** SPR at the start of the current street: hero's cover vs the deepest opponent still in the hand, over the pot then; null preflop. Can change mid-street if that opponent folds. */
    sprAtStreetStart: z.number().nonnegative().nullable(),
    toCall: chips.nullable(),
    eliminated: z.boolean(),
    finishPlace: z.number().int().min(1).max(6).nullable(),
  }),
  board: z.array(card).max(5),
  pot: chips,
  potBB: bigBlinds,
  currentBet: chips,
  /** Hero's options when it is the hero's turn; raise amounts are street totals ("raise to"). */
  legalActions: z.object({
    fold: z.boolean(),
    check: z.boolean(),
    call: z.object({ amount: chips, allIn: z.boolean() }).optional(),
    raise: z.object({ minTo: chips, maxTo: chips }).optional(),
  }).nullable(),
  forcedBets: z.array(z.object({
    player: name,
    kind: z.enum(['small blind', 'big blind', 'big blind ante']),
    amount: chips,
  })).max(3),
  history: z.array(z.object({
    street: z.enum(['preflop', 'flop', 'turn', 'river']),
    player: name,
    position,
    action: z.enum(['fold', 'check', 'call', 'bet', 'raise']),
    amountAdded: chips,
    /** Street total after a bet or raise; null otherwise. */
    raiseTo: chips.nullable(),
    potBefore: chips,
    toCallBefore: chips,
    stackBefore: chips,
    allIn: z.boolean(),
  })).max(200),
  /** Grader verdict on the hero's latest action, without outs lists or SPR. */
  lastDecisionGrade: z.custom<Omit<DecisionGrade, 'facts'> & { facts: Omit<DecisionGrade['facts'], 'draws' | 'spr'> }>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)).nullable(),
});

export type CoachSnapshot = z.infer<typeof coachSnapshotSchema>;
