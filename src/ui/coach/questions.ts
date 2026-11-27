import { CONFIDENCE_STOPS } from '../../agent/contract';
import { hashSeed, mulberry32, shuffleInPlace } from '../../random';

/**
 * The diagnosis question cards' pure logic, ported from learnharness `question-core.ts`: display order and letters,
 * the selection state machine, client grading, and the compact answer record the model reads as the tool output.
 */

export interface DisplayOption {
  label: string;
  value: string;
  description?: string;
}
/** Displayed letter → one-based position in the authored options array. */
export type OptionOrder = Record<string, number>;

export const DEFAULT_CONFIDENCE_INDEX = 2;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Probe options shuffle stably per call (the correct one is not always first); single-select options are lettered. */
export function displayOptions(
  raw: { label: string; value?: string; description?: string }[] | undefined,
  shuffle: boolean, multi: boolean, toolCallId: string,
): { options: DisplayOption[]; optionOrder?: OptionOrder } {
  // The server already trimmed the input and capped the options well below 26 letters.
  const authored = (raw ?? []).map((o, i) => ({ position: i + 1, option: { label: o.label, value: o.value || o.label, description: o.description } }));
  const shown = shuffle ? shuffleInPlace([...authored], mulberry32(hashSeed(toolCallId))) : authored;
  const options = shown.map((s) => s.option);
  if (multi || shown.length === 0) return { options };
  return { options, optionOrder: Object.fromEntries(shown.map((s, i) => [LETTERS[i], s.position])) };
}

export const letterAt = (order: OptionOrder | undefined, index: number): string | undefined =>
  order ? LETTERS[index - 1] : undefined;

/** One-based display indices of the correct option(s); the server already checked every value names an option. */
export function correctIndices(options: DisplayOption[], correctAnswer: string | string[]): number[] {
  const correct = new Set([correctAnswer].flat());
  return options.flatMap((o, i) => correct.has(o.value) ? [i + 1] : []);
}

/** The card's selection: zero-based display indices, the ask's "Other" row, the probe's "Don't know". */
export interface Selection {
  selected: Set<number>;
  other: boolean;
  dontKnow: boolean;
}
export const emptySelection = (): Selection => ({ selected: new Set(), other: false, dontKnow: false });

/** Single-select: the option becomes THE answer. Multi-select: it toggles alongside the others and "Other". */
export function toggleOption(multi: boolean, sel: Selection, idx: number): Selection {
  if (!multi) return { selected: new Set([idx]), other: false, dontKnow: false };
  const selected = new Set(sel.selected);
  if (selected.has(idx)) selected.delete(idx);
  else selected.add(idx);
  return { selected, other: sel.other, dontKnow: false };
}

export function toggleOther(multi: boolean, sel: Selection): Selection {
  return multi ? { ...sel, other: !sel.other, dontKnow: false } : { selected: new Set(), other: true, dontKnow: false };
}

/** "Don't know" stands alone: it clears every pick. */
export const toggleDontKnow = (sel: Selection): Selection => ({ selected: new Set(), other: false, dontKnow: !sel.dontKnow });

function answers(options: DisplayOption[], optionOrder: OptionOrder | undefined, sel: Selection) {
  return [...sel.selected].sort((a, b) => a - b).map((i) => {
    const letter = letterAt(optionOrder, i + 1);
    return { index: i + 1, label: options[i].label, ...(letter ? { letter } : {}) };
  });
}

const trimmed = (text: string) => text.trim() || undefined;

/** The graded probe answer as the model reads it: only what the player added (dontKnow implies incorrect and carries no confidence). */
export function probeRecord(
  q: { options: DisplayOption[]; optionOrder?: OptionOrder; correct: number[] },
  sel: Selection, confidenceIndex: number, thinking: string,
) {
  const think = trimmed(thinking);
  if (sel.dontKnow) return { dontKnow: true as const, ...(q.optionOrder ? { optionOrder: q.optionOrder } : {}), ...(think ? { thinking: think } : {}) };
  const picked = answers(q.options, q.optionOrder, sel);
  const correct = picked.length === q.correct.length && picked.every((a, i) => a.index === q.correct[i]);
  return {
    ...(q.optionOrder ? { optionOrder: q.optionOrder } : {}),
    answers: picked,
    correct,
    confidence: CONFIDENCE_STOPS[confidenceIndex],
    ...(think ? { thinking: think } : {}),
  };
}

/** The ungraded ask answer: picked options and/or "Other" text, or free text when the question has no options. */
export function askRecord(
  q: { options: DisplayOption[]; optionOrder?: OptionOrder },
  sel: Selection, other: string, text: string, thinking: string,
) {
  const picked = answers(q.options, q.optionOrder, sel);
  const otherText = sel.other ? trimmed(other) : undefined;
  const free = q.options.length === 0 ? trimmed(text) : undefined;
  const think = trimmed(thinking);
  return {
    ...(q.optionOrder ? { optionOrder: q.optionOrder } : {}),
    ...(picked.length ? { answers: picked } : {}),
    ...(free ? { text: free } : {}),
    ...(otherText ? { other: otherText } : {}),
    ...(think ? { thinking: think } : {}),
  };
}

export const canSubmitProbe = (sel: Selection) => sel.dontKnow || sel.selected.size > 0;
export const canSubmitAsk = (hasOptions: boolean, sel: Selection, other: string, text: string) =>
  hasOptions ? sel.selected.size > 0 || (sel.other && other.trim().length > 0) : text.trim().length > 0;
