// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type } from '../tests/appTestKit';
import { CoachChat } from './CoachChat';
import { insertAtCaret, MAX_SECONDS } from './voiceInput';

type Track = { stop: ReturnType<typeof vi.fn> };
let tracks: Track[] = [];
let mic: () => Promise<unknown>;
let micCalls = 0;
let audio: BlobPart[];
const liveStream = () => {
  const track = { stop: vi.fn() };
  tracks.push(track);
  return { getTracks: () => [track] };
};
let recorders: FakeRecorder[] = [];
class FakeRecorder {
  static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus';
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType: string }) {
    this.mimeType = options?.mimeType ?? 'audio/mp4';
    recorders.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    void Promise.resolve().then(() => {
      this.ondataavailable?.({ data: new Blob(audio, { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}

let stt: () => Promise<Response>;
let fetchSpy: ReturnType<typeof vi.fn>;
const sttCalls = () => fetchSpy.mock.calls.filter(([url]) => url === '/api/stt');
const otherCalls = () => fetchSpy.mock.calls.filter(([url]) => url !== '/api/stt' && url !== '/api/memory/status');

let container: HTMLElement;
let root: Root;
const textarea = () => container.querySelector<HTMLTextAreaElement>('.chat-form textarea')!;
const micButton = () => container.querySelector<HTMLButtonElement>('.chat-mic')!;
const voiceError = () => container.querySelector('.chat-voice-error')?.textContent ?? null;
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const pointer = (target: EventTarget, kind: 'pointerdown' | 'pointerup') =>
  act(() => { target.dispatchEvent(new PointerEvent(kind, { bubbles: true, button: 0 })); });
/** Presses the mic for `ms` and releases it over the button (with the click a browser sends then) or outside. */
async function press(ms: number, outside = false) {
  await pointer(micButton(), 'pointerdown');
  await flush();
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await pointer(outside ? document.body : micButton(), 'pointerup');
  if (!outside) await act(() => { micButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  await flush();
}
const keyboardClick = () => act(() => { micButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });

beforeEach(async () => {
  vi.useFakeTimers();
  tracks = [];
  micCalls = 0;
  recorders = [];
  audio = ['opus'];
  mic = async () => liveStream();
  stt = async () => Response.json({ text: 'или' });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => { micCalls++; return mic(); } }, configurable: true });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  fetchSpy = vi.fn(async (url: string) => url === '/api/stt' ? stt() : Response.json({ initialized: true }));
  vi.stubGlobal('fetch', fetchSpy);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<CoachChat />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Push-to-Talk', () => {
  it('hold-to-talk inserts the text at the caret, focused, without sending anything', async () => {
    await type(textarea(), 'Колл рейз?');
    textarea().setSelectionRange(4, 4);
    await press(500, true);
    expect(micButton().textContent).toBe('Voice');
    expect(textarea().value).toBe('Колл или рейз?');
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe(8);
    const [, init] = sttCalls()[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'audio/webm;codecs=opus' });
    expect((init.body as Blob).type).toBe('audio/webm;codecs=opus');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(otherCalls()).toEqual([]);
  });

  it('a short click toggles recording on; the next click stops and transcribes', async () => {
    await press(100);
    expect(micButton().getAttribute('aria-pressed')).toBe('true');
    await act(() => vi.advanceTimersByTimeAsync(63_000));
    expect(micButton().textContent).toBe('Recording 1:03');
    expect(sttCalls()).toHaveLength(0);
    await press(100);
    expect(sttCalls()).toHaveLength(1);
    expect(textarea().value).toBe('или');
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(otherCalls()).toEqual([]);
  });

  it('toggles from the keyboard: Enter/Space starts, the next stops and transcribes', async () => {
    await keyboardClick();
    await flush();
    expect(micButton().textContent).toBe('Recording 0:00');
    await keyboardClick();
    await flush();
    expect(sttCalls()).toHaveLength(1);
    expect(textarea().value).toBe('или');
  });

  it('a recording the browser stops by itself (mic gone) is transcribed and the button returns to idle', async () => {
    await press(100);
    await act(async () => recorders[0].stop());
    await flush();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(sttCalls()).toHaveLength(1);
    expect(textarea().value).toBe('или');
    expect(micButton().textContent).toBe('Voice');
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(micButton().textContent).toBe('Voice');
  });

  it('a recorder error ends the session with an error line and no request', async () => {
    await press(100);
    await act(async () => recorders[0].onerror?.());
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(voiceError()).toBe('Recording failed — try again');
    expect(micButton().textContent).toBe('Voice');
    expect(sttCalls()).toHaveLength(0);
    await press(100);
    expect(micButton().textContent).toBe('Recording 0:00');
  });

  it('ignores a pointer press on the disabled button while transcribing', async () => {
    stt = () => new Promise(() => {});
    await press(500);
    expect(micButton().disabled).toBe(true);
    await pointer(micButton(), 'pointerdown');
    await flush();
    expect(micCalls).toBe(1);
  });

  it('shows the permission wait, then the recording', async () => {
    let grant!: (s: unknown) => void;
    mic = () => new Promise((resolve) => { grant = resolve; });
    await pointer(micButton(), 'pointerdown');
    expect(micButton().textContent).toBe('Allow microphone…');
    // Releasing to click the browser prompt does not stop: the recording continues as a toggle.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await pointer(document.body, 'pointerup');
    await act(async () => grant(liveStream()));
    expect(micButton().textContent).toBe('Recording 0:00');
  });

  it('disables the button while transcribing', async () => {
    let answer!: (r: Response) => void;
    stt = () => new Promise((resolve) => { answer = resolve; });
    await press(500);
    expect(micButton().disabled).toBe(true);
    expect(micButton().textContent).toBe('Transcribing…');
    await act(async () => answer(Response.json({ text: 'чек' })));
    expect(micButton().disabled).toBe(false);
    expect(textarea().value).toBe('чек');
  });

  it('Escape cancels the recording with no request', async () => {
    await press(100);
    await act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await flush();
    expect(micButton().textContent).toBe('Voice');
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(sttCalls()).toHaveLength(0);
    expect(textarea().value).toBe('');
  });

  it('Escape during the permission prompt stops the tracks granted afterwards', async () => {
    let grant!: (s: unknown) => void;
    mic = () => new Promise((resolve) => { grant = resolve; });
    await pointer(micButton(), 'pointerdown');
    await act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await act(async () => grant(liveStream()));
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(micButton().textContent).toBe('Voice');
  });

  it(`stops by itself after ${MAX_SECONDS} s`, async () => {
    await press(100);
    await act(() => vi.advanceTimersByTimeAsync(MAX_SECONDS * 1000));
    await flush();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(sttCalls()).toHaveLength(1);
    expect(textarea().value).toBe('или');
  });

  it('stops the tracks on unmount and ignores a result that arrives afterwards', async () => {
    await press(100);
    act(() => root.unmount());
    expect(tracks[0].stop).toHaveBeenCalled();

    root = createRoot(container);
    await act(async () => root.render(<CoachChat />));
    let answer!: (r: Response) => void;
    stt = () => new Promise((resolve) => { answer = resolve; });
    await press(500);
    act(() => root.unmount());
    // Handing the text to the unmounted chat would throw (no textarea); vitest fails the run on that unhandled rejection.
    await act(async () => answer(Response.json({ text: 'поздно' })));
    expect(tracks[1].stop).toHaveBeenCalled();
    root = createRoot(container);
    await act(async () => root.render(<CoachChat />));
    expect(textarea().value).toBe('');
  });

  it.each([
    ['mic denied', () => { mic = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); }, 'Microphone access denied — allow it in the browser'],
    ['no mic', () => { mic = () => Promise.reject(new DOMException('none', 'NotFoundError')); }, 'No microphone found'],
    ['not configured', () => { stt = async () => Response.json({ error: 'Voice input is not configured: set DEEPGRAM_API_KEY' }, { status: 503 }); }, 'Voice input is not configured: set DEEPGRAM_API_KEY'],
    ['Deepgram failed', () => { stt = async () => Response.json({ error: 'Speech recognition failed' }, { status: 502 }); }, 'Speech recognition failed — try again'],
    ['network down', () => { stt = () => Promise.reject(new TypeError('Failed to fetch')); }, 'Speech recognition failed — try again'],
    ['silence', () => { stt = async () => Response.json({ text: '' }); }, 'Nothing recognised — try again'],
    ['no audio captured', () => { audio = []; }, 'Nothing recognised — try again'],
  ])('%s shows one error line, cleared by typing or the next recording', async (_, fail, message) => {
    fail();
    await press(500);
    expect(voiceError()).toBe(message);
    expect(micButton().textContent).toBe('Voice');
    expect(textarea().value).toBe('');
    for (const track of tracks) expect(track.stop).toHaveBeenCalled();
    await type(textarea(), 'x');
    expect(voiceError()).toBeNull();

    fail();
    await press(500);
    expect(voiceError()).toBe(message);
    mic = async () => liveStream();
    await pointer(micButton(), 'pointerdown');
    expect(voiceError()).toBeNull();
  });

  it('is disabled with an explanation when the browser cannot record', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<CoachChat />));
    expect(micButton().disabled).toBe(true);
    expect(micButton().title).toBe('Voice input needs microphone access (HTTPS or localhost)');
    await pointer(micButton(), 'pointerdown');
    expect(micCalls).toBe(0);
  });
});

describe('insertAtCaret', () => {
  it('replaces the selection and joins with single spaces', () => {
    expect(insertAtCaret('', 0, 0, 'чек')).toEqual({ value: 'чек', caret: 3 });
    expect(insertAtCaret('колл', 4, 4, 'рейз')).toEqual({ value: 'колл рейз', caret: 9 });
    expect(insertAtCaret('колл ', 5, 5, 'рейз')).toEqual({ value: 'колл рейз', caret: 9 });
    expect(insertAtCaret('а б в', 2, 3, 'X')).toEqual({ value: 'а X в', caret: 3 });
    expect(insertAtCaret('ab', 1, 1, 'X')).toEqual({ value: 'a X b', caret: 3 });
    expect(insertAtCaret('Что делать?', 10, 10, 'на ривере')).toEqual({ value: 'Что делать на ривере?', caret: 20 });
  });
});
