// @vitest-environment happy-dom
import { streamed, tick, until, type Stream } from './appTestKit';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { MemoryOverview } from '../../server/memory';
import { TOPICS, TOPIC_IDS } from '../agent/contract';
import { tableController } from '../app/tableController';
import { gameStore } from '../app/gameStore';
import { useSettingsStore } from '../app/settingsStore';
import { App } from './App';
import { chat, setTrainingMode, stopDiagnosis, useDiagnosisStore } from '../app/coachSession';

const empty: MemoryOverview = { initialized: false, workingState: null, knowledgeMap: null, highlights: { total: 0, entries: [] } };
const populated: MemoryOverview = {
  initialized: true,
  workingState: { raw: '', sections: { workbench: '- Тема: защита BB', studentProfile: '- Уровень: начинающий', conventions: '- Считать в BB' } },
  knowledgeMap: {
    topics: TOPIC_IDS.map((id, index) => ({ id, title: TOPICS[id], status: index % 4, label: ['Not started', 'Theory/Exposed', 'Guided practice', 'Mastered'][index % 4] })),
    bottlenecks: [{ id: 'wide-defense', title: 'Слишком широкая защита', seen: 'hand-1', overcome: ['hand-2', 'hand-3'], target: 3 }],
  },
  highlights: { total: 3, entries: [
    { date: '2026-11-25', handId: 'hand-1', independence: 1, spot: 'Первый спот', takeaway: 'Цена колла' },
    { date: '2026-11-26', handId: 'hand-2', independence: 2, spot: 'Второй спот', takeaway: 'Давление ICM' },
    { date: '2026-11-26', handId: 'hand-3', independence: 3, spot: 'Последний спот', takeaway: 'Защита BB' },
  ] },
};

let container: HTMLDivElement;
let root: Root;
let streams: Stream[];
let status: () => Response | Promise<Response>;
let overview: () => Response | Promise<Response>;
let fetchSpy: MockInstance<typeof fetch>;
const memoryCalls = () => fetchSpy.mock.calls.filter(([url]) => url === '/api/memory');
const statusCalls = () => fetchSpy.mock.calls.filter(([url]) => url === '/api/memory/status');
const chatCalls = () => fetchSpy.mock.calls.filter(([url]) => url === '/api/chat');
const button = (text: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
const click = (text: string, scope: ParentNode = container) => act(() => { const el = button(text, scope); el.focus(); el.click(); });
const mount = () => act(async () => root.render(<App />));
const key = (el: Element, value: string, shiftKey = false) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })));
const drawer = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
const closeButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Close memory drawer"]')!;

beforeEach(() => {
  vi.useFakeTimers();
  gameStore.getState().reset();
  useDiagnosisStore.setState({ initialized: null, resume: null });
  useSettingsStore.setState({ speed: 'fast', soundEnabled: false });
  setTrainingMode('free');
  streams = [];
  status = () => Response.json({ initialized: false });
  overview = () => Response.json(empty);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/memory/status') return status();
    if (url === '/api/memory') return overview();
    if (url === '/api/chat') {
      const stream = streamed();
      streams.push(stream);
      return stream.response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  stopDiagnosis();
  await chat.stop();
  chat.clearError();
  chat.messages = [];
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('landing navigation', () => {
  it('opens on the landing page without dealing or fetching the overview, including Strict Mode', async () => {
    const start = vi.spyOn(tableController, 'startSession');
    await act(async () => root.render(<StrictMode><App /></StrictMode>));
    await tick();
    expect(container.querySelector('h1')?.textContent).toBe('Play the table.Sharpen your edge.');
    expect(container.querySelectorAll('.landing-card')).toHaveLength(3);
    expect(container.querySelectorAll('.landing-flow li')).toHaveLength(3);
    expect(gameStore.getState().handNumber).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(statusCalls()).toHaveLength(1);
    expect(memoryCalls()).toHaveLength(0);
    expect(chatCalls()).toHaveLength(0);
    await click('View Agent Memory');
    expect(memoryCalls()).toHaveLength(1);
  });

  it.each([
    [true, 'Memory active', 'CALIBRATED', 'Re-run Diagnostics'],
    [false, 'New player', 'RECOMMENDED', 'Take Diagnostics'],
    [null, 'Local table', 'LEVEL CHECK', 'Take Diagnostics'],
  ] as const)('renders the %s memory status and appropriate actions', async (initialized, label, badge, action) => {
    status = () => initialized === null ? Promise.reject(new Error('offline')) : Response.json({ initialized });
    await mount();
    expect(button(label)).toBeDefined();
    expect(container.querySelectorAll('.landing-card-badge')[1].textContent).toBe(badge);
    expect(button(action, container.querySelector('.landing-cta-row')!)).toBeDefined();
  });

  it('starts once, returns to the overview, and resumes the same live hand', async () => {
    const start = vi.spyOn(tableController, 'startSession');
    await mount();
    await click('Enter Tournament');
    await until(() => gameStore.getState().heroLegal !== null);
    const { handId, tournament } = gameStore.getState();
    expect(start).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.play-column')?.classList.contains('mobile-pane--hidden')).toBe(false);
    await click('Poker AI-Coach');
    expect(button('Resume Tournament')).toBeDefined();
    expect(button('Resume · Hand #1')).toBeDefined();
    expect(container.querySelector('.landing-card')?.textContent).toContain('Resume Hand #1');
    await click('Resume Tournament');
    expect(gameStore.getState().handId).toBe(handId);
    expect(gameStore.getState().tournament).toBe(tournament);
    expect(start).toHaveBeenCalledTimes(1);
    expect(statusCalls()).toHaveLength(1);
  });

  it.each(['free', 'training'] as const)('starts diagnostics with a valid snapshot and the coach pane from %s mode', async (mode) => {
    setTrainingMode(mode);
    const start = vi.spyOn(tableController, 'startSession');
    await mount();
    await click('Take Diagnostics');
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
    expect(chatCalls()).toHaveLength(1);
    const body = JSON.parse(String(chatCalls()[0][1]?.body));
    expect(body).toMatchObject({ phase: 'diagnosis', mode: 'free', gate: null, snapshot: { handNumber: 1 } });
    expect(body.snapshot.tournament).toBeTruthy();
    expect(useDiagnosisStore.getState().resume).toBe(mode);
    expect(container.querySelector('.coach-chat')?.classList.contains('mobile-pane--hidden')).toBe(false);
    expect(container.querySelector('.play-column')?.classList.contains('mobile-pane--hidden')).toBe(true);
    expect(statusCalls()).toHaveLength(1);
  });

  it('wires the pillar cards and quick-enter navigation to their actions', async () => {
    await mount();
    await act(async () => (container.querySelectorAll('.landing-card')[2] as HTMLButtonElement).click());
    expect(drawer()).not.toBeNull();
    await act(async () => closeButton().click());
    await click('Enter table');
    expect(container.querySelector('.main-row')).not.toBeNull();
    await click('Poker AI-Coach');
    await act(async () => (container.querySelectorAll('.landing-card')[1] as HTMLButtonElement).click());
    await tick();
    expect(chatCalls()).toHaveLength(1);
    expect(useDiagnosisStore.getState().resume).toBe('free');
  });
});

describe('memory drawer', () => {
  it('fetches lazily, shows loading and the empty state, and enters the tournament', async () => {
    let resolve!: (value: Response) => void;
    overview = () => new Promise((done) => { resolve = done; });
    await mount();
    expect(memoryCalls()).toHaveLength(0);
    await click('View Agent Memory');
    expect(drawer().textContent).toContain("Loading Coach Dan's memory…");
    expect(gameStore.getState().handNumber).toBe(0);
    await act(async () => resolve(Response.json(empty)));
    expect(drawer().textContent).toContain("Dan doesn't know your game yet.");
    expect(memoryCalls()).toHaveLength(1);
    await click('Enter Tournament', drawer());
    expect(drawer()).toBeNull();
    expect(gameStore.getState().handNumber).toBe(1);
  });

  it('starts diagnostics from the empty drawer and closes it', async () => {
    await mount();
    await click('New player');
    await click('Take Diagnostics', drawer());
    await tick();
    expect(drawer()).toBeNull();
    expect(useDiagnosisStore.getState().resume).toBe('free');
    expect(JSON.parse(String(chatCalls()[0][1]?.body)).snapshot.handNumber).toBe(1);
  });

  it('renders the structured profile, 12-topic mastery map, bottlenecks and newest highlights first', async () => {
    overview = () => Response.json(populated);
    await mount();
    await click('View Agent Memory');
    expect(drawer().textContent).toContain('Current Workbench');
    for (const text of Object.values(populated.workingState!.sections)) expect(drawer().textContent).toContain(text);
    await click('Knowledge Map', drawer());
    expect(drawer().querySelectorAll('.memory-topic')).toHaveLength(12);
    expect(drawer().querySelector('.memory-bottleneck')?.textContent).toContain('Overcome 2/3');
    expect(drawer().querySelector('.memory-bottleneck [role="meter"]')?.getAttribute('aria-valuenow')).toBe('2');
    expect([...drawer().querySelectorAll('.memory-topic [role="meter"]')].map((el) => el.getAttribute('aria-valuenow'))).toEqual(TOPIC_IDS.map((_, i) => String(i % 4)));
    for (const title of Object.values(TOPICS)) expect(drawer().textContent).toContain(title);
    await click('Highlights', drawer());
    expect([...drawer().querySelectorAll('.memory-highlight h3')].map((el) => el.textContent)).toEqual(['hand-3', 'hand-2', 'hand-1']);
    expect(drawer().textContent).toContain('Independence 3/3');
    expect(drawer().textContent).toContain('Последний спот');
    expect(drawer().textContent).toContain('Защита BB');
    await click('Re-run diagnostics', drawer());
    expect(drawer()).toBeNull();
    expect(useDiagnosisStore.getState().resume).toBe('free');
  });

  it('shows tab-specific empty states and preserves partial memory without a profile', async () => {
    overview = () => Response.json({ ...empty, knowledgeMap: { ...populated.knowledgeMap, bottlenecks: [] } });
    await mount();
    await click('View Agent Memory');
    expect(drawer().textContent).toContain('No student profile saved yet.');
    expect(drawer().textContent).not.toContain("Dan doesn't know your game yet.");
    await click('Knowledge Map', drawer());
    expect(drawer().textContent).toContain('No active bottlenecks tracked right now.');
    await click('Highlights', drawer());
    expect(drawer().textContent).toContain('No hand highlights saved yet. Ask Dan to review an instructive spot during play.');
  });

  it('shows a corrupt map error while the profile and highlights remain available', async () => {
    overview = () => Response.json({ ...populated, knowledgeMap: null, knowledgeMapError: 'knowledge-map.md line 3 is not in the grammar: fix or delete it by hand' });
    await mount();
    await click('View Agent Memory');
    expect(drawer().textContent).toContain('- Тема: защита BB');
    await click('Knowledge Map', drawer());
    expect(drawer().querySelector('[role="alert"]')?.textContent).toContain('line 3 is not in the grammar');
    await click('Highlights', drawer());
    expect(drawer().querySelectorAll('.memory-highlight')).toHaveLength(3);
  });

  it.each(['offline', 'http', 'invalid JSON'])('recovers from %s errors with Retry', async (failure) => {
    overview = () => failure === 'offline' ? Promise.reject(new TypeError('offline'))
      : failure === 'http' ? Response.json({ error: 'unavailable' }, { status: 503 }) : new Response('<html>Unavailable</html>');
    await mount();
    await click('View Agent Memory');
    expect(drawer().querySelector('[role="alert"]')?.textContent).toContain('Could not load memory');
    expect(drawer().textContent).toContain('Make sure the local API server is running, or enter the table to play offline.');
    overview = () => Response.json(populated);
    await click('Retry', drawer());
    expect(drawer().textContent).toContain('- Тема: защита BB');
    expect(memoryCalls()).toHaveLength(2);
  });

  it('restores focus on Escape, close and scrim dismissal; traps focus and supports tab arrow keys', async () => {
    overview = () => Response.json(populated);
    await mount();
    const trigger = button('View Agent Memory');
    // Safari pointer clicks do not focus the trigger before opening the drawer.
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(closeButton());
    expect(container.querySelector('.app')?.hasAttribute('inert')).toBe(true);
    await key(closeButton(), 'Tab', true);
    const panel = drawer().querySelector('[role="tabpanel"]')!;
    expect(document.activeElement).toBe(panel);
    await key(panel, 'Tab');
    expect(document.activeElement).toBe(closeButton());
    await click('Profile', drawer());
    await key(button('Profile', drawer()), 'ArrowRight');
    expect(document.activeElement).toBe(button('Knowledge Map', drawer()));
    expect(button('Knowledge Map', drawer()).getAttribute('aria-selected')).toBe('true');
    await key(button('Knowledge Map', drawer()), 'End');
    expect(document.activeElement).toBe(button('Highlights', drawer()));
    await key(button('Highlights', drawer()), 'Escape');
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('.app')?.hasAttribute('inert')).toBe(false);
    await click('View Agent Memory');
    await act(async () => closeButton().click());
    expect(document.activeElement).toBe(trigger);
    await click('View Agent Memory');
    await act(async () => container.querySelector<HTMLElement>('.memory-drawer-scrim')!.click());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('refreshes on each open and shares the drawer with the Coach header without table hotkeys leaking through', async () => {
    await mount();
    await click('View Agent Memory');
    await act(async () => closeButton().click());
    overview = () => Response.json(populated);
    await click('Enter Tournament');
    await until(() => gameStore.getState().heroLegal !== null);
    await click('Memory');
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(drawer().textContent).toContain('- Тема: защита BB');
    expect(memoryCalls()).toHaveLength(2);
    expect(statusCalls()).toHaveLength(1);
    const action = vi.spyOn(tableController, 'humanAct');
    await key(closeButton(), 'f');
    expect(action).not.toHaveBeenCalled();
    await key(closeButton(), 'Escape');
    expect(document.activeElement).toBe(button('Memory'));
  });

  it('aborts a dismissed request and ignores its late response after reopening', async () => {
    let resolve!: (value: Response) => void;
    overview = () => new Promise((done) => { resolve = done; });
    await mount();
    await click('View Agent Memory');
    const signal = memoryCalls()[0][1]?.signal;
    await key(closeButton(), 'Escape');
    expect(signal?.aborted).toBe(true);
    overview = () => Response.json(populated);
    await click('View Agent Memory');
    await act(async () => resolve(Response.json(empty)));
    expect(drawer().textContent).toContain('- Тема: защита BB');
    expect(useDiagnosisStore.getState().initialized).toBe(true);
  });
});
