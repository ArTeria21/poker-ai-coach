import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { CoachSnapshot } from '../src/agent/contract';
import { app } from './app';

const model = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => () => model.current }));

const player = (seat: number, name: string, isHero: boolean, position: 'SB' | 'BB') => ({
  seat, name, isHero, position, stack: 1900, stackBB: 95, streetBet: 0, committedThisHand: 0,
  folded: false, allIn: false, isActing: isHero, eliminated: false, finishPlace: null, shownCards: null, showdownDescription: null, wonThisHand: null,
});
const snapshot: CoachSnapshot = {
  status: 'heroToAct', awaitingNextHand: false, handId: 'sng-test-hand-1', handNumber: 1, street: 'preflop',
  tournament: { smallBlind: 10, bigBlind: 20, bigBlindAnte: 0, level: 1, handsPlayedAtLevel: 0, handsPerLevel: 6, nextLevel: null, playersRemaining: 2, payoutSharesByPlace: [0.65, 0.35] },
  players: [player(0, 'Zorblax', true, 'SB'), player(1, 'Lena', false, 'BB')],
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

let memoryDir = '';
beforeEach(async () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.stubEnv('OPENROUTER_MODEL', 'test/model');
  memoryDir = await mkdtemp(join(tmpdir(), 'dan-app-memory-'));
  vi.stubEnv('MEMORY_DIR', memoryDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(memoryDir, { recursive: true, force: true });
});

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
    expect(mock.doStreamCalls[0].tools?.map((t) => t.name)).toEqual(['equity', 'range_combos', 'pot_odds', 'shove_ev', 'outs', 'icm', 'write_working_state', 'update_knowledge_map', 'append_highlight', 'read_highlights']);
    expect(JSON.stringify(system.content)).toContain('Память об ученике пуста');
    expect(mock.doStreamCalls[0].providerOptions).toEqual({ openrouter: { reasoning: { effort: 'low' } } });
  });

  it('strips unknown snapshot keys: they never reach the prompt', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => textStream('Привет') });
    model.current = mock;
    const extra = { ...snapshot, players: snapshot.players.map((p) => ({ ...p, unknownKey: 'Folds everything.' })) };
    const res = await post({ messages: [userMessage], snapshot: extra });
    expect(res.status).toBe(200);
    await res.text();
    const system = JSON.stringify(mock.doStreamCalls[0].prompt[0].content);
    expect(system).not.toContain('unknownKey');
    expect(system).not.toContain('Folds everything.');
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

  it('accepts a follow-up turn with an earlier tool call and caps the unfolded messages from a user message', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [] }) }) });
    model.current = mock;
    const assistant = { id: 'a1', role: 'assistant', parts: [
      { type: 'tool-pot_odds', toolCallId: 'c1', state: 'output-available', input: { potBeforeCall: 30, toCall: 10 }, output: { requiredEquity: 0.25 } },
      { type: 'text', text: 'Нужно 25%.' },
    ] };
    const history = Array.from({ length: 22 }, (_, i) => [{ ...userMessage, id: `u${i}`, parts: [{ type: 'text', text: `q${i}` }] }, { ...assistant, id: `a${i}` }]).flat();
    const res = await post({ messages: [...history, { ...userMessage, id: 'last' }], snapshot });
    expect(res.status).toBe(200);
    await res.text();
    const prompt = mock.doStreamCalls[0].prompt;
    expect(prompt[1].role).toBe('user');
    // The last 40 messages start at a2, so the window opens at u3: u0..u2 are dropped.
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
      expect(free.system).toContain('120–200 слов');
      const ungated = await toolNames({ messages: [userMessage], snapshot, mode: 'training', gate: null });
      expect(ungated.names).not.toContain('release_actions');
      expect(ungated.system).toContain('стол не заблокирован');
      const gated = await toolNames({ messages: [trigger], snapshot, mode: 'training', gate: decision });
      expect(gated.names).toContain('release_actions');
      expect(gated.system).toContain('Режим: тренировка');
    });

    it('accepts a review gate on a completed hand and an earlier release in Free Play history', async () => {
      const review = await toolNames({ messages: [trigger], snapshot: complete, mode: 'training', gate: { id: 'sng-test-hand-1#review', kind: 'review' } });
      expect(review.names).toContain('release_actions');
      // Memory upkeep is asked for at the review, not at a decision.
      expect(review.system).toContain('Перед release_actions реши, что эта раздача меняет в памяти');
      expect(review.system).toContain('после последней раздачи героя в турнире (вылет или конец турнира)');
      expect((await toolNames({ messages: [trigger], snapshot, mode: 'training', gate: decision })).system).not.toContain('меняет в памяти');
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
        history: [act('Zorblax', 'SB', 'call', 10), act('Lena', 'BB', 'check', 0), { ...act('Lena', 'BB', 'check', 0), street: 'flop' }] };
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

    /** A model whose steps stream the given chunks in turn, then answer in text. */
    const scripted = (...steps: LanguageModelV4StreamPart[][]) => {
      let step = 0;
      return new MockLanguageModelV4({ doStream: async () => step < steps.length ? { stream: simulateReadableStream({ chunks: steps[step++] }) } : textStream('Итог') });
    };
    const call = (toolCallId: string, toolName: string, input: unknown) =>
      ({ type: 'tool-call' as const, toolCallId, toolName, input: typeof input === 'string' ? input : JSON.stringify(input) });
    const said = (text: string): LanguageModelV4StreamPart[] => [
      { type: 'text-start', id: 's' }, { type: 'text-delta', id: 's', delta: text }, { type: 'text-end', id: 's' },
    ];
    const toolsDone: LanguageModelV4StreamPart = { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage };
    const events = async (res: Response) => (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    const released = { id: 'a0', role: 'assistant', parts: [{ type: 'tool-release_actions', toolCallId: 'r0', state: 'output-available', input: {}, output: { released: 'sng-test-hand-1#0', kind: 'decision' } }] };

    it('streams the release output with the request gate id whatever input the model passes, and writes an answer after a bare release', async () => {
      const mock = scripted([call('r1', 'release_actions', { gateId: 'other-hand#7', id: 'x' }), toolsDone]);
      model.current = mock;
      const out = await events(await post({ messages: [trigger], snapshot, mode: 'training', gate: decision }));
      expect(out.find((e) => e.type === 'tool-output-available' && e.toolCallId === 'r1')?.output)
        .toMatchObject({ released: 'sng-test-hand-1#0', kind: 'decision' });
      expect(mock.doStreamCalls).toHaveLength(2);
      expect(out.some((e) => e.delta === 'Итог')).toBe(true);
    });

    it('ends the turn at a successful release with an answer: the memory call in the same step runs and streams, one model call', async () => {
      const mock = scripted([...said('Разумно, играй.'), call('w1', 'write_working_state', { markdown: '## Current Workbench\n- a\n## Conventions\n- b\n## Student Profile\n- c' }), call('r1', 'release_actions', {}), toolsDone]);
      model.current = mock;
      const out = await events(await post({ messages: [trigger], snapshot, mode: 'training', gate: decision }));
      expect(mock.doStreamCalls).toHaveLength(1);
      const outputs = out.filter((e) => e.type === 'tool-output-available');
      expect(outputs.map((e) => e.toolCallId).sort()).toEqual(['r1', 'w1']);
      expect(await readFile(join(memoryDir, 'working-state.md'), 'utf8')).toContain('## Student Profile');
      expect(out.at(-1)?.type).toBe('finish');
    });

    it('gives Dan another step when a release fails or another call in its step fails', async () => {
      const second = async (body: unknown, step: LanguageModelV4StreamPart[]) => {
        const mock = scripted([...said('Смотри.'), ...step, toolsDone]);
        model.current = mock;
        const out = await events(await post(body));
        expect(mock.doStreamCalls).toHaveLength(2);
        expect(out.some((e) => e.delta === 'Итог')).toBe(true);
      };
      // Not offered in Free Play, though earlier releases are in the history.
      await second({ messages: [trigger, released, userMessage], snapshot, mode: 'free', gate: null }, [call('r1', 'release_actions', {})]);
      // Input that is not even JSON.
      await second({ messages: [trigger], snapshot, mode: 'training', gate: decision }, [call('r1', 'release_actions', '{"oops')]);
      // A memory write the server refuses: Dan must see its error.
      await second({ messages: [trigger], snapshot, mode: 'training', gate: decision }, [call('w1', 'write_working_state', { markdown: 'no sections' }), call('r1', 'release_actions', {})]);
    });
  });

  it('injects the session summary fenced into the system prompt and rejects an oversized one', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
    model.current = mock;
    const res = await post({ messages: [userMessage], snapshot, summary: '## Текущий момент\n- ждём ответ про колл' });
    expect(res.status).toBe(200);
    await res.text();
    const system = JSON.stringify(mock.doStreamCalls[0].prompt[0].content);
    expect(system).toContain('Сводка ранней части этой сессии');
    expect(system).toContain('<session-summary>\\n## Текущий момент\\n- ждём ответ про колл\\n</session-summary>');
    expect((await post({ messages: [userMessage], snapshot, summary: 'x'.repeat(6001) })).status).toBe(400);
    expect((await post({ messages: [userMessage], snapshot, summary: 42 })).status).toBe(400);
  });

  describe('memory', () => {
    const toolCallThenText = (calls: { id: string; name: string; input: unknown }[]) => {
      let step = 0;
      return new MockLanguageModelV4({
        doStream: async () => step++ > 0 ? textStream('Запомнил') : { stream: simulateReadableStream({ chunks: [
          ...calls.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input) })),
          { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
        ] }) },
      });
    };
    const outputs = async (res: Response) => Object.fromEntries((await res.text()).split('\n').filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; toolCallId?: string; output?: unknown })
      .filter((e) => e.type === 'tool-output-available').map((e) => [e.toolCallId, e.output]));
    const status = async () => (await app.request('/api/memory/status')).json();
    const workingState = '## Current Workbench\n- Тема: защита BB\n## Conventions\n- Требуемое эквити = колл / (банк + колл)\n## Student Profile\n- Уровень: средний';

    it('records memory with the snapshot hand id whatever the model passes, and injects it into the next prompt', async () => {
      model.current = toolCallThenText([
        { id: 'w1', name: 'write_working_state', input: { markdown: workingState } },
        { id: 'k1', name: 'update_knowledge_map', input: { ops: [{ op: 'add', id: 'ignores-raise-size', title: 'Игнорирует размер рейза при защите BB' }] } },
        { id: 'h1', name: 'append_highlight', input: { spot: 'BB против 3x', independence: 1, takeaway: 'Цена колла зависит от размера рейза', handId: 'junk-hand' } },
      ]);
      expect(await status()).toEqual({ initialized: false });
      const out = await outputs(await post({ messages: [userMessage], snapshot }));
      expect(out.w1).toEqual({ saved: true, lines: 6 });
      expect(out.h1).toEqual({ saved: true, handId: 'sng-test-hand-1' });
      expect(await status()).toEqual({ initialized: true });
      expect(await readFile(join(memoryDir, 'highlights.md'), 'utf8')).toContain(' · sng-test-hand-1 · independence 1/3');

      model.current = toolCallThenText([
        { id: 'o1', name: 'update_knowledge_map', input: { ops: [{ op: 'overcome', id: 'ignores-raise-size', handId: 'junk-hand' }] } },
        { id: 'o2', name: 'update_knowledge_map', input: { ops: [{ op: 'overcome', id: 'ignores-raise-size' }] } },
        { id: 'h2', name: 'append_highlight', input: { spot: 'x', independence: 3, takeaway: 'y' } },
        { id: 'bad', name: 'write_working_state', input: { markdown: '## Current Workbench\n- x' } },
      ]);
      const out2 = await outputs(await post({ messages: [userMessage], snapshot: { ...snapshot, handId: 'sng-test-hand-2' } }));
      expect(out2.o1).toEqual({ results: ['ignores-raise-size: overcome 1/3'] });
      expect(out2.o2).toEqual({ error: expect.stringMatching(/hand sng-test-hand-2 already counted/) });
      expect(out2.h2).toEqual({ saved: true, handId: 'sng-test-hand-2' });
      expect(out2.bad).toEqual({ error: expect.stringMatching(/exactly the sections/) });
      const map = await readFile(join(memoryDir, 'knowledge-map.md'), 'utf8');
      expect(map).toContain('| seen sng-test-hand-1 | overcome 1/3: sng-test-hand-2');
      expect(map).not.toContain('junk');

      const mock = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
      model.current = mock;
      await (await post({ messages: [userMessage], snapshot: null })).text();
      const system = JSON.stringify(mock.doStreamCalls[0].prompt[0].content);
      expect(system).toContain('<working-state>\\n## Current Workbench\\n- Тема: защита BB');
      expect(system).toContain('- ignores-raise-size: Игнорирует размер рейза при защите BB | seen sng-test-hand-1 | overcome 1/3: sng-test-hand-2');
      expect(system).not.toContain('Память об ученике пуста');
    });

    it('refuses hand-bound memory without a table and validates memory tool parts in history', async () => {
      model.current = toolCallThenText([{ id: 'h1', name: 'append_highlight', input: { spot: 'x', independence: 2, takeaway: 'y' } }]);
      expect((await outputs(await post({ messages: [userMessage], snapshot: null }))).h1).toEqual({ error: expect.stringMatching(/No hand on the table/) });
      const earlier = { id: 'a1', role: 'assistant', parts: [
        { type: 'tool-update_knowledge_map', toolCallId: 'k0', state: 'output-available', input: { ops: [{ op: 'set_topic', topic: 'pot-odds', status: 1 }] }, output: { results: [] } },
        { type: 'tool-read_highlights', toolCallId: 'r0', state: 'input-available', input: {} },
      ] };
      model.current = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
      expect((await post({ messages: [userMessage, earlier, { ...userMessage, id: 'm2' }], snapshot })).status).toBe(200);
      const invalid = { ...earlier, parts: [{ ...earlier.parts[0], input: { ops: [{ op: 'set_topic', topic: 'river-art', status: 1 }] } }] };
      expect((await post({ messages: [userMessage, invalid, { ...userMessage, id: 'm2' }], snapshot })).status).toBe(400);
    });
  });
});

describe('level diagnosis', () => {
  const start = { id: 'd0', role: 'user', parts: [{ type: 'text', text: '[Диагностика] Начать диагностику уровня.' }] };
  const probeInput = {
    question: 'Сколько эквити нужно для колла?', context: 'Ривер, банк 300, ставка 150.',
    options: [{ label: '25%', value: 'a' }, { label: '33%', value: 'b' }, { label: '50%', value: 'c' }],
    explanation: '150 / 600 = 25%.', correctAnswer: 'a',
  };
  const workingState = '## Current Workbench\n- Тема: pot-odds, начать со спотов на ривере\n## Conventions\n- пока нет\n## Student Profile\n- Уровень: начинающий, цель: SNG микролимиты';
  const doneInput = {
    assessment: { strands: [{ strand: 'pot-odds', assessment: 'Считает шансы банка, но забывает свой колл.' }], summary: 'Цель: SNG; начать с шансов банка.' },
    topicStatuses: [{ topic: 'pot-odds', status: 1 }],
    bottlenecks: [{ id: 'forgets-own-call', title: 'Забывает свой колл в итоговом банке' }],
    workingState,
  };
  const stepCalls = (calls: { id: string; name: string; input: unknown }[]) => {
    let step = 0;
    return new MockLanguageModelV4({
      doStream: async () => step++ > 0 ? textStream('Начнём с шансов банка.') : { stream: simulateReadableStream({ chunks: [
        ...calls.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input) })),
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
      ] }) },
    });
  };
  const events = async (res: Response) => (await res.text()).split('\n').filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; toolCallId?: string; output?: unknown; errorText?: string });
  const outputOf = (list: Awaited<ReturnType<typeof events>>, id: string) => list.find((e) => e.type === 'tool-output-available' && e.toolCallId === id)?.output;
  const answered = (output: unknown) => ({ id: 'a1', role: 'assistant', parts: [{ type: 'tool-probe', toolCallId: 'p1', state: 'output-available', input: probeInput, output }] });
  const done = (output: unknown) => ({ id: 'a2', role: 'assistant', parts: [{ type: 'tool-diagnosis_done', toolCallId: 'dd', state: 'output-available', input: doneInput, output }] });
  const exists = (file: string) => readFile(join(memoryDir, file), 'utf8').then(() => true, () => false);

  it('switches the prompt and tools, and rejects a gate in the diagnosis phase', async () => {
    const mock = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
    model.current = mock;
    const res = await post({ messages: [start], snapshot, mode: 'training', phase: 'diagnosis' });
    expect(res.status).toBe(200);
    await res.text();
    const call = mock.doStreamCalls[0];
    expect(call.tools?.map((t) => t.name)).toEqual(['equity', 'range_combos', 'pot_odds', 'shove_ev', 'outs', 'icm', 'ask_user_question', 'probe', 'diagnosis_done']);
    // The model writes arguments in schema order: the explanation is committed before the answer.
    const probe = call.tools?.find((t) => t.name === 'probe') as { description?: string; inputSchema: { properties: object } };
    expect(Object.keys(probe.inputSchema.properties)).toEqual(['question', 'context', 'options', 'multiSelect', 'explanation', 'correctAnswer']);
    expect(probe.description).toContain('"correctAnswer": "call"');
    const system = JSON.stringify(call.prompt[0].content);
    expect(system).toContain('Режим: диагностика уровня');
    expect(system).toContain('Память об ученике пуста');
    expect(system).not.toContain('Сократический стиль:');
    expect(system).not.toContain('120–200 слов');
    expect(system).not.toContain('write_working_state');
    expect((await post({ messages: [start], snapshot, mode: 'training', gate: { id: 'sng-test-hand-1#0', kind: 'decision' }, phase: 'diagnosis' })).status).toBe(400);
    expect((await post({ messages: [start], snapshot, phase: 'exam' })).status).toBe(400);
  });

  it('ends the stream at a client question call without an output', async () => {
    const mock = stepCalls([{ id: 'p1', name: 'probe', input: probeInput }]);
    model.current = mock;
    const list = await events(await post({ messages: [start], snapshot, phase: 'diagnosis' }));
    expect(list.find((e) => e.type === 'tool-input-available' && e.toolCallId === 'p1')).toBeTruthy();
    expect(list.some((e) => e.type.startsWith('tool-output') && e.toolCallId === 'p1')).toBe(false);
    expect(mock.doStreamCalls).toHaveLength(1);
  });

  it('returns an ungradeable probe to the model as a tool error', async () => {
    const mock = stepCalls([{ id: 'p1', name: 'probe', input: { ...probeInput, correctAnswer: ['a', 'zz'] } }]);
    model.current = mock;
    const list = await events(await post({ messages: [start], snapshot, phase: 'diagnosis' }));
    const error = list.find((e) => e.type === 'tool-input-error' || e.type === 'tool-output-error');
    expect(error?.errorText).toMatch(/correctAnswer \\"zz\\" does not match any option value/);
    expect(error?.errorText).toMatch(/multiSelect/);
    expect(mock.doStreamCalls).toHaveLength(2);
  });

  it('returns ask_user_question options with duplicate values to the model as a tool error', async () => {
    const mock = stepCalls([{ id: 'q1', name: 'ask_user_question', input: { question: 'Формат?', options: [{ label: 'SNG' }, { label: 'MTT', value: 'SNG' }] } }]);
    model.current = mock;
    const list = await events(await post({ messages: [start], snapshot, phase: 'diagnosis' }));
    expect(list.find((e) => e.type === 'tool-input-error' || e.type === 'tool-output-error')?.errorText).toMatch(/options must be distinct/);
    expect(mock.doStreamCalls).toHaveLength(2);
  });

  it('validates the answer records in history and passes them to the model', async () => {
    const record = { optionOrder: { A: 2, B: 1, C: 3 }, answers: [{ index: 2, label: '25%', letter: 'B' }], correct: true, confidence: 70, thinking: '150 из 600' };
    const mock = new MockLanguageModelV4({ doStream: async () => textStream('ok') });
    model.current = mock;
    const res = await post({ messages: [start, answered(record)], snapshot, phase: 'diagnosis' });
    expect(res.status).toBe(200);
    await res.text();
    expect(JSON.stringify(mock.doStreamCalls[0].prompt)).toContain('150 из 600');
    for (const bad of [{ ...record, confidence: 55 }, { ...record, extra: 'x' }, { dontKnow: true, confidence: 50 }, { thinking: 'only' }]) {
      expect((await post({ messages: [start, answered(bad)], snapshot, phase: 'diagnosis' })).status).toBe(400);
    }
    expect((await post({ messages: [start, answered({ dontKnow: true })], snapshot, phase: 'diagnosis' })).status).toBe(200);
    const ask = (output: unknown) => ({ id: 'a1', role: 'assistant', parts: [{ type: 'tool-ask_user_question', toolCallId: 'q1', state: 'output-available', input: { question: 'Какой формат?' }, output }] });
    expect((await post({ messages: [start, ask({ text: 'SNG' })], snapshot, phase: 'diagnosis' })).status).toBe(200);
    expect((await post({ messages: [start, ask({ thinking: 'только мысли' })], snapshot, phase: 'diagnosis' })).status).toBe(400);
    // Free Play after the diagnosis still accepts its parts in history.
    expect((await post({ messages: [start, answered(record), done({ saved: true, note: 'ok' }), userMessage], snapshot })).status).toBe(200);
  });

  it('saves the assessment into memory once and acknowledges it', async () => {
    model.current = stepCalls([{ id: 'dd', name: 'diagnosis_done', input: doneInput }, { id: 'dd2', name: 'diagnosis_done', input: doneInput }]);
    const list = await events(await post({ messages: [start, answered({ dontKnow: true })], snapshot, phase: 'diagnosis' }));
    expect(outputOf(list, 'dd')).toEqual({ saved: true, note: expect.stringMatching(/^Оценка записана/) });
    expect(outputOf(list, 'dd2')).toEqual({ error: expect.stringMatching(/running or already succeeded/) });
    expect(await readFile(join(memoryDir, 'working-state.md'), 'utf8')).toContain('цель: SNG микролимиты');
    const map = await readFile(join(memoryDir, 'knowledge-map.md'), 'utf8');
    expect(map).toContain('- pot-odds [1: Theory/Exposed]');
    expect(map).toContain('- forgets-own-call: Забывает свой колл в итоговом банке | seen sng-test-hand-1 | overcome 0/3: -');
  });

  it('refuses while a question is outstanding in the same step, and after an earlier conclusion', async () => {
    model.current = stepCalls([{ id: 'dd', name: 'diagnosis_done', input: doneInput }, { id: 'p1', name: 'probe', input: probeInput }]);
    const list = await events(await post({ messages: [start], snapshot, phase: 'diagnosis' }));
    expect(outputOf(list, 'dd')).toEqual({ error: expect.stringMatching(/question is still open/) });
    expect(await exists('working-state.md')).toBe(false);

    model.current = stepCalls([{ id: 'dd3', name: 'diagnosis_done', input: doneInput }]);
    const again = await events(await post({ messages: [start, done({ saved: true, note: 'ok' }), userMessage], snapshot, phase: 'diagnosis' }));
    expect(outputOf(again, 'dd3')).toEqual({ error: expect.stringMatching(/already concluded/) });
    // A refused earlier call does not count, and a newer start begins a new diagnosis.
    model.current = stepCalls([{ id: 'dd4', name: 'diagnosis_done', input: doneInput }]);
    expect(outputOf(await events(await post({ messages: [start, done({ error: 'x' }), userMessage], snapshot, phase: 'diagnosis' })), 'dd4')).toMatchObject({ saved: true });
    model.current = stepCalls([{ id: 'dd5', name: 'diagnosis_done', input: { ...doneInput, bottlenecks: [] } }]);
    expect(outputOf(await events(await post({ messages: [start, done({ saved: true, note: 'ok' }), { ...start, id: 'd1' }], snapshot, phase: 'diagnosis' })), 'dd5')).toMatchObject({ saved: true });
  });

  it('refuses next to an ask_user_question call and accepts a retry after a failed call in the same request', async () => {
    model.current = stepCalls([{ id: 'dd', name: 'diagnosis_done', input: doneInput }, { id: 'q1', name: 'ask_user_question', input: { question: 'Какой формат?' } }]);
    expect(outputOf(await events(await post({ messages: [start], snapshot, phase: 'diagnosis' })), 'dd')).toEqual({ error: expect.stringMatching(/question is still open/) });
    expect(await exists('working-state.md')).toBe(false);

    const steps = [[{ id: 'bad', input: { ...doneInput, workingState: '## Current Workbench' } }], [{ id: 'good', input: doneInput }]];
    let step = 0;
    model.current = new MockLanguageModelV4({
      doStream: async () => step >= steps.length ? textStream('Готово.') : { stream: simulateReadableStream({ chunks: [
        ...steps[step++].map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: 'diagnosis_done', input: JSON.stringify(c.input) })),
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
      ] }) },
    });
    const list = await events(await post({ messages: [start], snapshot, phase: 'diagnosis' }));
    expect(outputOf(list, 'bad')).toEqual({ error: expect.stringMatching(/exactly the sections/) });
    expect(outputOf(list, 'good')).toMatchObject({ saved: true });
    expect(await exists('working-state.md')).toBe(true);
  });

  it('returns invalid memory input as { error } and saves nothing', async () => {
    model.current = stepCalls([
      { id: 'w', name: 'diagnosis_done', input: { ...doneInput, workingState: '## Current Workbench\n- x' } },
    ]);
    expect(outputOf(await events(await post({ messages: [start], snapshot, phase: 'diagnosis' })), 'w')).toEqual({ error: expect.stringMatching(/exactly the sections/) });
    model.current = stepCalls([
      { id: 'b', name: 'diagnosis_done', input: { ...doneInput, bottlenecks: [doneInput.bottlenecks[0], doneInput.bottlenecks[0]] } },
    ]);
    expect(outputOf(await events(await post({ messages: [start], snapshot, phase: 'diagnosis' })), 'b')).toEqual({ error: expect.stringMatching(/already exists; nothing was saved/) });
    expect(await exists('working-state.md')).toBe(false);
    expect(await exists('knowledge-map.md')).toBe(false);
  });
});

describe('POST /api/compact', () => {
  const compact = (body: unknown) => app.request('/api/compact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const generated = (text: string, finish: 'stop' | 'length' = 'stop') => new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: { unified: finish, raw: undefined }, usage, warnings: [] }),
  });
  const span = [
    { id: 't1', role: 'user', metadata: { trigger: 'decision', gateId: 'sng-test-hand-3#2' }, parts: [{ type: 'text', text: '[Тренировка] Мой ход: флоп.' }] },
    { id: 'a1', role: 'assistant', parts: [
      { type: 'reasoning', text: 'secret scratch' },
      { type: 'tool-equity', toolCallId: 'c1', state: 'output-available', input: { hero: ['Ah', 'Kd'], board: [], opponents: ['22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, A2o+, K2o+, Q2o+, J2o+, T2o+, 92o+, 82o+, 72o+, 62o+, 52o+, 42o+, 32o, '.repeat(3)] }, output: { equity: 0.6, note: 'y'.repeat(1000) } },
      { type: 'tool-outs', toolCallId: 'c2', state: 'input-available', input: { hero: ['Ah', 'Kd'], board: ['2c', '7d', 'Ts'] } },
      { type: 'text', text: 'Какой у тебя план?' },
    ] },
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Чек-колл, у меня топ-пара.' }] },
  ];

  it('answers 503 without env and 400 for bad input', async () => {
    expect((await compact({ summary: 7, messages: span })).status).toBe(400);
    expect((await compact({ summary: null, messages: [{ role: 'user' }] })).status).toBe(400);
    expect((await compact({ summary: null, messages: [{ ...span[2], role: 'system' }] })).status).toBe(400);
    expect((await compact({ summary: null, messages: [{ ...span[2], parts: [{ type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' }] }] })).status).toBe(400);
    expect((await compact({ summary: null, messages: [{ ...span[2], parts: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }] })).status).toBe(413);
    vi.stubEnv('OPENROUTER_MODEL', '');
    expect((await compact({ summary: null, messages: span })).status).toBe(503);
  });

  it('merges the previous summary with the labelled span and returns the new summary', async () => {
    const mock = generated('  ## Понимание игрока и его эволюция\n- ...  ');
    model.current = mock;
    const res = await compact({ summary: 'старая сводка: договорились считать пот-оддсы', messages: span });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: '## Понимание игрока и его эволюция\n- ...' });
    const call = mock.doGenerateCalls[0];
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: 'low' } } });
    const [system, user] = call.prompt;
    expect(JSON.stringify(system.content)).toMatch(/ОБЪЕДИНИ.*## Понимание игрока и его эволюция.*## Ход сессии.*## Текущий момент/);
    const text = JSON.stringify(user.content);
    expect(text).toContain('<previous-summary>\\nстарая сводка: договорились считать пот-оддсы\\n</previous-summary>');
    expect(text).toContain('[СОБЫТИЕ гейт sng-test-hand-3#2] [Тренировка] Мой ход: флоп.');
    expect(text).toContain('[ТУЛ equity {');
    expect(text).toContain('…[урезано]');
    expect(text).not.toContain('y'.repeat(400));
    // A long input never cuts off the result: it is clipped on its own.
    expect(text).toMatch(/\[ТУЛ equity \{.*?…\[урезано\] → \{\\+"equity\\+":0\.6/);
    expect(text).toContain('[ДЭН] Какой у тебя план?');
    expect(text).toContain('[ИГРОК] Чек-колл, у меня топ-пара.');
    expect(text).not.toContain('secret scratch');
    expect(text).not.toContain('[ТУЛ outs');
  });

  it('fails with 502 on a cut-off, oversized or failed summary', async () => {
    model.current = generated('## Понимание', 'length');
    expect((await compact({ summary: null, messages: span })).status).toBe(502);
    model.current = generated('x'.repeat(6001));
    expect((await compact({ summary: null, messages: span })).status).toBe(502);
    model.current = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('provider down'); } });
    const res = await compact({ summary: null, messages: span });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Could not summarize the conversation' });
  });
});
