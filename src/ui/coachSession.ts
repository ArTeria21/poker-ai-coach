import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, type InferUITools, type UIDataTypes, type UIMessage } from 'ai';
import { create } from 'zustand';
import type { DanTools } from '../../server/tools';
import { WINDOW_MESSAGES } from '../agent/contract';
import { coachSnapshot } from '../agent/snapshot';
import {
  decisionGateId, initialTrainingState, obviousPreflopSpot, reviewGateId, step, TRIGGER_PREFIX,
  type GateKind, type Mode, type RequestGate, type TrainingEvent, type TrainingRequest, type TrainingState,
} from '../agent/training';
import type { GamePhase } from '../engine/types';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';

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

export const lockedGate = (s: TrainingState): RequestGate | null =>
  s.mode === 'training' && s.gate?.locked ? { id: s.gate.id, kind: s.gate.kind } : null;

/** Computed on send or retry (and, in Training only, for the preflop filter on hero turns), never during Free Play. The server drops older turns anyway, and a long history would hit its 1 MB body limit. */
export function chatRequestBody(messages: DanMessage[]) {
  const { state } = useTrainingStore.getState();
  return {
    messages: messages.slice(-WINDOW_MESSAGES),
    snapshot: coachSnapshot(useGameStore.getState()),
    mode: state.mode,
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
  const street = useGameStore.getState().phase ?? 'preflop';
  const text = request.kind === 'decision'
    ? `${TRIGGER_PREFIX} Мой ход: ${STREET_RU[street]}.`
    : `${TRIGGER_PREFIX} Раздача завершена, жду разбор раздачи.`;
  // The parts form sets the chat busy synchronously, so a second flush in the same tick cannot send again.
  void chat.sendMessage({ parts: [{ type: 'text', text }], metadata: { trigger: request.kind, gateId: request.gateId, street } });
}

/** A message the player typed (or an example question). */
export function sendUserText(text: string): void {
  dispatch({ type: 'userMessage' });
  void chat.sendMessage({ parts: [{ type: 'text', text }] });
}

export function setTrainingMode(mode: Mode): void {
  const view = useGameStore.getState();
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
  }
}

/** Feeds table and chat events into the state machine; returns the unsubscribe. */
export function connectTraining(): () => void {
  const offGame = useGameStore.subscribe((view, prev) => {
    if (view.handId === null) {
      if (prev.handId !== null) dispatch({ type: 'reset' });
      return;
    }
    dispatch({ type: 'newHand', handId: view.handId });
    // The filter needs a snapshot; Free Play skips it since nothing can lock there.
    if (view.heroLegal && view.heroLegal !== prev.heroLegal && useTrainingStore.getState().state.mode === 'training') {
      dispatch({ type: 'heroTurn', key: decisionGateId(view.handId, view.handActions.length), obvious: obviousPreflopSpot(coachSnapshot(view)!) });
    }
    if (view.phase === 'complete') dispatch({ type: 'handComplete', heroDealt: view.seats.some((s) => s.isHero && s.position !== null) });
  });
  // Deferred: the chat finishes its own bookkeeping after the status change.
  const offStatus = chat['~registerStatusCallback'](() => queueMicrotask(flush));
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
  const decisionKey = useGameStore((s) => s.handId && s.heroLegal ? decisionGateId(s.handId, s.handActions.length) : null);
  const handId = useGameStore((s) => s.handId);
  return {
    decision: locked !== null && locked === decisionKey,
    review: locked !== null && handId !== null && locked === reviewGateId(handId),
  };
}
