import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { app } from './app';
import { normalizeTranscript, POKER_TERMS } from './voice';

const deepgram = (transcript: unknown) => Response.json({ results: { channels: [{ alternatives: [{ transcript }] }] } });
const post = (body: BodyInit | null, type = 'audio/webm;codecs=opus') =>
  app.request('/api/stt', { method: 'POST', headers: { 'content-type': type }, body });

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  vi.stubEnv('DEEPGRAM_API_KEY', 'dg-test-key');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/stt', () => {
  it('forwards the audio to Deepgram nova-3 with the poker keyterms and returns the normalised text', async () => {
    fetchSpy.mockResolvedValue(deepgram('Он сделал три бет, а у меня 40 процентов эквити.'));
    const res = await post(new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Он сделал 3-бет, а у меня 40% эквити.' });

    const [url, init] = fetchSpy.mock.calls[0];
    const sent = new URL(String(url));
    expect(sent.origin + sent.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(sent.searchParams.get('model')).toBe('nova-3');
    expect(sent.searchParams.get('language')).toBe('ru');
    expect(sent.searchParams.get('smart_format')).toBe('true');
    expect(sent.searchParams.getAll('keyterm')).toEqual(POKER_TERMS);
    expect(init?.headers).toEqual({ Authorization: 'Token dg-test-key', 'Content-Type': 'audio/webm;codecs=opus' });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes Safari\'s content type through and answers an empty transcript with empty text', async () => {
    fetchSpy.mockResolvedValue(deepgram(''));
    const res = await post(new Uint8Array([1]), 'audio/mp4');
    expect(await res.json()).toEqual({ text: '' });
    expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['Content-Type']).toBe('audio/mp4');
  });

  it('rejects non-audio (415), oversized (413) and empty (400) bodies without calling Deepgram', async () => {
    expect((await post(new Uint8Array([1]), 'application/json')).status).toBe(415);
    expect((await post(new Uint8Array(4 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await post(new Uint8Array(0))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 503 with a clear message without DEEPGRAM_API_KEY', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '');
    const res = await post(new Uint8Array([1]));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Voice input is not configured: set DEEPGRAM_API_KEY' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 502 on a Deepgram error, a network error, a timeout or a malformed answer, never leaking the key', async () => {
    const failures = [
      () => Promise.resolve(Response.json({ err_msg: 'bad key' }, { status: 401 })),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      () => Promise.resolve(Response.json({ results: {} })),
    ];
    for (const fail of failures) {
      fetchSpy.mockImplementationOnce(fail);
      const res = await post(new Uint8Array([1]));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Speech recognition failed' });
    }
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('401');
    expect(logged).toContain('TimeoutError');
    expect(logged).not.toContain('dg-test-key');
  });
});

describe('poker vocabulary', () => {
  it('stays well under the 500-token keyterm budget, counting every character as a token', () => {
    expect(new Set(POKER_TERMS).size).toBe(POKER_TERMS.length);
    expect(POKER_TERMS.reduce((n, term) => n + [...term].length + 1, 0)).toBeLessThan(400);
    for (const term of ['трибет', 'контбет', 'пот-оддс', 'эквити', 'гатшот', 'ОЕСД', 'натс', 'баттон', 'кат-офф', 'анте', 'олл-ин']) expect(POKER_TERMS).toContain(term);
  });
});

describe('normalizeTranscript', () => {
  it.each([
    ['он сделал три бет', 'он сделал 3-бет'],
    ['Три бет с баттона', '3-бет с баттона'],
    ['трибет с баттона', '3-бет с баттона'],
    ['мне 3 бетить или нет', 'мне 3-бетить или нет'],
    ['против четыре бет', 'против 4-бет'],
    ['против 4бета', 'против 4-бета'],
    ['после трибета', 'после 3-бета'],
    ['Пот оддс хватает', 'Пот-оддс хватает'],
    ['какие пот оддс', 'какие пот-оддс'],
    ['пот-одс тут', 'пот-оддс тут'],
    ['Олл ин на ривере', 'Олл-ин на ривере'],
    ['пуш олл-ин', 'пуш олл-ин'],
    ['я на кат офф', 'я на кат-офф'],
    ['с кат оффа', 'с кат-оффа'],
    ['на катофф', 'на кат-офф'],
    ['у меня о е с д', 'у меня OESD'],
    ['у меня оесд и флеш-дро', 'у меня OESD и флеш-дро'],
    ['примерно 40 процентов', 'примерно 40%'],
    ['33,3 процента эквити', '33,3% эквити'],
    ['до 9 больших блайндов', 'до 9 BB'],
    ['у него 12 бб', 'у него 12 BB'],
    ['ровно 1 большой блайнд', 'ровно 1 BB'],
  ])('%s → %s', (input, output) => expect(normalizeTranscript(input)).toBe(output));

  it.each([
    'бетонная стена',
    'три бетона',
    '3 бета подряд',
    '3 беты на флопе',
    'потом одним словом',
    'пот большой',
    'полина и олли',
    'кат оффер',
    'поесда нет',
    'процентов много',
    'процентный риск',
    'на 9 больших блайндах',
    'у меня 20 ббшек',
    'ловкость рук',
  ])('leaves "%s" alone', (input) => expect(normalizeTranscript(input)).toBe(input));
});
