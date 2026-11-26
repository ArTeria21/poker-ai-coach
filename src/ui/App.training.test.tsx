// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Node's own experimental localStorage global (undefined without a file) shadows happy-dom's; the settings store persists to it.
vi.hoisted(() => Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true }));
import { App } from './App';
import { chat, setTrainingMode, useTrainingStore } from './coachSession';
import { decisionGateId, reviewGateId } from '../agent/training';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';

const filter = vi.hoisted(() => ({ obvious: false }));
vi.mock('../agent/training', async (original) => ({
  ...await original<typeof import('../agent/training')>(),
  obviousPreflopSpot: () => filter.obvious,
}));
vi.mock('../game/sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
vi.mock('../bots/botDecision', async (original) => ({
  ...await original<typeof import('../bots/botDecision')>(),
  decideAction: vi.fn((view) => ({ action: { type: view.legal.check ? 'check' : 'call' }, trace: [] })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const store = () => useGameStore.getState();
const tick = () => act(() => vi.advanceTimersByTimeAsync(300));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** A UI message stream as the server writes it (SSE), fed chunk by chunk. */
function streamed() {
  let ctl!: ReadableStreamDefaultController<string>;
  const body = new ReadableStream<string>({ start: (c) => { ctl = c; } }).pipeThrough(new TextEncoderStream());
  const send = (chunk: object) => ctl.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
  send({ type: 'start' });
  send({ type: 'start-step' });
  let calls = 0;
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }),
    release(gateId: string) {
      // Per-response numbering, as providers do: ids repeat across turns.
      const toolCallId = `call_${calls++}`;
      send({ type: 'tool-input-available', toolCallId, toolName: 'release_actions', input: {} });
      send({ type: 'tool-output-available', toolCallId, output: { released: gateId, kind: gateId.endsWith('#review') ? 'review' : 'decision' } });
    },
    fail() {
      send({ type: 'error', errorText: 'Coach could not answer right now.' });
      ctl.close();
    },
    end(text = 'Ок.') {
      send({ type: 'text-start', id: 't' });
      send({ type: 'text-delta', id: 't', delta: text });
      send({ type: 'text-end', id: 't' });
      send({ type: 'finish-step' });
      send({ type: 'finish' });
      ctl.enqueue('data: [DONE]\n\n');
      ctl.close();
    },
  };
}
type Stream = ReturnType<typeof streamed>;

let container: HTMLDivElement;
let root: Root;
let streams: Stream[];
let fetchSpy: ReturnType<typeof mockFetch>;
const mockFetch = () => vi.spyOn(globalThis, 'fetch');
const bodies = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const actionButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.action-buttons .btn')];
const locked = () => actionButtons().length > 0 && actionButtons().every((b) => b.disabled);
const click = (text: string) => act(() => button(text)!.click());
async function say(text: string) {
  await act(async () => {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Send');
}
/** Dan answers every decision trigger at once and releases it; other requests stay open. */
function autoReleaseDecisions() {
  fetchSpy.mockImplementation(async (_url, init) => {
    const s = streamed();
    streams.push(s);
    const gate = JSON.parse(String(init?.body)).gate;
    if (gate?.kind === 'decision') {
      s.release(gate.id);
      s.end();
    }
    return s.response;
  });
}
/** Plays check/call through unlocked turns until the hand is over. */
async function playPassivelyToHandEnd() {
  for (let i = 0; i < 200 && !store().awaitingNext; i++) {
    if (store().heroLegal && !locked()) await passive();
    await tick();
  }
  expect(store().awaitingNext).toBe(true);
}
/** Check or call, whichever the spot offers. */
const passive = () => act(() => actionButtons()[1].click());
const heroKey = () => decisionGateId(store().handId!, store().handActions.length);

async function startTraining() {
  // Before the deal: a hero already to act when the mode switches is not locked (training starts at the next trigger).
  setTrainingMode('training');
  await act(async () => root.render(<StrictMode><App /></StrictMode>));
  expect(button('training')!.getAttribute('aria-pressed')).toBe('true');
  await until(() => store().heroLegal !== null);
  await tick();
}

beforeEach(async () => {
  vi.useFakeTimers();
  useSettingsStore.setState({ speed: 'fast', soundEnabled: false });
  setTrainingMode('free');
  filter.obvious = false;
  streams = [];
  fetchSpy = mockFetch().mockImplementation(async () => {
    const s = streamed();
    streams.push(s);
    return s.response;
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  await chat.stop();
  chat.clearError();
  chat.messages = [];
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Training Mode', () => {
  it('skips an obvious preflop fold: no request, no lock, no review after the fold', async () => {
    filter.obvious = true;
    await startTraining();
    expect(locked()).toBe(false);
    await click('Fold');
    await until(() => store().awaitingNext);
    expect(button('Deal next hand')!.disabled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('locks a real spot with one request for its gate; a stale release keeps it locked, the matching one unlocks any action', async () => {
    await startTraining();
    const key = heroKey();
    expect(locked()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({ mode: 'training', gate: { id: key, kind: 'decision' }, snapshot: { handId: store().handId } });
    expect(container.querySelector('.chat-event')?.textContent).toMatch(/Your turn · preflop/);

    // A late answer for an earlier gate.
    streams[0].release('sng-old-hand-1#3');
    streams[0].end('Какой план?');
    await tick();
    expect(locked()).toBe(true);
    // A normal answer that keeps the gate is not a reason to skip Dan.
    expect(button('Continue without Dan')).toBeUndefined();

    await say('Рейз, сильная рука.');
    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1].gate).toEqual({ id: key, kind: 'decision' });
    streams[1].release(key);
    await tick();
    expect(locked()).toBe(false);
    expect(button('Actions unlocked')).toBeUndefined();
    expect(container.querySelector('.chat-chip')?.textContent).toBe('Actions unlocked');

    // Not necessarily the agreed action: any legal one goes through.
    await act(() => actionButtons().at(-1)!.click());
    expect(store().handActions.at(-1)).toMatchObject({ playerId: 'hero', type: 'raise' });
    streams[1].end();
    await tick();
  });

  it('on an API error, "Continue without Dan" releases only the failed gate', async () => {
    fetchSpy.mockResolvedValue(Response.json({ error: 'Coach could not answer' }, { status: 500 }));
    await startTraining();
    expect(locked()).toBe(true);
    expect(container.querySelector('.chat-error')?.textContent).toContain('Coach could not answer');
    const failed = heroKey();
    expect(useTrainingStore.getState().requestGate?.id).toBe(failed);

    await click('Continue without Dan');
    expect(locked()).toBe(false);
    await passive();
    // The next decision locks again and gets its own request.
    await until(() => store().heroLegal !== null);
    await tick();
    expect(heroKey()).not.toBe(failed);
    expect(locked()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1].gate.id).toBe(heroKey());
  });

  it('switching to Free Play unlocks the table and sends nothing more', async () => {
    await startTraining();
    expect(locked()).toBe(true);
    await click('free');
    expect(locked()).toBe(false);
    await passive();
    await until(() => store().heroLegal !== null || store().awaitingNext);
    expect(locked()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('locks "Deal next hand" for the review of a substantive hand until Dan releases it', async () => {
    await startTraining();
    streams[0].release(heroKey());
    streams[0].end();
    await tick();
    await click('Fold');
    await until(() => store().awaitingNext);
    const review = reviewGateId(store().handId!);
    expect(button('Deal next hand')!.disabled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1].gate).toEqual({ id: review, kind: 'review' });
    expect(bodies()[1].snapshot.status).toBe('handComplete');

    streams[1].release(review);
    streams[1].end();
    await tick();
    expect(button('Deal next hand')!.disabled).toBe(false);
  });

  it('queues a trigger while Dan is still answering and sends it once afterwards', async () => {
    await startTraining();
    // Released mid-stream: the player acts while Dan is still talking.
    streams[0].release(heroKey());
    await tick();
    await passive();
    await until(() => store().heroLegal !== null);
    await tick();
    expect(locked()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    streams[0].end();
    await tick();
    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1].gate.id).toBe(heroKey());
  });

  it('drops a queued trigger whose gate is no longer locked', async () => {
    await startTraining();
    streams[0].release(heroKey());
    await tick();
    await passive();
    await until(() => store().heroLegal !== null);
    await tick();
    expect(locked()).toBe(true);
    await click('free');

    streams[0].end();
    await tick();
    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('Stop leaves the gate locked and offers Retry and "Continue without Dan" until the next answer', async () => {
    await startTraining();
    expect(locked()).toBe(true);
    await click('Stop');
    await tick();
    expect(locked()).toBe(true);
    expect(button('Continue without Dan')).toBeDefined();
    await click('Retry');
    await tick();
    streams[1].end('Какой план?');
    await tick();
    expect(locked()).toBe(true);
    expect(button('Continue without Dan')).toBeUndefined();
    expect(container.textContent).not.toContain('Stopped');
  });

  it('offers no "Continue without Dan" when the failed request had already released its gate', async () => {
    await startTraining();
    streams[0].release(heroKey());
    streams[0].fail();
    await tick();
    expect(locked()).toBe(false);
    expect(container.querySelector('.chat-error')?.textContent).toContain('Coach could not answer');
    expect(button('Continue without Dan')).toBeUndefined();
  });

  it('reviews a hand entered voluntarily after an obvious spot', async () => {
    filter.obvious = true;
    autoReleaseDecisions();
    await startTraining();
    expect(locked()).toBe(false);
    // A raise, since a free check in the big blind would not make the hand substantive.
    await act(() => actionButtons().at(-1)!.click());
    await playPassivelyToHandEnd();
    expect(button('Deal next hand')!.disabled).toBe(true);
    expect(bodies().at(-1).gate).toEqual({ id: reviewGateId(store().handId!), kind: 'review' });
  });

  it('reviews a hand the player chatted about, even after an obvious fold', async () => {
    filter.obvious = true;
    await startTraining();
    await say('Почему это очевидный фолд?');
    await tick();
    expect(bodies()[0]).toMatchObject({ mode: 'training', gate: null });
    streams[0].end();
    await tick();
    await click('Fold');
    await until(() => store().awaitingNext);
    expect(button('Deal next hand')!.disabled).toBe(true);
    expect(bodies()[1].gate).toEqual({ id: reviewGateId(store().handId!), kind: 'review' });
  });
});
