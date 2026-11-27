import { tool } from 'ai';
import { z } from 'zod';
import type { Card } from '../src/engine/types';
import { monteCarloEquity } from '../src/equity/monteCarlo';
import { parseRange } from '../src/equity/ranges';
import { hashSeed } from '../src/engine/rng';
import { drawCompletionOuts, headsUpRaiseEV, potOdds, terminalCallEV } from '../src/math/pokerMath';
import { bubbleFactor, icmEquities, icmOutcomeEV } from '../src/math/icm';
import type { RequestGate } from '../src/agent/training';
import { CONFIDENCE_STOPS, TOPIC_IDS } from '../src/agent/contract';
import { appendHighlight, bottleneckFields, knowledgeOpsSchema, MemoryInputError, readHighlights, saveDiagnosis, topicStatusFields, updateKnowledgeMap, WORKING_STATE_MAX_CHARS, WORKING_STATE_MAX_LINES, writeWorkingState } from './memory';

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

  shove_ev: tool({
    description: 'EV in chips of a bet, raise or shove that may win the pot uncontested (fold equity) versus folding at this decision point: foldProbability * pot + (1 - foldProbability) * (equityWhenCalled * (pot + heroCost + opponentCall) - heroCost). Heads-up and terminal: after a call no further betting, no rake, no side pots. All amounts are counted from the decision point; chips already posted are part of the pot, never of heroCost.',
    inputSchema: z.object({
      pot: z.number().int().nonnegative().describe("Chips in the middle at the decision, before the hero acts: blinds, antes and every chip already posted by anyone (the hero's posted blind included)"),
      heroCost: z.number().int().nonnegative().describe("Chips the hero adds now with the bet/raise/shove (not counting chips already posted). If the opponent covers less: his street bet after calling minus your current street bet (only what he can match; antes are dead money: in pot, never in this matching)"),
      opponentCall: z.number().int().nonnegative().describe("Chips the opponent adds to call it (not counting chips he already posted). If he covers less: all he has behind"),
      foldProbability: z.number().min(0).max(1).describe('Probability 0..1 the opponent folds'),
      equityWhenCalled: z.number().min(0).max(1).describe("Hero's showdown pot share 0..1 against the calling range, e.g. from the equity tool"),
      bigBlind: z.number().int().positive().optional().describe('Big blind in chips, to also report the EV in BB'),
    }),
    execute: ({ bigBlind, ...opts }) => safe(() => {
      const ev = headsUpRaiseEV(opts);
      return {
        evChips: r4(ev), ...(bigBlind === undefined ? {} : { evBB: r4(ev / bigBlind) }),
        assumption: 'EV versus folding at this decision; heads-up, terminal: no further betting, rake or side pots',
      };
    }),
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
    description: 'Exact ICM prize equity of each player from chip stacks and payout shares. Optionally (hero, opponent and risk together) the bubble factor of the hero against one opponent for a symmetric risk of `risk` chips with no dead money: how much more losing hurts than winning helps. Optionally (hero and outcomes) the ICM EV of a decision such as a shove with fold equity: the expected prize share over the outcomes versus `stacks` as the baseline.',
    inputSchema: z.object({
      stacks: z.array(z.number().int().nonnegative()).min(1).max(6).describe('Chip stacks of the players still in the tournament; a busted player is 0 (at most one). With outcomes: the end-of-hand stacks if the hero folds now (the baseline)'),
      payouts: z.array(z.number().min(0).max(1)).min(1).max(6).describe('Prize shares by finishing place, nonincreasing, e.g. [0.65, 0.35]'),
      hero: z.number().int().min(0).max(5).optional().describe('Index of the hero in stacks (for bubble factor or outcomes)'),
      opponent: z.number().int().min(0).max(5).optional().describe('Index of the opponent in stacks (for bubble factor)'),
      risk: z.number().int().positive().optional().describe('Chips at risk, covered by both stacks (for bubble factor)'),
      outcomes: z.array(z.object({
        probability: z.number().min(0).max(1),
        stacks: z.array(z.number().int().nonnegative()).min(1).max(6),
      })).min(1).max(6).optional().describe('End-of-hand stacks of each outcome with its probability (summing to 1), same player order as stacks and the same chip total. The fold baseline is the end-of-hand stacks if the hero folds now. With the shove_ev inputs, the hero stack is: steal (probability = fold%) = his fold-baseline stack + pot; called and won (call% × equity) = fold baseline + pot + opponentCall; called and lost (call% × (1 − equity)) = fold baseline − heroCost. The opponent takes the difference, so every outcome keeps the chip total.'),
    }),
    execute: ({ stacks, payouts, hero, opponent, risk, outcomes }) => safe(() => {
      const equities = icmEquities(stacks, payouts).map(r4);
      if (outcomes) {
        if (hero === undefined || opponent !== undefined || risk !== undefined) throw new Error('Outcomes need hero, and no opponent or risk');
        const ev = icmOutcomeEV(stacks, payouts, hero, outcomes);
        return { equities, expectedEquity: r4(ev.expectedEquity), delta: r4(ev.delta) };
      }
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

/** Input the model can fix comes back as `{ error }`; file system failures stay real tool errors. */
async function memoryResult<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof MemoryInputError) return { error: e.message };
    throw e;
  }
}

/** Built per request with the snapshot's hand id closed over: the model never names the hand it records. */
export const memoryTools = (handId: string | null) => ({
  write_working_state: tool({
    description: `Overwrites working-state.md with the complete new text (not a diff). At most ${WORKING_STATE_MAX_LINES} lines and exactly three sections: "## Current Workbench" (topic in work + next step), "## Conventions" (agreed formulas, terms, counting rules), "## Student Profile" (level, learning style, preferences). A dry current state, never a chronological log.`,
    inputSchema: z.object({ markdown: z.string().min(1).max(WORKING_STATE_MAX_CHARS).describe('The whole new working state in Markdown') }),
    execute: ({ markdown }) => memoryResult(() => writeWorkingState(markdown)),
  }),

  update_knowledge_map: tool({
    description: `Applies operations to knowledge-map.md, all or none. set_topic: topic status 0 Not started, 1 Theory/Exposed, 2 Guided practice, 3 Mastered. add: a new active bottleneck (a conceptual mistake). overcome: the player avoided the bottleneck fully independently in the CURRENT hand (the server takes the hand from the table; the same hand counts once, and never the hand where the mistake was added or relapsed; at the 3rd distinct hand the bottleneck is removed). relapse: the mistake recurred, its counter resets. remove: drop a bottleneck recorded by mistake.`,
    inputSchema: z.object({ ops: knowledgeOpsSchema }),
    execute: ({ ops }) => memoryResult(() => updateKnowledgeMap(ops, handId)),
  }),

  append_highlight: tool({
    description: 'Archives the CURRENT hand (taken from the table by the server) as an instructive hand in highlights.md: an outstanding decision or an instructive failure, never an arithmetic slip. At most one entry per hand.',
    inputSchema: z.object({
      spot: z.string().min(1).max(200).describe('The spot/topic in one line'),
      independence: z.number().int().min(1).max(3).describe("1 needed Dan's explanation, 2 got there with hints, 3 fully independent"),
      takeaway: z.string().min(1).max(300).describe('The conceptual takeaway in one line'),
    }),
    execute: (input) => memoryResult(() => appendHighlight(input, handId)),
  }),

  read_highlights: tool({
    description: 'Reads the latest archived instructive hands (up to 10, oldest first). Only when the player asks to recall past hands.',
    inputSchema: z.object({}),
    execute: () => readHighlights(),
  }),
});

// --- level diagnosis --------------------------------------------------------
// Ported from the learnharness prober: the descriptions carry mechanics only, the question craft lives in Dan's diagnosis prompt.

const text = (max: number) => z.string().trim().min(1).max(max);
const optionLabel = text(300).describe('Display label for the answer option — a bare claim, no reasoning');
const optionValue = text(80).optional().describe('Optional machine-readable value returned for the option. Defaults to the label.');
const resolvedValue = (o: { label: string; value?: string }) => o.value || o.label;

/** The client card keys options by their resolved value, so values must be distinct. */
function checkOptions(options: { label: string; value?: string }[], ctx: z.RefinementCtx) {
  const values = options.map(resolvedValue);
  if (new Set(values).size < values.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Two options resolve to the same value: options must be distinct.' });
}

const LETTER_NOTE = 'When single-select options are lettered, the result’s `optionOrder` maps each displayed letter to its one-based position in your original `options` array, and each selected answer includes its displayed `letter`.';
const PROBE_EXAMPLE = {
  question: 'Какое решение лучше?',
  context: 'Ривер, хедз-ап, стеки глубокие. Банк 300, соперник ставит 30. У тебя средняя пара; допустим, против диапазона этой ставки у тебя около 30% эквити.',
  options: [{ label: 'Колл', value: 'call' }, { label: 'Фолд', value: 'fold' }, { label: 'Рейз', value: 'raise' }],
  explanation: 'Колл 30 разыгрывает итоговый банк 360, поэтому хватает около 8% эквити (30 / 360); 30% намного больше, и никакая ошибка оценки этого не меняет. Рейз со средней парой заколлят только руки сильнее, а хуже — сфолдят.',
  correctAnswer: 'call',
};

// The answer records the client card returns as the tool output (port of compactAnswerForModel): only what the player added.
const answers = z.array(z.strictObject({ index: z.number().int().min(1).max(26), label: text(300), letter: z.string().regex(/^[A-Z]$/).optional() })).min(1).max(26);
const optionOrder = z.record(z.string().regex(/^[A-Z]$/), z.number().int().min(1).max(26)).optional();
// Player text is not capped here: the client resends history, so a too-long answer would fail every later request; the body limit bounds it.
const thinking = z.string().optional();
// The player sent a message instead of answering: the client returns this for the open question.
const dismissed = z.strictObject({ dismissed: z.literal(true) });
const probeAnswerSchema = dismissed.or(z.strictObject({
  dontKnow: z.literal(true).optional(),
  optionOrder,
  answers: answers.optional(),
  correct: z.boolean().optional(),
  confidence: z.number().refine((v) => (CONFIDENCE_STOPS as readonly number[]).includes(v), `confidence is one of ${CONFIDENCE_STOPS.join(', ')}`).optional(),
  thinking,
}).refine((a) => a.dontKnow
  ? !a.answers && a.correct === undefined && a.confidence === undefined
  : !!a.answers && a.correct !== undefined, 'A probe answer is either "dontKnow" alone or answers with a verdict'));
const askAnswerSchema = dismissed.or(z.strictObject({ optionOrder, answers: answers.optional(), other: z.string().optional(), text: z.string().optional(), thinking })
  .refine((a) => a.answers || a.other || a.text, 'An answer needs selected options, "other" or "text"'));

const strandSchema = z.object({
  strand: z.enum(TOPIC_IDS).describe('The knowledge-map topic id this strand is about'),
  assessment: z.string().trim().min(1).max(1500).describe('Describe what the player reliably reasons from (the floor) and where their reasoning runs out (the ceiling), as supported by the evidence. Include relevant misconceptions and distinguish untested bounds from observed gaps.'),
});

const DIAGNOSIS_DONE_ACK = 'Оценка записана: игрок видит её сейчас, рабочая память и карта знаний обновлены. Скажи одну завершающую фразу (с какой темы начнём) и закончи ход; дальше обычный режим.';

/**
 * Built per request. `probe` and `ask_user_question` have no execute: the stream ends at the call and the client returns
 * the player's answer as the tool output. `alreadyConcluded` comes from the request history; the flags cover this request.
 */
export function diagnosisTools(handId: string | null, alreadyConcluded: boolean) {
  let questionAsked = false;
  // An earlier call of this request is running or has succeeded.
  let claimed = false;
  // Tools execute only after the model's whole step has been parsed, so a question call in the same step has already set the flag.
  const asked = () => { questionAsked = true; };
  return {
    ask_user_question: tool({
      description: 'Ask the player a single question. NOT graded — there is no correct answer. Use when requirements are ambiguous, preferences are needed, a decision would materially affect the diagnosis, or you need an open-ended response. ' + LETTER_NOTE,
      inputSchema: z.object({
        question: text(1000).describe('The single question to ask the player.'),
        details: text(1500).optional().describe('Optional extra context or instructions shown under the question.'),
        options: z.array(z.object({ label: optionLabel, value: optionValue, description: text(300).optional().describe('Optional extra detail shown below the option') })).min(2).max(8).optional()
          .describe("Optional multiple-choice options. Omit for free-form text input. The player can always choose 'Other' and type a custom answer when options are provided."),
        multiSelect: z.boolean().optional().describe('Set to true to allow multiple answers to the same question.'),
      }).superRefine((input, ctx) => checkOptions(input.options ?? [], ctx)),
      outputSchema: askAnswerSchema,
      onInputAvailable: asked,
    }),

    probe: tool({
      description: [
        "Ask the player a GRADED question with a known correct answer, then instantly grade and give feedback. Unlike ask_user_question (which collects preferences/decisions with no right answer), probe always has a correct answer supplied by you, marks the player's selection right/wrong, reveals the correct answer, and can show an explanation. Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the player can signal a genuine gap instead of guessing. A confidence slider (0, 30, 50, 70, 90, 100: the player's probability that the pick is correct; none on 'I don't know') rides every answer. An always-present optional thinking field lets the player attach his reasoning to ANY answer; it reaches you only when non-empty. No free-text answers — for non-graded questions use ask_user_question instead.",
        LETTER_NOTE,
        `Example arguments:\n\`\`\`json\n${JSON.stringify(PROBE_EXAMPLE, null, 2)}\n\`\`\``,
      ].join(' '),
      inputSchema: z.object({
        question: text(1000).describe('The single quiz question to ask.'),
        context: text(1500).optional().describe('Optional spot shown with the question: positions, stacks in BB, action so far, cards, board, payouts.'),
        options: z.array(z.object({ label: optionLabel, value: optionValue })).min(2).max(6)
          .describe("REQUIRED. The answer options (2 or more) as a JSON ARRAY of option objects — never a JSON-encoded string. Options only — there is no free-text mode. Give each option a stable `value`; you reference the correct one by that value in correctAnswer. Never add your own 'I don't know' option — that choice is added for you."),
        multiSelect: z.boolean().optional().describe('Set to true when more than one option is correct and the player must select all of them.'),
        explanation: text(2000).describe('REQUIRED. Explanation revealed AFTER the player answers (shown whether they got it right or wrong). Use it to reinforce why the correct answer is correct. It is written BEFORE correctAnswer by design: reason it out first, then commit the answer the reasoning supports.'),
        correctAnswer: z.union([text(80), z.array(text(80)).min(1).max(6)])
          .describe('REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. Single-select: a single string (e.g. "a"). Multi-select: an array of strings (e.g. ["a", "c"]); the player is only correct if their selection matches this set exactly. Always pass the value, not a position number — this is self-checking and prevents miscounting. A value that matches no option fails validation and the call is returned to you to fix.'),
      }).superRefine((input, ctx) => {
        checkOptions(input.options, ctx);
        const values = input.options.map(resolvedValue);
        const correct = [...new Set([input.correctAnswer].flat())];
        for (const v of correct) {
          if (!values.includes(v)) ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: `correctAnswer "${v}" does not match any option value. Valid values: ${values.map((x) => `"${x}"`).join(', ')}. Copy the exact value of the intended option.` });
        }
        if (correct.length > 1 && input.multiSelect !== true) {
          ctx.addIssue({ code: 'custom', path: ['multiSelect'], message: `correctAnswer lists ${correct.length} values but multiSelect is not true: set multiSelect: true, or make exactly one option correct.` });
        }
      }),
      outputSchema: probeAnswerSchema,
      onInputAvailable: asked,
    }),

    diagnosis_done: tool({
      description: "Conclude the level diagnosis. Call this ONCE, when the player's goal is clear and the evidence about their understanding is sufficient to choose a starting topic and plan a path. A self-report alone isn't that evidence. The input IS the assessment: for the strands the goal depends on, report what the player can reason from, how they connect the ideas, where their reasoning ran out, and what still needs checking. Report bounds supported by the evidence; don't force a miss once the player has demonstrated what is needed. The server saves topicStatuses and bottlenecks to the knowledge map and workingState as working-state.md, all or none; the assessment is shown to the player. Refused while a question is still open, and after the diagnosis is already concluded. After it succeeds, say your closing sentence and end your turn.",
      inputSchema: z.object({
        assessment: z.object({
          strands: z.array(strandSchema).min(1).max(TOPIC_IDS.length).describe('The strands the goal depends on, with what the evidence shows and what still needs checking.'),
          summary: z.string().trim().min(1).max(2000).describe("Overall synthesis: the player's goal and where teaching should start."),
        }).describe('The player assessment — the diagnosis\' distilled output.'),
        topicStatuses: z.array(z.object(topicStatusFields)).max(TOPIC_IDS.length).describe('Knowledge-map statuses (0 Not started, 1 Theory/Exposed, 2 Guided practice, 3 Mastered) only for strands with evidence; untested topics stay as they are.'),
        bottlenecks: z.array(z.object(bottleneckFields)).max(8).describe('Misconceptions actually observed (a wrong model, not a slip), added as active bottlenecks. Omit ids that are already active.'),
        workingState: z.string().min(1).max(WORKING_STATE_MAX_CHARS).describe(`The complete initial working-state.md: at most ${WORKING_STATE_MAX_LINES} lines and exactly the sections "## Current Workbench" (the first topic to work on + next step), "## Conventions", "## Student Profile" (level, goal, experience, style, and one line per key strand: floor → ceiling).`),
      }),
      execute: async ({ topicStatuses, bottlenecks, workingState }) => {
        if (questionAsked) return { error: 'A question is still open — let the player answer it before concluding. diagnosis_done only fires with no question outstanding; nothing was saved.' };
        if (alreadyConcluded) return { error: 'The diagnosis is already concluded — diagnosis_done fires exactly once.' };
        if (claimed) return { error: 'Another diagnosis_done in this response is running or already succeeded — it fires exactly once.' };
        // Claimed before the await: a second call in the same step runs concurrently.
        claimed = true;
        const ops = [...topicStatuses.map((t) => ({ op: 'set_topic' as const, ...t })), ...bottlenecks.map((b) => ({ op: 'add' as const, ...b }))];
        const failed = await memoryResult(() => saveDiagnosis(workingState, ops, handId)).catch((e) => { claimed = false; throw e; });
        if (failed) claimed = false;
        return failed ?? { saved: true as const, note: DIAGNOSIS_DONE_ACK };
      },
    }),
  };
}

/** Every tool Dan may have; the client types its tool parts with this. */
export type DanTools = typeof tools & ReturnType<typeof memoryTools> & { release_actions: ReturnType<typeof releaseActions> } & ReturnType<typeof diagnosisTools>;
