// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// Node's own experimental localStorage global (undefined without a file) shadows happy-dom's; the settings store persists to it.
vi.hoisted(() => Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true }));
import { App } from './App';
import { tableController } from '../game/tableController';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';

vi.mock('../game/sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
vi.mock('../bots/botDecision', async (original) => ({
  ...await original<typeof import('../bots/botDecision')>(),
  decideAction: vi.fn((view) => ({ action: { type: view.legal.check ? 'check' : 'call' }, trace: [] })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const store = () => useGameStore.getState();
const tick = () => act(() => vi.advanceTimersByTimeAsync(500));

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ speed: 'fast', soundEnabled: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('plays silently without calling the coach, and sends one request with the snapshot when asked', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'Coach is not configured' }, { status: 503 }));
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(<App initialView="table" />));

  for (let hand = 0; hand < 4; hand++) {
    for (let i = 0; i < 500 && !store().awaitingNext; i++) {
      const legal = store().heroLegal;
      if (legal) act(() => tableController.humanAct({ type: hand % 2 ? 'fold' : legal.check ? 'check' : 'call' }));
      await tick();
    }
    act(() => tableController.continueNextHand());
    await tick();
  }
  expect(store().handNumber).toBeGreaterThanOrEqual(5);
  // The chat mounts with one memory status check (no LLM); silent play adds nothing.
  const chatCalls = () => fetchSpy.mock.calls.filter(([url]) => url !== '/api/memory/status');
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(['/api/memory/status']);

  await act(async () => container.querySelector<HTMLButtonElement>('.chat-example')!.click());
  await tick();
  expect(chatCalls()).toHaveLength(1);
  const [url, init] = chatCalls()[0];
  expect(url).toBe('/api/chat');
  const body = JSON.parse(String(init?.body));
  expect(body.messages).toHaveLength(1);
  expect(body.snapshot?.tournament).toBeTruthy();
  expect(container.querySelector('.chat-error')?.textContent).toContain('Coach is not configured');

  act(() => root.unmount());
  tableController.stop();
});
