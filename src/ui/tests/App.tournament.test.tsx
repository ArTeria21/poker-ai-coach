// @vitest-environment happy-dom
// Whole tournaments through the real App and the real server with a scripted model ("fake Dan"):
// table, Training gates, chat, memory, compaction and error recovery working together.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { handTier } from '../../decision/preflopTiers';

// A whole tournament takes seconds, more under a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

// Node's own experimental localStorage global (undefined without a file) shadows happy-dom's; the settings store persists to it.
vi.hoisted(() => Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true }));
const fake = vi.hoisted(() => ({ model: null as unknown, seed: 0 }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => () => fake.model }));
vi.mock('../../app/sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
// Deterministic deals and bot noise: counter seeds instead of crypto ones, and a fixed button.
vi.mock('../../random', async (original) => ({ ...await original<typeof import('../../random')>(), randomSeed: () => Math.imul(++fake.seed, 2654435761) >>> 0 }));
vi.mock('../../game/tournament', async (original) => {
  const real = await original<typeof import('../../game/tournament')>();
  return { ...real, createTournament: (lineup: Parameters<typeof real.createTournament>[0], _button: number, id: string) => real.createTournament(lineup, 0, id) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Imports the client and the server as a page load and a server start do; after vi.resetModules() it is a restart. */
async function boot() {
  const [{ App }, session, { gameStore }, { useSettingsStore }, { app }] = await Promise.all([
    import('../App'), import('../../app/coachSession'), import('../../app/gameStore'), import('../../app/settingsStore'), import('../../../server/app'),
  ]);
  return { App, session, gameStore, useSettingsStore, server: app };
}

// --- fake Dan ------------------------------------------------------------------------------------------

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
type Part = LanguageModelV4StreamPart;
const finish = (unified: 'stop' | 'tool-calls'): Part => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage });
const words = (t: string): Part[] => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' }];
const text = (t: string): Part[] => [...words(t), finish('stop')];
const toolCalls = (...calls: { name: string; input: object }[]): Part[] => [
  ...calls.map((c, i) => ({ type: 'tool-call' as const, toolCallId: `call_${i}`, toolName: c.name, input: JSON.stringify(c.input) })),
  finish('tool-calls'),
];
const RELEASE = { name: 'release_actions', input: {} };
/** A short answer and the release in one step: the server ends the turn there. */
const answerAndRelease = (): Part[] => [...words('Можно выбрать любое легальное действие.'), ...toolCalls(RELEASE)];

/** One model step as Dan gets it. */
interface Turn {
  tools: string[];
  system: string;
}
/** Parts to stream, or a stream the scenario finishes itself. */
type Reply = Part[] | ReadableStream<Part>;
/** Answers and releases the gate when this request has one; answers other requests in text. */
const defaultDan = (turn: Turn): Reply => turn.tools.includes('release_actions') ? answerAndRelease() : text('Посчитаем шансы банка.');

const dan = {
  script: defaultDan as (turn: Turn) => Reply,
  turns: [] as Turn[],
  summaries: 0,
  /** Open held steps: fake time keeps running while the scenario holds Dan. */
  holding: 0,
};
function fakeDan() {
  return new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      const turn: Turn = {
        tools: options.tools?.map((t) => t.name) ?? [],
        system: JSON.stringify(options.prompt[0].content),
      };
      dan.turns.push(turn);
      const reply = dan.script(turn);
      return { stream: Array.isArray(reply) ? new ReadableStream({ start(c) { reply.forEach((p) => c.enqueue(p)); c.close(); } }) : reply };
    },
    doGenerate: async () => ({ content: [{ type: 'text', text: `Сводка сессии ${++dan.summaries}: разбирали шансы банка.` }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }),
  });
}
/** A model step the scenario streams by hand. */
function held() {
  let ctl!: ReadableStreamDefaultController<Part>;
  const stream = new ReadableStream<Part>({ start: (c) => { ctl = c; } });
  dan.holding++;
  return {
    stream,
    push: (parts: Part[]) => parts.forEach((p) => ctl.enqueue(p)),
    close: () => {
      ctl.close();
      dan.holding--;
    },
  };
}
type Held = ReturnType<typeof held>;

// --- network: the client's fetch is answered by the real server app ----------------------------------

interface Exchange { url: string; body: any; status: number }
const net = {
  log: [] as Exchange[],
  /** Sees each /api/chat body before the server; may answer instead of it (a transport failure). */
  onChat: null as null | ((body: any) => Promise<Response | undefined> | Response | undefined),
};
const chats = () => net.log.filter((e) => e.url === '/api/chat');
const compacts = () => net.log.filter((e) => e.url === '/api/compact');

// --- harness -------------------------------------------------------------------------------------------

let m: Awaited<ReturnType<typeof boot>>;
let container: HTMLDivElement;
let root: Root;
let memoryDir: string;
/** Every gate that locked, in order. */
let lockedGates: string[];
/** Every hero decision the table offered. */
let decisions: { key: string; playersLeft: number; preflop: boolean; check: boolean }[];
let unsubscribe: () => void;

const store = () => m.gameStore.getState();
const training = () => m.session.useTrainingStore.getState();
const locked = () => m.session.lockedGate(training().state);
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
// Async act: the click resolves the controller's pending promise, whose continuation publishes in a microtask.
const press = (el: HTMLElement) => act(async () => el.click());
const click = (label: string) => press(button(label)!);
const actionButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.action-buttons .btn')];
const chatBusy = () => m.session.chat.status === 'submitted' || m.session.chat.status === 'streaming';
const complete = () => container.querySelector('.tournament-panel summary')?.textContent?.includes('Tournament complete') ?? false;
const errorLine = () => container.querySelector('.chat-error');
const hero = () => store().tournament!.players.find((p) => p.isHero)!;

/**
 * Lets Dan's answer finish in real time (the server does file I/O) with fake time standing still, unless the scenario holds a step.
 * The player acts only on a settled chat, so neither his timing nor the table's (and with it the bots' noise) depends on machine speed.
 */
async function settle() {
  for (let i = 0; i < 1000 && chatBusy() && dan.holding === 0; i++) await act(() => new Promise((r) => setImmediate(r)));
}
async function tick() {
  await act(() => vi.advanceTimersByTimeAsync(300));
  await settle();
}

async function mount(mode: 'free' | 'training', seed: number) {
  m = await boot();
  // After the imports: constructing the table controller draws a seed too.
  fake.seed = seed;
  m.useSettingsStore.setState({ speed: 'fast', soundEnabled: false, difficulty: 'easy' });
  m.session.setTrainingMode(mode);
  lockedGates = [];
  decisions = [];
  const offTraining = m.session.useTrainingStore.subscribe(({ state }) => {
    const gate = m.session.lockedGate(state);
    if (gate && lockedGates.at(-1) !== gate.id) lockedGates.push(gate.id);
  });
  const offGame = m.gameStore.subscribe((view, prev) => {
    if (!view.heroLegal || view.heroLegal === prev.heroLegal) return;
    decisions.push({
      key: `${view.handId}#${view.handActions.length}`,
      playersLeft: view.tournament!.players.filter((p) => p.stack > 0).length,
      preflop: view.phase === 'preflop',
      check: view.heroLegal.check,
    });
  });
  unsubscribe = () => { offTraining(); offGame(); };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const exchange: Exchange = { url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, status: 0 };
    net.log.push(exchange);
    try {
      const res = (url === '/api/chat' ? await net.onChat?.(exchange.body) : undefined) ?? await m.server.request(url, init);
      exchange.status = res.status;
      return res;
    } catch (error) {
      exchange.status = -1;
      throw error;
    }
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<m.App initialView="table" />));
}

async function unmount() {
  act(() => root.unmount());
  unsubscribe();
  await m.session.chat.stop();
  m.session.chat.clearError();
  m.session.chat.messages = [];
  m.session.useDiagnosisStore.setState({ resume: null, initialized: null });
  container.remove();
}

/** Types into the chat input the way React notices it and sends. */
async function say(value: string) {
  const el = container.querySelector<HTMLTextAreaElement>('.chat-form textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Send');
}

type Move = 'fold' | 'call' | 'shove';
/** Shoves strong hands, calls medium ones and cheap spots, folds the rest; `loose` widens every threshold. */
const policy = (isLoose: boolean) => (): Move => {
  const s = store();
  const tier = handTier(s.seats.find((x) => x.isHero)!.holeCards!);
  const toCall = s.heroLegal!.call?.amount ?? 0;
  if (s.phase === 'preflop') {
    if (tier <= (isLoose ? 3 : 1)) return 'shove';
    return tier <= (isLoose ? 6 : 4) || toCall === 0 ? 'call' : 'fold';
  }
  if (toCall === 0) return isLoose && s.handNumber % 3 === 0 ? 'shove' : 'call';
  return toCall <= s.pot / (isLoose ? 1 : 3) ? 'call' : 'fold';
};
const tight = policy(false);
const loose = policy(true);

async function heroMove(move: Move) {
  const allIn = [...container.querySelectorAll<HTMLButtonElement>('.raise-presets .preset')].find((b) => b.textContent === 'All-in');
  if (move === 'shove' && allIn) await press(allIn);
  const [fold, call, raise] = actionButtons();
  await press(move === 'fold' ? fold : move === 'shove' && raise ? raise : call);
}

/**
 * The progress invariant: what keeps the session moving now, or null for a hang. The tournament is over, the error line offers
 * recovery, a locked gate has Dan's request in flight (a queued trigger has flushed by the end of a tick), the hero has an enabled
 * action, "Deal next hand" is enabled, or the table plays on (bots acting, the pause between hands; the stall check covers it).
 */
function progress(): 'complete' | 'error' | 'dan' | 'hero' | 'deal' | 'table' | null {
  if (complete()) return 'complete';
  const gate = locked();
  const error = errorLine();
  if (error && !button('Retry')) return null;
  // Nobody else can release the failed request's gate.
  if (gate && error) return training().requestGate?.id === gate.id && !button('Continue without Dan') ? null : 'error';
  if (gate) return chatBusy() ? 'dan' : null;
  if (store().heroLegal) return actionButtons().some((b) => !b.disabled) ? 'hero' : null;
  if (store().awaitingNext) return button('Deal next hand')?.disabled === false ? 'deal' : null;
  return 'table';
}
const describeState = () => JSON.stringify({
  hand: store().handId, phase: store().phase, status: store().status, awaitingNext: store().awaitingNext, heroLegal: !!store().heroLegal,
  training: training().state, requestGate: training().requestGate, chat: m.session.chat.status, error: errorLine()?.textContent ?? null,
});

interface PlayOptions {
  strategy?: () => Move;
  /** Checked before every step; the default plays to the end of the tournament. */
  until?: () => boolean;
  /** Recovers from the error line of a locked gate; the default fails. */
  onError?: () => Promise<void>;
}
/** Plays the hero and deals hands until `until`, checking the progress invariant every tick. */
async function play({ strategy = tight, until = complete, onError }: PlayOptions = {}) {
  let last = '';
  let still = 0;
  for (let i = 0; i < 20_000; i++) {
    if (until()) return;
    const state = progress();
    if (state === null) throw new Error(`Hang: ${describeState()}`);
    if (state === 'complete') throw new Error('Tournament complete before the stop condition');
    const fingerprint = `${describeState()}|${m.session.chat.messages.length}|${m.session.chat.lastMessage?.parts.length}|${m.session.chat.lastMessage?.parts.at(-1)?.type}`;
    still = fingerprint === last ? still + 1 : 0;
    last = fingerprint;
    if (still > 200) throw new Error(`No progress in state ${state}: ${describeState()}`);
    if (state === 'error') {
      if (!onError) throw new Error(`Unexpected chat error: ${describeState()}`);
      await onError();
    } else if (state === 'hero') await heroMove(strategy());
    else if (state === 'deal') await click('Deal next hand');
    await tick();
  }
  throw new Error(`Session did not finish: ${describeState()}`);
}
/** Ticks until `cond`, failing after a while. */
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond(), describeState()).toBe(true);
}

/** Each locked gate got exactly one request, for that gate, and the real server accepted every one. */
function expectOneRequestPerGate() {
  expect(chats().map((e) => e.body.gate?.id)).toEqual(lockedGates);
  expect(chats().every((e) => e.status === 200)).toBe(true);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.stubEnv('OPENROUTER_MODEL', 'test/model');
  memoryDir = await mkdtemp(join(tmpdir(), 'dan-tournament-'));
  vi.stubEnv('MEMORY_DIR', memoryDir);
  fake.model = fakeDan();
  Object.assign(dan, { script: defaultDan, turns: [], summaries: 0, holding: 0 });
  Object.assign(net, { log: [], onChat: null });
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(memoryDir, { recursive: true, force: true });
});

const reviewOf = (handId: string) => `${handId}#review`;
/** Holds the first step of the next request the predicate picks; the scenario streams it later. */
function holdNext(pick: (turn: Turn) => boolean): { step: Held | null } {
  const slot = { step: null as Held | null };
  const before = dan.script;
  dan.script = (turn) => {
    if (slot.step || !pick(turn)) return before(turn);
    slot.step = held();
    return slot.step.stream;
  };
  return slot;
}

it('A. Training to the hero\'s bust, then spectating to the end', async () => {
  // Dan takes his time on the review of the hand the hero busts in.
  let bust: { step: Held | null } | null = null;
  net.onChat = (body) => {
    if (body.gate?.kind === 'review' && body.snapshot.hero.stack === 0) bust = holdNext(() => true);
    return undefined;
  };
  await mount('training', 4000);
  await play({ strategy: loose, until: () => !!bust?.step });
  const bustHand = store().handId!;
  await waitFor(() => store().awaitingNext);
  expect(locked()).toEqual({ id: reviewOf(bustHand), kind: 'review' });
  expect(button('Deal next hand')!.disabled).toBe(true);
  bust!.step!.push(answerAndRelease());
  bust!.step!.close();
  await waitFor(() => button('Deal next hand')?.disabled === false);

  const gatesAtBust = lockedGates.length;
  const requestsAtBust = chats().length;
  // A question in a spectator hand engages it, but a hand without the hero never locks for review.
  await play({ strategy: loose, until: () => store().handId !== bustHand && store().phase === 'preflop' && store().status === 'playing' });
  await say('Кто тут фаворит?');
  await play({ strategy: loose });
  // Spectator hands send nothing by themselves and never lock.
  expect(lockedGates).toHaveLength(gatesAtBust);
  expect(chats().slice(requestsAtBust).map((e) => [e.body.gate, e.status])).toEqual([[null, 200]]);
  expect(chats().slice(0, requestsAtBust).map((e) => e.body.gate?.id)).toEqual(lockedGates);
  expect(new Set(lockedGates).size).toBe(lockedGates.length);
  const place = hero().place!;
  expect(place).toBeGreaterThan(2);
  expect(place).toBeLessThan(6);
  // The review saw the settled result: the bust and the place.
  expect(chats().find((e) => e.body.gate?.id === reviewOf(bustHand))!.body.snapshot.hero).toMatchObject({ eliminated: true, finishPlace: place });
  expect(container.querySelector('.spectator-note')?.textContent).toBe(`You finished #${place}. `);
  expect(container.querySelector('.standings-hero td')?.textContent).toBe(String(place));
  expect(container.textContent).toContain('Final standings');
});

it('B. Training through heads-up to the end, then a clean new SNG', async () => {
  await mount('training', 15016);
  await play();
  expect(hero().place).toBe(1);
  // Heads-up the filter skips only a free check with offsuit tier-8 junk deeper than 15 BB; postflop always locks.
  const headsUp = decisions.filter((d) => d.playersLeft === 2 && !(d.preflop && d.check));
  expect(headsUp.length).toBeGreaterThan(0);
  expect(headsUp.filter((d) => !lockedGates.includes(d.key))).toEqual([]);
  expectOneRequestPerGate();
  const final = chats().at(-1)!;
  expect(final.body.gate).toEqual({ id: reviewOf(store().handId!), kind: 'review' });
  expect(final.body.snapshot.status).toBe('tournamentComplete');
  expect(final.body.snapshot.hero.finishPlace).toBe(1);
  await waitFor(() => !chatBusy() && !locked());

  const oldTournament = store().tournament!.id;
  await click('New SNG');
  expect(training().state).toMatchObject({ mode: 'training', gate: null });
  expect(locked()).toBeNull();
  const before = lockedGates.length;
  await play({ until: () => lockedGates.length > before });
  const gate = lockedGates.at(-1)!;
  expect(gate.startsWith(`${store().tournament!.id}-hand-`)).toBe(true);
  expect(store().tournament!.id).not.toBe(oldTournament);
  await waitFor(() => chats().length === before + 1);
  expect(chats().at(-1)!.body.gate.id).toBe(gate);
  await waitFor(() => !chatBusy());
  expect(chats().at(-1)!.status).toBe(200);
});

it('C. Free Play: silent play calls nobody, a question is one request, Training locks from the next trigger, Free unlocks', async () => {
  await mount('free', 2000);
  await play({ strategy: loose });
  expect(chats()).toHaveLength(0);

  await click('New SNG');
  await play({ until: () => store().handNumber >= 3 && !!store().heroLegal });
  // The answer streams while the table plays on.
  const question = holdNext(() => true);
  await say('Как считать шансы банка?');
  await play({ until: () => !!question.step });
  expect(chats()).toHaveLength(1);
  expect(chats()[0].body).toMatchObject({ mode: 'free', gate: null });
  const hand = store().handNumber;
  await play({ until: () => store().handNumber >= hand + 2 });
  question.step!.push(text('Делим колл на банк после колла.'));
  question.step!.close();
  await play({ until: () => !chatBusy() && store().handNumber >= hand + 3 });
  expect(chats()).toHaveLength(1);
  expect(lockedGates).toEqual([]);

  // Switched on the hero's turn: this decision is already handled, the next trigger locks.
  await play({ until: () => !!store().heroLegal });
  await click('training');
  expect(locked()).toBeNull();
  const trigger = holdNext((turn) => turn.tools.includes('release_actions'));
  await play({ until: () => !!trigger.step });
  expect(lockedGates).toHaveLength(1);
  expect(locked()?.id).toBe(lockedGates[0]);
  expect(chats()).toHaveLength(2);
  expect(chats()[1].body.gate.id).toBe(lockedGates[0]);

  await click('free');
  expect(locked()).toBeNull();
  trigger.step!.push(text('Что думаешь?'));
  trigger.step!.close();
  await play({ strategy: loose });
  expect(chats()).toHaveLength(2);
  expect(lockedGates).toHaveLength(1);
});

it('D. Training survives a failed fetch, a 5xx and a broken stream; a late release never unlocks another gate', async () => {
  const errors: string[] = [];
  let late: { gate: string; slot: { step: Held | null } } | null = null;
  net.onChat = (body) => {
    const n = chats().length;
    if (n === 3) return Promise.reject(new TypeError('Failed to fetch'));
    if (n === 6) {
      // The real server without its key: 503.
      vi.stubEnv('OPENROUTER_API_KEY', '');
      return Promise.resolve(m.server.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
        .finally(() => vi.stubEnv('OPENROUTER_API_KEY', 'test-key'));
    }
    if (n === 9) {
      const before = dan.script;
      dan.script = () => {
        dan.script = before;
        return [...words('Смотри, '), { type: 'error', error: new Error('upstream reset') }];
      };
    }
    // Dan is slow on this decision; his release comes after the player has moved on to another gate.
    if (n >= 12 && !late && body.gate?.kind === 'decision') late = { gate: body.gate.id, slot: holdNext(() => true) };
    return undefined;
  };
  const recover = async () => {
    errors.push(errorLine()!.textContent!);
    expect(button('Retry')).toBeDefined();
    expect(button('Continue without Dan')).toBeDefined();
    await click(errors.length === 2 ? 'Continue without Dan' : 'Retry');
  };
  await mount('training', 27000);
  await play({ onError: recover, until: () => !!late?.slot.step });
  // Free Play skips the slow gate; back in Training the next trigger locks and queues behind the open answer.
  await click('free');
  await play({ until: () => !store().heroLegal });
  await click('training');
  await play({ until: () => locked() !== null });
  expect(errors).toEqual([
    expect.stringContaining('Lost connection to the coach server.'),
    expect.stringContaining('Coach is not configured'),
    expect.stringContaining('Coach could not answer right now'),
  ]);
  const next = locked()!.id;
  expect(next).not.toBe(late!.gate);
  const requests = chats().length;
  // Dan holds the next gate's answer too, so only the late release can touch the lock.
  const queued = holdNext(() => true);
  late!.slot.step!.push(answerAndRelease());
  late!.slot.step!.close();
  await waitFor(() => !!queued.step);
  expect(m.session.chat.messages.flatMap((msg) => msg.parts)
    .some((p) => p.type === 'tool-release_actions' && p.state === 'output-available' && p.output.released === late!.gate)).toBe(true);
  expect(locked()?.id).toBe(next);
  expect(chats()).toHaveLength(requests + 1);
  expect(chats().at(-1)!.body.gate.id).toBe(next);
  queued.step!.push(answerAndRelease());
  queued.step!.close();

  await play({ onError: recover });
  expect(errors).toHaveLength(3);
  expect(chats().filter((e) => e.status !== 200).map((e) => e.status)).toEqual([-1, 503]);
});

it('E. Memory Dan writes during a tournament survives a restart of the client and the server', async () => {
  const workingState = '## Current Workbench\nТема: шансы банка на ривере.\n## Conventions\nШансы банка = колл / (банк + колл).\n## Student Profile\nУровень: начинающий.\n';
  let wrote = false;
  dan.script = (turn) => {
    if (wrote || !turn.tools.includes('release_actions')) return defaultDan(turn);
    wrote = true;
    return [...words('Запомнил.'), ...toolCalls(
      { name: 'write_working_state', input: { markdown: workingState } },
      { name: 'update_knowledge_map', input: { ops: [{ op: 'set_topic', topic: 'pot-odds', status: 2 }, { op: 'add', id: 'ignores-raise-size', title: 'Защищает BB, не глядя на размер рейза' }] } },
      RELEASE,
    )];
  };
  await mount('training', 5000);
  await waitFor(() => m.session.useDiagnosisStore.getState().initialized === false);
  expect(button('Пройти диагностику')).toBeDefined();
  await play({ until: () => store().handNumber >= 4 });
  expect(wrote).toBe(true);
  expect(m.session.chat.messages.flatMap((msg) => msg.parts).filter((p) => 'output' in p && p.output && typeof p.output === 'object' && 'error' in p.output)).toEqual([]);

  // A page reload and a server restart: every module, store and chat starts over; only the memory directory stays.
  await unmount();
  vi.resetModules();
  const turnsBefore = dan.turns.length;
  const oldChat = m.session.chat;
  const oldServer = m.server;
  await mount('training', 6000);
  expect(m.session.chat).not.toBe(oldChat);
  expect(m.server).not.toBe(oldServer);
  expect(m.session.chat.messages).toEqual([]);
  await waitFor(() => m.session.useDiagnosisStore.getState().initialized === true);
  expect(net.log.filter((e) => e.url === '/api/memory/status').map((e) => e.status)).toEqual([200, 200]);
  expect(button('Пройти диагностику')).toBeUndefined();
  await play({ until: () => dan.turns.length > turnsBefore });
  const system = dan.turns[turnsBefore].system;
  expect(system).toContain('Тема: шансы банка на ривере.');
  expect(system).toContain('ignores-raise-size');
  await play();
});

it('F. A long Training tournament folds its chat through /api/compact and keeps gating across the fold', async () => {
  await mount('training', 39000);
  await play();
  expectOneRequestPerGate();
  const folds = compacts();
  expect(folds.length).toBeGreaterThan(1);
  expect(folds.every((e) => e.status === 200)).toBe(true);
  expect(folds[0].body.summary).toBeNull();
  // Each fold merges the previous summary.
  expect(folds[1].body.summary).toBe('Сводка сессии 1: разбирали шансы банка.');
  const first = chats().findIndex((e) => e.body.summary !== null);
  expect(chats()[first].body.summary).toBe('Сводка сессии 1: разбирали шансы банка.');
  // The folded messages are no longer sent.
  expect(chats()[first].body.messages.length).toBeLessThan(chats()[first - 1].body.messages.length);
  // Gates locked after the fold were served like the ones before it.
  expect(first).toBeLessThan(chats().length - 5);
  expect(chats().slice(first).every((e) => e.body.summary !== null)).toBe(true);
  expect(dan.turns.some((t) => t.system.includes('Сводка сессии 1: разбирали шансы банка.'))).toBe(true);
  const sent = chats().slice(first).map((e) => Number(/Сводка сессии (\d+)/.exec(e.body.summary)![1]));
  expect(sent).toEqual([...sent].sort((a, b) => a - b));
  expect(sent.at(-1)).toBeGreaterThan(1);
});
