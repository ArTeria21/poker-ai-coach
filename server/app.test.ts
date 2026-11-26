import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { CoachSnapshot } from '../src/agent/contract';
import { app } from './app';

const model = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => () => model.current }));

const player = (seat: number, name: string, isHero: boolean, position: 'SB' | 'BB') => ({
  seat, name, isHero, botProfile: null, position, stack: 1900, stackBB: 95, streetBet: 0, committedThisHand: 0,
  folded: false, allIn: false, isActing: isHero, eliminated: false, finishPlace: null, shownCards: null, showdownDescription: null, wonThisHand: null,
});
const snapshot: CoachSnapshot = {
  status: 'heroToAct', awaitingNextHand: false, handId: 'sng-test-hand-1', handNumber: 1, street: 'preflop',
  tournament: { smallBlind: 10, bigBlind: 20, bigBlindAnte: 0, level: 1, handsPlayedAtLevel: 0, handsPerLevel: 6, nextLevel: null, playersRemaining: 2, payoutSharesByPlace: [0.65, 0.35] },
  players: [player(0, 'Zorblax', true, 'SB'), player(1, 'Rock', false, 'BB')],
  hero: { name: 'Zorblax', cards: ['Ah', 'Kd'], position: 'SB', stack: 1900, stackBB: 95, effectiveStack: 1900, effectiveStackBB: 95, sprAtStreetStart: null, toCall: 10, eliminated: false, finishPlace: null },
  board: [], pot: 30, potBB: 1.5, currentBet: 20,
  legalActions: { fold: true, check: false, call: { amount: 10, allIn: false }, raise: { minTo: 40, maxTo: 1910 } },
  forcedBets: [], history: [], lastDecisionGrade: null,
};
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const textStream = (text: string) => ({ stream: simulateReadableStream({ chunks: [
  { type: 'text-start' as const, id: 't' },
  { type: 'text-delta' as const, id: 't', delta: text },
  { type: 'text-end' as const, id: 't' },
  { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
] }) });
const userMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Колл или рейз?' }] };
const post = (body: unknown) => app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.stubEnv('OPENROUTER_MODEL', 'test/model');
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/chat', () => {
  it('answers 503 without the OpenRouter env', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const res = await post({ messages: [userMessage], snapshot });
    expect(res.status).toBe(503);
    expect(await res.json()).toHaveProperty('error');
  });

  it('rejects an invalid snapshot, bad messages and system messages with 400', async () => {
    const leaky = { ...snapshot, hero: { ...snapshot.hero, cards: ['Ah', 'XX'] } };
    expect((await post({ messages: [userMessage], snapshot: leaky })).status).toBe(400);
    expect((await post({ messages: [{ role: 'user' }], snapshot })).status).toBe(400);
    expect((await post({ messages: [{ ...userMessage, role: 'system' }], snapshot })).status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    const res = await post({ messages: [{ ...userMessage, parts: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }], snapshot });
    expect(res.status).toBe(413);
  });

  it('streams a UI message stream with the snapshot in the system prompt', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => textStream('Привет') });
    model.current = mock;
    const res = await post({ messages: [userMessage], snapshot });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await res.text()).toContain('"delta":"Привет"');
    const [system, user] = mock.doStreamCalls[0].prompt;
    expect(system.role).toBe('system');
    expect(JSON.stringify(system.content)).toContain('Zorblax');
    expect(JSON.stringify(user.content)).toContain('Колл или рейз?');
    expect(mock.doStreamCalls[0].tools?.map((t) => t.name)).toEqual(['equity', 'range_combos', 'pot_odds', 'outs', 'icm']);
    expect(mock.doStreamCalls[0].providerOptions).toEqual({ openrouter: { reasoning: { effort: 'low' } } });
  });

  it('forces a text answer on the last step when the model keeps calling tools', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async (options) => options.toolChoice?.type === 'none' ? textStream('Итог') : { stream: simulateReadableStream({ chunks: [
        { type: 'tool-call' as const, toolCallId: `c${Math.random()}`, toolName: 'pot_odds', input: '{"potBeforeCall":30,"toCall":10}' },
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
      ] }) },
    });
    model.current = mock;
    const body = await (await post({ messages: [userMessage], snapshot })).text();
    expect(mock.doStreamCalls).toHaveLength(8);
    expect(mock.doStreamCalls[7].toolChoice).toEqual({ type: 'none' });
    expect(body).toContain('"delta":"Итог"');
  });

  it('skips a tool call left without a result by a stopped turn', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
    model.current = mock;
    const stopped = { id: 'a0', role: 'assistant', parts: [{ type: 'tool-equity', toolCallId: 'c0', state: 'input-available', input: { hero: ['Ah', 'Kd'], board: [], opponents: ['random'] } }] };
    const res = await post({ messages: [userMessage, stopped, { ...userMessage, id: 'm2' }], snapshot });
    expect(res.status).toBe(200);
    await res.text();
    expect(mock.doStreamCalls).toHaveLength(1);
  });

  it('rejects file parts and answers 404 JSON for unknown API routes', async () => {
    const file = { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' };
    expect((await post({ messages: [{ ...userMessage, parts: [...userMessage.parts, file] }], snapshot })).status).toBe(400);
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('accepts a follow-up turn with an earlier tool call and windows from a user message', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [] }) }) });
    model.current = mock;
    const assistant = { id: 'a1', role: 'assistant', parts: [
      { type: 'tool-pot_odds', toolCallId: 'c1', state: 'output-available', input: { potBeforeCall: 30, toCall: 10 }, output: { requiredEquity: 0.25 } },
      { type: 'text', text: 'Нужно 25%.' },
    ] };
    const history = Array.from({ length: 12 }, (_, i) => [{ ...userMessage, id: `u${i}`, parts: [{ type: 'text', text: `q${i}` }] }, { ...assistant, id: `a${i}` }]).flat();
    const res = await post({ messages: [...history, { ...userMessage, id: 'last' }], snapshot });
    expect(res.status).toBe(200);
    await res.text();
    const prompt = mock.doStreamCalls[0].prompt;
    expect(prompt[1].role).toBe('user');
    // The last 20 messages start at a2, so the window opens at u3: u0..u2 are dropped.
    const texts = JSON.stringify(prompt.slice(1));
    expect(['"q0"', '"q1"', '"q2"'].some((q) => texts.includes(q))).toBe(false);
    expect(texts).toContain('"q3"');
    expect(prompt.some((m) => m.role === 'tool')).toBe(true);
  });
  describe('Training Mode', () => {
    const decision = { id: 'sng-test-hand-1#0', kind: 'decision' };
    const complete: CoachSnapshot = { ...snapshot, status: 'handComplete', awaitingNextHand: true, legalActions: null };
    const trigger = { id: 't1', role: 'user', metadata: { trigger: 'decision', gateId: decision.id }, parts: [{ type: 'text', text: '[Тренировка] Мой ход: префлоп.' }] };
    const toolNames = async (body: unknown) => {
      const mock = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
      model.current = mock;
      const res = await post(body);
      expect(res.status).toBe(200);
      await res.text();
      return { names: mock.doStreamCalls[0].tools?.map((t) => t.name), system: JSON.stringify(mock.doStreamCalls[0].prompt[0].content) };
    };

    it('offers release_actions only to a gated training request and states the mode', async () => {
      const free = await toolNames({ messages: [userMessage], snapshot, mode: 'free', gate: null });
      expect(free.names).not.toContain('release_actions');
      expect(free.system).toContain('Режим: свободная игра');
      const ungated = await toolNames({ messages: [userMessage], snapshot, mode: 'training', gate: null });
      expect(ungated.names).not.toContain('release_actions');
      expect(ungated.system).toContain('стол не заблокирован');
      const gated = await toolNames({ messages: [trigger], snapshot, mode: 'training', gate: decision });
      expect(gated.names).toContain('release_actions');
      expect(gated.system).toContain('Режим: тренировка');
    });

    it('accepts a review gate on a completed hand and an earlier release in Free Play history', async () => {
      expect((await toolNames({ messages: [trigger], snapshot: complete, mode: 'training', gate: { id: 'sng-test-hand-1#review', kind: 'review' } })).names).toContain('release_actions');
      // A stopped turn leaves the call without output; it must still validate when the tool is not offered.
      const released = { id: 'a1', role: 'assistant', parts: [{ type: 'tool-release_actions', toolCallId: 'r1', state: 'input-available', input: {} }] };
      expect((await toolNames({ messages: [trigger, released, userMessage], snapshot, mode: 'free', gate: null })).names).not.toContain('release_actions');
    });

    it('counts every public action of the hand, the hero\'s own included, and reviews the final hand', async () => {
      const act = (player: string, position: 'SB' | 'BB', action: 'call' | 'check', amountAdded: number) => ({
        street: 'preflop' as const, player, position, action, amountAdded, raiseTo: null, potBefore: 30, toCallBefore: 10, stackBefore: 1990, allIn: false,
      });
      const flop: CoachSnapshot = { ...snapshot, street: 'flop', board: ['2c', '7d', 'Ts'], pot: 40, potBB: 2, currentBet: 0,
        legalActions: { fold: true, check: true, raise: { minTo: 20, maxTo: 1980 } },
        history: [act('Zorblax', 'SB', 'call', 10), act('Rock', 'BB', 'check', 0), { ...act('Rock', 'BB', 'check', 0), street: 'flop' }] };
      const gated = (id: string) => post({ messages: [trigger], snapshot: flop, mode: 'training', gate: { id, kind: 'decision' } });
      model.current = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
      const ok = await gated('sng-test-hand-1#3');
      expect(ok.status).toBe(200);
      await ok.text();
      expect((await gated('sng-test-hand-1#2')).status).toBe(400);
      expect((await gated('sng-test-hand-1#1')).status).toBe(400);
      const last: CoachSnapshot = { ...complete, status: 'tournamentComplete' };
      expect((await toolNames({ messages: [trigger], snapshot: last, mode: 'training', gate: { id: 'sng-test-hand-1#review', kind: 'review' } })).names).toContain('release_actions');
    });

    it('rejects a gate that does not match the snapshot, a gate in Free Play and a bad mode with 400', async () => {
      const reject = async (body: Record<string, unknown>) => {
        const res = await post({ messages: [trigger], snapshot, mode: 'training', ...body });
        expect(res.status).toBe(400);
        return (await res.json() as { error: string }).error;
      };
      expect(await reject({ gate: { id: 'sng-test-hand-1#1', kind: 'decision' } })).toMatch(/does not match/);
      expect(await reject({ gate: { id: 'sng-test-hand-0#0', kind: 'decision' } })).toMatch(/does not match/);
      expect(await reject({ snapshot: complete, gate: decision })).toMatch(/not to act/);
      expect(await reject({ gate: { id: 'sng-test-hand-1#review', kind: 'review' } })).toMatch(/not complete/);
      expect(await reject({ snapshot: complete, gate: { id: 'sng-test-hand-0#review', kind: 'review' } })).toMatch(/does not match/);
      expect(await reject({ snapshot: null, gate: decision })).toMatch(/without a table/);
      expect(await reject({ mode: 'free', gate: decision })).toMatch(/no gate/);
      expect(await reject({ mode: 'coach', gate: null })).toMatch(/mode/);
      expect(await reject({ gate: { id: decision.id, kind: 'hand' } })).toMatch(/gate/);
    });

    it('streams the release output with the request gate id whatever input the model passes', async () => {
      let call = 0;
      const mock = new MockLanguageModelV4({
        doStream: async () => call++ > 0 ? textStream('Открыл') : { stream: simulateReadableStream({ chunks: [
          { type: 'tool-call' as const, toolCallId: 'r1', toolName: 'release_actions', input: '{"gateId":"other-hand#7","id":"x"}' },
          { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
        ] }) },
      });
      model.current = mock;
      const res = await post({ messages: [trigger], snapshot, mode: 'training', gate: decision });
      const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
      expect(events.find((e) => e.type === 'tool-output-available' && e.toolCallId === 'r1')?.output)
        .toMatchObject({ released: 'sng-test-hand-1#0', kind: 'decision' });
      expect(mock.doStreamCalls).toHaveLength(2);
    });
  });
});
