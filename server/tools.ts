import { tool } from 'ai';
import { z } from 'zod';
import type { Card } from '../src/engine/types';
import { monteCarloEquity } from '../src/equity/monteCarlo';
import { parseRange } from '../src/equity/ranges';
import { hashSeed } from '../src/engine/rng';
import { drawCompletionOuts, potOdds, terminalCallEV } from '../src/math/pokerMath';
import { bubbleFactor, icmEquities } from '../src/math/icm';
import type { RequestGate } from '../src/agent/training';

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Math helpers throw on bad input; the model gets `{ error }` and can retry instead of breaking the stream. */
function safe<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const card = z.string().regex(/^[2-9TJQKA][cdhs]$/).describe('Card like "Ah", "Td", "2c": rank 2-9TJQKA + suit cdhs');
const hand = z.array(card).length(2).describe('Exactly two hole cards, e.g. ["Ah","Kd"]');
const board = z.array(card).max(5).describe('Board cards; [] preflop');

export const tools = {
  equity: tool({
    description: 'Monte Carlo showdown equity (runs the board out to the river, no further betting) of the hero hand against 1-5 opponents. Each opponent is a range ("TT+, AQs+, AKo", "22-66", "A2s-A5s"), an exact hand ("AsKh"), or "random". Deterministic for the same input.',
    inputSchema: z.object({
      hero: hand,
      board: board.describe('Board cards: 0, 3, 4 or 5 of them'),
      opponents: z.array(z.string().min(1).max(500)).min(1).max(5).describe('One entry per opponent: a range string, an exact hand like "AsKh", or "random"'),
      iterations: z.number().int().min(1000).max(100_000).optional().describe('Samples, default 20000'),
    }),
    execute: (input) => safe(() => {
      const hero = input.hero as [Card, Card];
      const ranges = input.opponents.filter((o) => o.trim().toLowerCase() !== 'random');
      const iterations = input.iterations ?? 20_000;
      const sim = { hero, board: input.board, iterations, opponents: input.opponents.length - ranges.length, opponentRanges: ranges };
      // Seeded by exactly what is simulated, so the same question always gets the same number.
      const result = monteCarloEquity({ ...sim, seed: hashSeed(JSON.stringify(sim)) });
      return {
        equity: r4(result.equity), win: r4(result.win), tie: r4(result.tie), iterations,
        // Per-sample pot share lies in [0, 1], so its variance is at most equity * (1 - equity).
        standardErrorBound: r4(Math.sqrt(result.equity * (1 - result.equity) / iterations)),
        rangeCombos: ranges.map((range) => ({ range, combos: parseRange(range, [...hero, ...input.board]).length })),
      };
    }),
  }),

  range_combos: tool({
    description: 'Counts the concrete combos of a hand range, with and without card removal by the given blockers (hero cards and board).',
    inputSchema: z.object({
      range: z.string().min(1).max(500).describe('Range like "TT+, AQs+, AKo" or an exact hand "AsKh"'),
      blockers: z.array(card).max(7).describe('Known cards that remove combos: hero hole cards and the board'),
    }),
    execute: ({ range, blockers }) => safe(() => ({
      combos: parseRange(range, blockers).length,
      combosWithoutBlockers: parseRange(range).length,
    })),
  }),

  pot_odds: tool({
    description: 'Pot odds of a call: required equity = call / (pot + call). With heroEquity also the terminal call EV in chips versus folding, assuming no further betting (all-in or river call).',
    inputSchema: z.object({
      potBeforeCall: z.number().int().nonnegative().describe("Chips in the pot before the hero calls, INCLUDING the villain's bet and all blinds/antes. If the call is all-in for less, subtract the villain's uncalled excess (villain streetBet - (hero streetBet + toCall)) from the pot."),
      toCall: z.number().int().nonnegative().describe('Chips the hero must add to call'),
      heroEquity: z.number().min(0).max(1).optional().describe('Hero showdown pot share 0..1, e.g. from the equity tool'),
    }),
    execute: ({ potBeforeCall, toCall, heroEquity }) => safe(() => ({
      requiredEquity: r4(potOdds(potBeforeCall, toCall)),
      oddsRatio: toCall === 0 ? null : `${r4(potBeforeCall / toCall)}:1`,
      finalPot: potBeforeCall + toCall,
      ...(heroEquity === undefined ? {} : {
        callEV: r4(terminalCallEV(potBeforeCall, toCall, heroEquity)),
        assumption: 'Terminal EV: no further betting, rake or side pots',
      }),
    })),
  }),

  outs: tool({
    description: "Hero's flush and straight completion cards on the flop or turn, with exact hit probabilities over uniformly unseen cards. These are completion cards, not guaranteed winning outs: an opponent may still hold a better hand. Completion cards are 0 when the flush or straight is already made (that is not drawing dead).",
    inputSchema: z.object({
      hero: hand,
      board: z.array(card).min(3).max(4).describe('Flop (3 cards) or turn (4 cards)'),
    }),
    execute: (input) => safe(() => {
      const outs = drawCompletionOuts({ hero: input.hero as [Card, Card], board: input.board });
      const n = outs.union.length, unseen = outs.unseenCards;
      return {
        flushCards: outs.flush, straightCards: outs.straight, completionCards: outs.union.length,
        unseenCards: unseen,
        nextCardProbability: r4(outs.nextCardProbability),
        // Exact two-card miss probability, not the "rule of 4".
        byRiverProbability: input.board.length === 3 ? r4(1 - ((unseen - n) * (unseen - n - 1)) / (unseen * (unseen - 1))) : null,
      };
    }),
  }),

  icm: tool({
    description: 'Exact ICM prize equity of each player from chip stacks and payout shares. Optionally (hero, opponent and risk together) the bubble factor of the hero against one opponent for a symmetric risk of `risk` chips with no dead money: how much more losing hurts than winning helps.',
    inputSchema: z.object({
      stacks: z.array(z.number().int().nonnegative()).min(1).max(6).describe('Chip stacks of the players still in the tournament; a busted player is 0 (at most one)'),
      payouts: z.array(z.number().min(0).max(1)).min(1).max(6).describe('Prize shares by finishing place, nonincreasing, e.g. [0.65, 0.35]'),
      hero: z.number().int().min(0).max(5).optional().describe('Index of the hero in stacks (for bubble factor)'),
      opponent: z.number().int().min(0).max(5).optional().describe('Index of the opponent in stacks (for bubble factor)'),
      risk: z.number().int().positive().optional().describe('Chips at risk, covered by both stacks (for bubble factor)'),
    }),
    execute: ({ stacks, payouts, hero, opponent, risk }) => safe(() => {
      const equities = icmEquities(stacks, payouts).map(r4);
      const given = [hero, opponent, risk].filter((v) => v !== undefined).length;
      if (given === 0) return { equities };
      if (given < 3) throw new Error('Bubble factor needs hero, opponent and risk together');
      const bf = bubbleFactor(stacks, payouts, hero!, opponent!, risk!);
      return { equities, bubbleFactor: bf.factor === null ? null : r4(bf.factor), status: bf.status };
    }),
  }),
};

/** Built per request with the gate closed over: the model passes no id, so it can only unlock the gate this request is about. */
export const releaseActions = (gate: RequestGate) => tool({
  description: gate.kind === 'decision'
    ? 'Unlocks the table for the current hero decision: ALL legal actions become available, not a particular one. Takes no arguments. Call once, when the discussion of this decision is done.'
    : 'Unlocks the "Deal next hand" button after the hand review. Takes no arguments. Call once, when the review is done.',
  inputSchema: z.object({}),
  execute: () => ({ released: gate.id, kind: gate.kind }),
});

/** Every tool Dan may have; the client types its tool parts with this. */
export type DanTools = typeof tools & { release_actions: ReturnType<typeof releaseActions> };
