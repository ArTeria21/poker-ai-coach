import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, chatRequestBody, compactIfDue, connectTraining, foldCut, type DanMessage } from './coachSession';

/** Alternating player/Dan messages u0, a0, u1, a1, ... */
const history = (length: number, from = 0): DanMessage[] => Array.from({ length }, (_, i) => {
  const n = Math.floor((from + i) / 2);
  return (from + i) % 2 === 0
    ? { id: `u${n}`, role: 'user', parts: [{ type: 'text', text: `q${n}` }] }
    : { id: `a${n}`, role: 'assistant', parts: [{ type: 'text', text: `a${n}` }] };
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const compactBodies = (spy: { mock: { calls: Parameters<typeof fetch>[] } }) => spy.mock.calls
  .filter(([url]) => url === '/api/compact').map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { summary: string | null; messages: DanMessage[] });

afterEach(() => {
  chat.messages = [];
  vi.restoreAllMocks();
});

describe('dialog compaction', () => {
  it('keeps a tail of at most WINDOW messages that starts with a player message', () => {
    expect(foldCut(history(31), 0)).toBe(12);
    expect(foldCut(history(32), 0)).toBe(12);
    // Only assistant messages in the window: nothing to fold safely.
    expect(foldCut([...history(11), ...Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, role: 'assistant' as const, parts: [] }))], 0)).toBeNull();
  });

  it('folds once at a time, keeps the old state on failure, retries, merges the previous summary and resets with the chat', async () => {
    chat.messages = history(30);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await compactIfDue();
    expect(fetchSpy).not.toHaveBeenCalled();

    chat.messages = history(31);
    await compactIfDue();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(chatRequestBody(chat.messages)).toMatchObject({ summary: null, messages: { length: 31 } });

    let answer!: (r: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const first = compactIfDue();
    await compactIfDue();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    answer(json({ summary: 'S1' }));
    await first;
    expect(compactBodies(fetchSpy)[1]).toMatchObject({ summary: null, messages: { length: 12, 0: { id: 'u0' }, 11: { id: 'a5' } } });
    const body = chatRequestBody(chat.messages);
    expect(body.summary).toBe('S1');
    expect(body.messages.map((m) => m.id)).toEqual(history(19, 12).map((m) => m.id));

    // 19 unfolded + 12 new = 31: the next fold sends the previous summary and only messages after the old cut.
    chat.messages = history(43);
    fetchSpy.mockResolvedValueOnce(json({ error: 'Could not summarize the conversation' }, 502));
    await compactIfDue();
    expect(chatRequestBody(chat.messages).summary).toBe('S1');
    fetchSpy.mockResolvedValueOnce(json({ summary: 'S2' }));
    await compactIfDue();
    expect(compactBodies(fetchSpy)[3]).toMatchObject({ summary: 'S1', messages: { 0: { id: 'u6' } } });
    expect(chatRequestBody(chat.messages)).toMatchObject({ summary: 'S2', messages: { 0: { id: 'u12' }, length: 19 } });

    chat.messages = history(4);
    expect(chatRequestBody(chat.messages)).toMatchObject({ summary: null, messages: { length: 4 } });
  });

  it('cuts at the messages it sent, not at the chat that grew while the fold was in flight', async () => {
    chat.messages = history(31).map((m) => ({ ...m, id: `race-${m.id}` }));
    let answer!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const folding = compactIfDue();
    chat.messages = history(35).map((m) => ({ ...m, id: `race-${m.id}` }));
    answer(json({ summary: 'S1' }));
    await folding;
    const body = chatRequestBody(chat.messages);
    expect(body).toMatchObject({ summary: 'S1', messages: { length: 23, 0: { id: 'race-u6' } } });
  });

  it('folds when a turn settles', async () => {
    const disconnect = connectTraining();
    // Fresh ids: the fold from the previous test must not apply to this chat.
    chat.messages = history(30).map((m) => ({ ...m, id: `new-${m.id}` }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => url === '/api/compact'
      ? json({ summary: 'S' })
      : new Response(['start', 'text-start', 'text-delta', 'text-end', 'finish'].map((type) => `data: ${JSON.stringify({ type, id: 't', delta: 'Ок' })}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }));
    await chat.sendMessage({ parts: [{ type: 'text', text: 'Ещё вопрос' }] });
    await vi.waitFor(() => expect(compactBodies(fetchSpy)).toHaveLength(1));
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/chat');
    disconnect();
  });
});
