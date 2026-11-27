// Push-to-Talk for the chat: records with MediaRecorder, transcribes through POST /api/stt, hands the text to the caller.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';

export type VoiceState = 'idle' | 'permission' | 'recording' | 'transcribing';

/** A press at least this long is hold-to-talk (release stops); a shorter click toggles recording on. */
export const HOLD_MS = 300;
export const MAX_SECONDS = 120;

/** Replaces the selection with `text`, joining with single spaces (none before punctuation); the caret goes right after the inserted text. */
export function insertAtCaret(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, start), after = value.slice(end);
  const inserted = (before && !/\s$/.test(before) ? ' ' : '') + text;
  return { value: before + inserted + (after && !/^[\s.,!?;:)]/.test(after) ? ' ' : '') + after, caret: before.length + inserted.length };
}

function micError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access denied — allow it in the browser';
  if (name === 'NotFoundError') return 'No microphone found';
  return 'Could not start recording — try again';
}

type Session = { recorder?: MediaRecorder; stream?: MediaStream; chunks: Blob[]; elapsed: number; timer?: ReturnType<typeof setInterval> };

export function useVoiceInput(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The live recording; replaced or cleared on every exit, so a late callback from an old one sees it is stale.
  const session = useRef<Session | null>(null);
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  // Chrome still dispatches pointer events to a disabled button, and React does not filter them.
  const blocked = !supported || state === 'transcribing';

  /** Ends the session: tracks off, timer off. Returns whether it was still the live one. */
  const end = (s: Session) => {
    s.stream?.getTracks().forEach((t) => t.stop());
    clearInterval(s.timer);
    if (session.current !== s) return false;
    session.current = null;
    return true;
  };

  const cancel = () => {
    const s = session.current;
    if (!s) return;
    end(s);
    // Ended first, so its stop event sends nothing.
    if (s.recorder?.state === 'recording') s.recorder.stop();
    setState('idle');
  };

  const transcribe = async (blob: Blob) => {
    let text = '';
    let message: string | null = 'Nothing recognised — try again';
    // A click-click too fast for any audio: nothing to send.
    if (blob.size) try {
      setState('transcribing');
      message = 'Speech recognition failed — try again';
      const res = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
      const body = await res.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
      if (res.status === 503 && typeof body?.error === 'string') message = body.error;
      else if (res.ok && typeof body?.text === 'string') {
        text = body.text.trim();
        message = text ? null : 'Nothing recognised — try again';
      }
    } catch { /* network error: the default message */ }
    // The chat (and its textarea) is gone.
    if (!mounted.current) return;
    if (text) onTextRef.current(text);
    setError(message);
    setState('idle');
  };

  const finish = () => {
    const recorder = session.current?.recorder;
    if (recorder?.state === 'recording') recorder.stop();
  };

  const start = async (s: Session = { chunks: [], elapsed: 0 }) => {
    session.current = s;
    setError(null);
    setSeconds(0);
    setState('permission');
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Cancelled or unmounted while the permission prompt was open.
      if (session.current !== s) return end(s);
      const recorder = new MediaRecorder(s.stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined);
      recorder.ondataavailable = (e) => { if (e.data.size) s.chunks.push(e.data); };
      // Also fires when the browser stops it (mic unplugged, permission revoked): what was recorded still goes out.
      recorder.onstop = () => { if (end(s)) void transcribe(new Blob(s.chunks, { type: recorder.mimeType })); };
      recorder.onerror = () => {
        if (!end(s)) return;
        setError('Recording failed — try again');
        setState('idle');
      };
      recorder.start();
      s.recorder = recorder;
      s.timer = setInterval(() => {
        setSeconds(++s.elapsed);
        if (s.elapsed >= MAX_SECONDS) finish();
      }, 1000);
      setState('recording');
    } catch (e) {
      if (!end(s)) return;
      setError(micError(e));
      setState('idle');
    }
  };

  // Escape cancels a recording (or a pending permission prompt) and discards it.
  useEffect(() => {
    if (state !== 'recording' && state !== 'permission') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, []);

  const button = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || blocked) return;
      // The second click of a toggle.
      if (session.current) return finish();
      const pressedAt = Date.now();
      const s: Session = { chunks: [], elapsed: 0 };
      void start(s);
      // On window, so a release outside the button still ends the hold.
      window.addEventListener('pointerup', () => {
        if (session.current === s && s.recorder && Date.now() - pressedAt >= HOLD_MS) finish();
      }, { once: true });
    },
    // Keyboard activation (Enter/Space) has no pointer: it toggles. A pointer press already acted on pointerdown.
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (e.detail !== 0 || blocked) return;
      if (session.current) finish();
      else void start();
    },
  };

  return { supported, state, seconds, error, clearError: () => setError(null), button };
}
