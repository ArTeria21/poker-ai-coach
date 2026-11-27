import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, type InferUITools, type UIDataTypes, type UIMessage } from 'ai';
import { create } from 'zustand';
import type { DanTools } from '../../server/tools';
import { DIAGNOSIS_PREFIX, FOLD_AT, MAX_UNFOLDED_MESSAGES, WINDOW_MESSAGES } from '../agent/contract';
import { coachSnapshot } from './coachSnapshot';
import {
  decisionGateId, initialTrainingState, obviousPreflopSpot, reviewGateId, step, TRIGGER_PREFIX,
  type GateKind, type Mode, type RequestGate, type TrainingEvent, type TrainingRequest, type TrainingState,
} from '../agent/training';
import type { GamePhase } from '../engine/types';
import { gameStore, useGameView } from './gameStore';
import { useSettingsStore } from './settingsStore';

/**
 * The one coach chat of the app and the Training Mode wiring around it:
 * table events → `step()` → training store → trigger messages; `release_actions` outputs → `released`.
 */

/** Set on the automatic training turns; the chat shows them as event lines, not user bubbles. */
export interface TriggerMeta {
  trigger: GateKind;
  gateId: string;
  street: GamePhase;
}
export type DanMessage = UIMessage<TriggerMeta, UIDataTypes, InferUITools<DanTools>>;

interface TrainingStore {
  state: TrainingState;
  /** Gate the latest chat request was sent for; "Continue without Dan" releases exactly this one. */
  requestGate: RequestGate | null;
  /** The player stopped that request: like an error, it leaves the gate with nobody to release it. */
  requestStopped: boolean;
}

export const useTrainingStore = create<TrainingStore>()(() => ({
  state: initialTrainingState(useSettingsStore.getState().mode),
  requestGate: null,
  requestStopped: false,
}));

/**
 * The level diagnosis phase (not persisted): `resume` is the mode to return to, null while no diagnosis runs.
 * `initialized` mirrors GET /api/memory/status (null until known).
 */
export const useDiagnosisStore = create<{ resume: Mode | null; initialized: boolean | null }>()(() => ({ resume: null, initialized: null }));

export const lockedGate = (s: TrainingState): RequestGate | null =>
  s.mode === 'training' && s.gate?.locked ? { id: s.gate.id, kind: s.gate.kind } : null;

/**
 * Dialog compaction state of the current chat: the summary replaces every message before `keptFromId`.
 * A page reload starts a new chat without one; long-term continuity comes from the memory files.
 */
let fold: { summary: string; keptFromId: string } | null = null;
let folding = false;

/** Where the unfolded messages start; a fold whose kept message is gone (the chat was cleared) no longer applies. */
function unfolded(messages: DanMessage[]): { start: number; summary: string | null } {
  const start = fold ? messages.findIndex((m) => m.id === fold!.keptFromId) : -1;
  return start < 0 ? { start: 0, summary: null } : { start, summary: fold!.summary };
}

/** The first kept message: the first user message among the last WINDOW_MESSAGES, since the server drops a tail's leading non-user messages. */
export function foldCut(messages: DanMessage[], start: number): number | null {
  for (let i = Math.max(messages.length - WINDOW_MESSAGES, start + 1); i < messages.length; i++) {
    if (messages[i].role === 'user') return i;
  }
  return null;
}

/** Once the chat settles with more than FOLD_AT unfolded messages, folds the older ones into the summary. Single-flight; a failure keeps the old state until the next settle. */
export async function compactIfDue(): Promise<void> {
  const messages = chat.messages;
  if (folding || chat.status !== 'ready') return;
  const { start, summary } = unfolded(messages);
  const cut = messages.length - start > FOLD_AT ? foldCut(messages, start) : null;
  if (cut === null) return;
  folding = true;
  try {
    const res = await fetch('/api/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary, messages: messages.slice(start, cut) }),
    });
    const data = res.ok ? await res.json() as { summary?: unknown } : null;
    if (typeof data?.summary !== 'string') throw new Error(`HTTP ${res.status}`);
    fold = { summary: data.summary, keptFromId: messages[cut].id };
  } catch (error) {
    console.warn('[compact] failed, will retry at the next settle:', error instanceof Error ? error.message : error);
  } finally {
    folding = false;
  }
}

/** Computed on send or retry (and, in Training only, for the preflop filter on hero turns), never during Free Play. The cap keeps a long history under the server's 1 MB body limit if folding keeps failing. */
export function chatRequestBody(messages: DanMessage[]) {
  const { state } = useTrainingStore.getState();
  const { start, summary } = unfolded(messages);
  return {
    messages: messages.slice(start).slice(-MAX_UNFOLDED_MESSAGES),
    summary,
    snapshot: coachSnapshot(gameStore.getState()),
    mode: state.mode,
    phase: useDiagnosisStore.getState().resume ? 'diagnosis' as const : null,
    // Any send while a gate is locked (trigger, the player's answer, Retry) may release that gate.
    gate: lockedGate(state),
  };
}

export const chat = new Chat<DanMessage>({
  transport: new DefaultChatTransport<DanMessage>({
    api: '/api/chat',
    prepareSendMessagesRequest: ({ messages }) => {
      const body = chatRequestBody(messages);
      useTrainingStore.setState({ requestGate: body.gate, requestStopped: false });
      return { body };
    },
  }),
});

export type QuestionTool = 'probe' | 'ask_user_question';
type Part = DanMessage['parts'][number];
export const isQuestion = (part: Part): part is Extract<Part, { type: `tool-${QuestionTool}` }> =>
  part.type === 'tool-probe' || part.type === 'tool-ask_user_question';
const unanswered = (part: Part) => isQuestion(part) && part.state === 'input-available';

/** The question the player can answer now: the first unanswered one in Dan's latest message, while the diagnosis runs and the chat is idle. */
export function openQuestion(messages: DanMessage[]): string | null {
  const last = messages.at(-1);
  if (!useDiagnosisStore.getState().resume || busy() || last?.role !== 'assistant') return null;
  return last.parts.find(unanswered)?.toolCallId ?? null;
}

/**
 * Writes the answer into the open question's part of the LAST message (not `addToolOutput`, which writes into the first
 * message holding the id: providers reuse call ids across responses). Returns whether no question of the message is left.
 */
function settleOpenQuestion(toolCallId: string, output: object): boolean {
  if (openQuestion(chat.messages) !== toolCallId) return false;
  const last = chat.messages.at(-1)!;
  const i = last.parts.findIndex(unanswered);
  const parts = last.parts.map((p, j) => j === i ? { ...p, state: 'output-available', output } as Part : p);
  chat.messages = [...chat.messages.slice(0, -1), { ...last, parts }];
  return !parts.some(unanswered);
}

/** Returns the player's answer record as the tool output, once; the chat continues Dan's message only when no question of it is left. */
export function answerQuestion<T extends QuestionTool>(toolCallId: string, output: InferUITools<DanTools>[T]['output']): void {
  // sendMessage() without a message continues the last assistant message.
  if (settleOpenQuestion(toolCallId, output)) void chat.sendMessage();
}

/** Retry after an error: regenerate() would drop Dan's whole message, answered diagnosis cards included, so continue it instead. */
export function retry(): void {
  const last = chat.lastMessage;
  void (last?.role === 'assistant' && last.parts.some(isQuestion) ? chat.sendMessage() : chat.regenerate());
}

/** At most one waiting trigger: a newer gate replaces the older one, which can no longer be locked. */
let pending: TrainingRequest | null = null;

const busy = () => chat.status === 'submitted' || chat.status === 'streaming';

export function dispatch(event: TrainingEvent): void {
  const current = useTrainingStore.getState().state;
  const { state, request } = step(current, event);
  if (state !== current) useTrainingStore.setState({ state });
  if (request) {
    pending = request;
    queueMicrotask(flush);
  }
}

const STREET_RU: Record<GamePhase, string> = { preflop: 'префлоп', flop: 'флоп', turn: 'тёрн', river: 'ривер', complete: 'раздача завершена' };

/** Sends the waiting trigger once the chat is free, and only while its gate is still the locked one. */
function flush(): void {
  if (!pending || busy()) return;
  const request = pending;
  pending = null;
  if (lockedGate(useTrainingStore.getState().state)?.id !== request.gateId) return;
  const street = gameStore.getState().phase ?? 'preflop';
  const text = request.kind === 'decision'
    ? `${TRIGGER_PREFIX} Мой ход: ${STREET_RU[street]}.`
    : `${TRIGGER_PREFIX} Раздача завершена, жду разбор раздачи.`;
  // The parts form sets the chat busy synchronously, so a second flush in the same tick cannot send again.
  void chat.sendMessage({ parts: [{ type: 'text', text }], metadata: { trigger: request.kind, gateId: request.gateId, street } });
}

/** Starts the level diagnosis: Training pauses (no locks, no triggers) and every request carries the phase until it ends. */
export function startDiagnosis(): void {
  if (busy() || useDiagnosisStore.getState().resume) return;
  useDiagnosisStore.setState({ resume: useSettingsStore.getState().mode });
  dispatch({ type: 'modeChanged', mode: 'free' });
  void chat.sendMessage({ parts: [{ type: 'text', text: `${DIAGNOSIS_PREFIX} Хочу пройти диагностику уровня.` }] });
}

/** Ends the phase and resumes the saved mode; the decision or finished hand on screen counts as handled. */
function endDiagnosis(): void {
  const { resume } = useDiagnosisStore.getState();
  if (!resume) return;
  useDiagnosisStore.setState({ resume: null });
  if (resume === 'training') setTrainingMode('training');
}

/** The player cancels the diagnosis; an open question card turns into a skipped one. */
export function stopDiagnosis(): void {
  if (busy()) stopDan();
  endDiagnosis();
}

export async function loadMemoryStatus(): Promise<void> {
  try {
    const res = await fetch('/api/memory/status');
    const data = res.ok ? await res.json() as { initialized?: unknown } : null;
    if (typeof data?.initialized === 'boolean') useDiagnosisStore.setState({ initialized: data.initialized });
  } catch { /* unknown status: no first-launch offer, the header button still works */ }
}

/** A message the player typed (or an example question). */
export function sendUserText(text: string): void {
  // Not once the hand is over on screen: during the showdown pause the machine has not seen the end yet, and chat must not reopen the hand for review.
  if (gameStore.getState().phase !== 'complete') dispatch({ type: 'userMessage' });
  // The player typed instead of answering: Dan sees which questions were skipped (port of learnharness' dismissed record).
  for (let id = openQuestion(chat.messages); id !== null; id = openQuestion(chat.messages)) settleOpenQuestion(id, { dismissed: true });
  void chat.sendMessage({ parts: [{ type: 'text', text }] });
}

export function setTrainingMode(mode: Mode): void {
  const view = gameStore.getState();
  // The decision or finished hand on screen counts as handled: training starts at the next trigger.
  const currentKey = !view.handId ? undefined
    : view.heroLegal ? decisionGateId(view.handId, view.handActions.length)
      : view.phase === 'complete' ? reviewGateId(view.handId) : undefined;
  useSettingsStore.getState().setMode(mode);
  dispatch({ type: 'modeChanged', mode, currentKey });
}

export function stopDan(): void {
  useTrainingStore.setState({ requestStopped: true });
  void chat.stop();
}

/**
 * Mid-stream too: the table unlocks as soon as the tool result arrives. Re-dispatching on every update is safe:
 * `released` is idempotent and ignores other gates' ids (tool-call ids are not, providers reuse them across turns).
 */
function releaseFromMessages(): void {
  for (const part of chat.lastMessage?.parts ?? []) {
    if (part.type === 'tool-release_actions' && part.state === 'output-available') dispatch({ type: 'released', gateId: part.output.released });
    if (part.type === 'tool-diagnosis_done' && part.state === 'output-available' && 'saved' in part.output && useDiagnosisStore.getState().resume) {
      useDiagnosisStore.setState({ initialized: true });
      endDiagnosis();
    }
  }
}

/** Feeds table and chat events into the state machine (and ends the diagnosis once diagnosis_done succeeds) and folds the chat when it settles; returns the unsubscribe. */
export function connectTraining(): () => void {
  const offGame = gameStore.subscribe((view, prev) => {
    if (view.handId === null) {
      if (prev.handId !== null) dispatch({ type: 'reset' });
      return;
    }
    dispatch({ type: 'newHand', handId: view.handId });
    // The filter needs a snapshot; Free Play skips it since nothing can lock there.
    if (view.heroLegal && view.heroLegal !== prev.heroLegal && useTrainingStore.getState().state.mode === 'training') {
      dispatch({ type: 'heroTurn', key: decisionGateId(view.handId, view.handActions.length), obvious: obviousPreflopSpot(coachSnapshot(view)!) });
    }
    // Once settled: a showdown pauses before the tournament books the result, and the review must see busts, places and the tournament's end.
    if (view.phase === 'complete' && view.tournament?.pendingHandId === null) dispatch({ type: 'handComplete', heroDealt: view.seats.some((s) => s.isHero && s.position !== null) });
  });
  // Deferred: the chat finishes its own bookkeeping after the status change. A trigger goes first and makes the chat busy, so folding waits for the next settle.
  const offStatus = chat['~registerStatusCallback'](() => queueMicrotask(() => {
    flush();
    void compactIfDue();
  }));
  const offMessages = chat['~registerMessagesCallback'](releaseFromMessages);
  return () => {
    offGame();
    offStatus();
    offMessages();
  };
}

/** Which control the locked gate holds right now: only the decision or finished hand on screen counts. */
export function useTableLock(): { decision: boolean; review: boolean } {
  const locked = useTrainingStore((s) => lockedGate(s.state)?.id ?? null);
  const decisionKey = useGameView((s) => s.handId && s.heroLegal ? decisionGateId(s.handId, s.handActions.length) : null);
  const handId = useGameView((s) => s.handId);
  return {
    decision: locked !== null && locked === decisionKey,
    review: locked !== null && handId !== null && locked === reviewGateId(handId),
  };
}
