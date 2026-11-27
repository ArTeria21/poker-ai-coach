import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DIAGNOSIS_PREFIX } from '../agent/contract';
import { useChat } from '@ai-sdk/react';
import type { Mode } from '../agent/training';
import { useSettingsStore } from '../store/settingsStore';
import { MicIcon } from './Icons';
import { Segmented } from './Segmented';
import {
  chat, dispatch, isQuestion, loadMemoryStatus, lockedGate, openQuestion, retry, sendUserText, setTrainingMode, startDiagnosis, stopDan, stopDiagnosis,
  useDiagnosisStore, useTrainingStore, type DanMessage, type TriggerMeta,
} from './coachSession';
import { AnsweredQuestion, AssessmentCard, QuestionForm, Skipped } from './DiagnosisCards';
import { insertAtCaret, useVoiceInput } from './voiceInput';
import './CoachChat.css';

type Part = DanMessage['parts'][number];
export type ToolPart = Extract<Part, { type: `tool-${string}` }>;

const EXAMPLES = ['Какие у меня шансы в этой раздаче?', 'Как ICM влияет на мои решения сейчас?', 'Что бы ты сделал на моём месте и почему?'];

export const triggerLine = (meta: TriggerMeta) =>
  meta.trigger === 'review' ? 'Hand over — review with Dan' : `Your turn · ${meta.street} — discussing with Dan`;

/** The transport puts the raw response body into the message; the server answers errors as `{ error }`. */
export function errorText(error: Error): string {
  const fallback = 'Coach could not answer right now.';
  // A rejected fetch or a broken stream: the browser's own wording ("Failed to fetch", "network error") says nothing to the player.
  if (error instanceof TypeError) return 'Lost connection to the coach server.';
  // An HTML body (e.g. a proxy 502 page) means nothing to the player.
  if (error.message.trimStart().startsWith('<')) return fallback;
  try {
    const parsed: unknown = JSON.parse(error.message);
    if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') return parsed.error;
  } catch { /* not JSON: a network or stream error message */ }
  return error.message || fallback;
}

const LABELS: Record<string, string> = {
  'tool-equity': 'Equity', 'tool-range_combos': 'Combos', 'tool-pot_odds': 'Pot odds', 'tool-shove_ev': 'Shove EV', 'tool-outs': 'Outs', 'tool-icm': 'ICM', 'tool-release_actions': 'Unlock',
  'tool-write_working_state': 'Memory', 'tool-update_knowledge_map': 'Knowledge map', 'tool-append_highlight': 'Highlight', 'tool-read_highlights': 'Highlights',
  'tool-ask_user_question': 'Question', 'tool-probe': 'Probe', 'tool-diagnosis_done': 'Diagnosis',
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** `live`: the call belongs to the response still streaming; otherwise an unfinished call was stopped or cut off. */
export function toolChip(part: ToolPart, live: boolean): { text: string; state: 'running' | 'done' | 'error'; detail?: string } {
  // The SDK also makes `tool-<name>` parts for names this client does not know.
  const label = LABELS[part.type] ?? part.type.slice(5);
  if (part.state === 'output-error') return { text: `${label} failed`, state: 'error', detail: part.errorText };
  if (part.state !== 'output-available') return live ? { text: `${label}…`, state: 'running' } : { text: `${label} stopped`, state: 'error' };
  if ('error' in part.output) return { text: `${label} failed`, state: 'error', detail: part.output.error };
  const done = (text: string) => ({ text, state: 'done' as const });
  switch (part.type) {
    case 'tool-equity': return done(`Equity ${pct(part.output.equity)} vs ${part.input.opponents.join(' | ')}`);
    case 'tool-range_combos': return done(`${part.output.combos} combos in ${part.input.range}`);
    case 'tool-pot_odds': return done(`Pot odds: need ${pct(part.output.requiredEquity)}${part.output.callEV === undefined ? '' : `, call EV ${part.output.callEV}`}`);
    case 'tool-shove_ev': return done(`Shove EV ${part.output.evChips > 0 ? '+' : ''}${Math.round(part.output.evChips)} chips${part.output.evBB === undefined ? '' : ` (${part.output.evBB} BB)`}`);
    case 'tool-outs': return done(`Outs ${part.output.completionCards}: ${pct(part.output.nextCardProbability)} next card${part.output.byRiverProbability === null ? '' : `, ${pct(part.output.byRiverProbability)} by river`}`);
    case 'tool-icm': return done(`ICM ${part.output.equities.map(pct).join(' / ')}${part.output.bubbleFactor == null ? '' : ` · bubble factor ${part.output.bubbleFactor}`}${part.output.delta === undefined ? '' : ` · EV Δ ${part.output.delta > 0 ? '+' : ''}${(part.output.delta * 100).toFixed(2)}%`}`);
    case 'tool-release_actions': return done(part.output.kind === 'decision' ? 'Actions unlocked' : 'Review done');
    case 'tool-write_working_state': return done('Memory updated');
    case 'tool-update_knowledge_map': return done('Knowledge map updated');
    case 'tool-append_highlight': return done('Hand saved to highlights');
    case 'tool-read_highlights': return done(`Recalled ${part.output.entries.length} highlights`);
    // Answered questions and a saved diagnosis render as cards; these chips are only a fallback.
    case 'tool-ask_user_question': return done('dismissed' in part.output ? 'Skipped' : 'Answered');
    case 'tool-probe': return done('dismissed' in part.output ? 'Skipped' : part.output.dontKnow ? "Don't know" : part.output.correct ? 'Correct' : 'Incorrect');
    case 'tool-diagnosis_done': return done('Diagnosis saved');
  }
}

const isTool = (part: Part): part is ToolPart => part.type.startsWith('tool-');
const isDiagnosisStart = (message: DanMessage) =>
  message.role === 'user' && message.parts.some((p) => p.type === 'text' && p.text.startsWith(DIAGNOSIS_PREFIX));

export function CoachChat({ className = '' }: { className?: string } = {}) {
  const { messages, status, error } = useChat<DanMessage>({ chat });
  const mode = useSettingsStore((s) => s.mode);
  // The latest request's gate, while still locked; after an error or Stop nobody else can release it, so the player may go on without Dan.
  const requestGate = useTrainingStore((s) => s.requestGate && lockedGate(s.state)?.id === s.requestGate.id ? s.requestGate.id : null);
  const stopped = useTrainingStore((s) => s.requestStopped);
  const diagnosis = useDiagnosisStore((s) => s.resume !== null);
  const initialized = useDiagnosisStore((s) => s.initialized);
  const stuckGate = status === 'error' || (status === 'ready' && stopped) ? requestGate : null;
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const last = messages.at(-1);
  // Reasoning is not streamed, so this is the only sign of life until text arrives, including between tool steps.
  const thinking = busy && !(last?.role === 'assistant' && last.parts.at(-1)?.type === 'text');
  const pinned = useRef(true);
  const open = openQuestion(messages);
  // Dictated text goes in at the caret and is never sent automatically: the player edits and sends.
  const caret = useRef<number | null>(null);
  const voice = useVoiceInput((text) => {
    const el = inputRef.current!;
    const next = insertAtCaret(el.value, el.selectionStart, el.selectionEnd, text);
    caret.current = next.caret;
    setInput(next.value);
  });

  useLayoutEffect(() => {
    if (caret.current === null) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [input]);

  useEffect(() => { void loadMemoryStatus(); }, []);
  // A client-side TypeError hides behind the lost-connection text: keep the raw one in the console, once per error.
  useEffect(() => { if (error instanceof TypeError) console.warn('[chat]', error); }, [error]);

  useEffect(() => {
    const log = logRef.current;
    if (log && pinned.current) log.scrollTop = log.scrollHeight;
  }, [messages, thinking, error]);

  const focusInput = () => inputRef.current?.focus();
  const send = (text: string) => {
    if (!text.trim() || busy) return;
    pinned.current = true;
    sendUserText(text.trim());
    setInput('');
    focusInput();
  };

  const micLabel = voice.state === 'recording'
    ? `Recording ${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, '0')}`
    : voice.state === 'permission' ? 'Allow microphone…'
      : voice.state === 'transcribing' ? 'Transcribing…'
        : 'Voice';

  return (
    <aside className={`coach-chat${className ? ` ${className}` : ''}`} aria-label="Chat with coach Dan">
      <div className="chat-header">
        <div className="chat-title-group">
          <span className="panel-kicker">Coach</span>
          <h2>Dan</h2>
        </div>
        <div className="chat-header-actions">
          {diagnosis
            ? <button type="button" className="chat-header-btn chat-header-btn--active" onClick={stopDiagnosis}>Stop diagnosis</button>
            : <button type="button" className="chat-header-btn" disabled={busy} onClick={startDiagnosis}>Diagnose level</button>}
          {/* Training pauses during the diagnosis and resumes afterwards. */}
          <Segmented label="Mode" value={mode} options={['free', 'training'] as Mode[]} onChange={setTrainingMode} disabled={diagnosis} />
        </div>
      </div>
      <div
        className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation"
        // Follow new output only while the reader is at the bottom, not while rereading older messages.
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="chat-text">Привет, я Дэн. Спроси о текущей раздаче — разберём её с расчётами.</p>
            {initialized === false && (
              <>
                <p className="chat-text">Я пока ничего о тебе не знаю. Начнём с короткой диагностики уровня — так я пойму, с чего начать.</p>
                <button type="button" className="chat-example chat-example--primary" onClick={startDiagnosis}>Пройти диагностику</button>
              </>
            )}
            {EXAMPLES.map((example) => <button key={example} type="button" className="chat-example" onClick={() => send(example)}>{example}</button>)}
          </div>
        )}
        {messages.map((message) => message.metadata?.trigger ? (
          <div key={message.id} className="chat-event">{triggerLine(message.metadata)}</div>
        ) : isDiagnosisStart(message) ? (
          <div key={message.id} className="chat-event">Level diagnosis</div>
        ) : (
          <article key={message.id} className={`chat-msg chat-msg--${message.role}`}>
            <div className="chat-author">{message.role === 'user' ? 'You' : 'Dan'}</div>
            {message.parts.map((part, i) => {
              if (part.type === 'text') return <p key={i} className="chat-text">{part.text}</p>;
              if (!isTool(part)) return null;
              if (isQuestion(part)) {
                if (part.state === 'output-available') return <AnsweredQuestion key={i} part={part} />;
                if (part.state === 'input-available' && part.toolCallId === open) return <QuestionForm key={i} part={part} />;
                // A rejected call's error text holds the whole input, answer included; Dan retries it in the same step.
                // Streaming, or waiting for the question before it in the same message: nothing yet.
                if (part.state === 'output-error' || (diagnosis && message === last)) return null;
                // An older or abandoned call never becomes answerable again.
                return <Skipped key={i} />;
              }
              if (part.type === 'tool-diagnosis_done' && part.state === 'output-available' && 'saved' in part.output) return <AssessmentCard key={i} part={part} />;
              const chip = toolChip(part, busy && message === last);
              return <span key={i} className={`chat-chip chat-chip--${chip.state}`} title={chip.detail ?? chip.text}>{chip.text}</span>;
            })}
          </article>
        ))}
        {thinking && <div className="chat-thinking">Dan is thinking…</div>}
        {(status === 'error' && error) || stuckGate ? (
          <div className="chat-error" role="alert">
            <span>{status === 'error' && error ? errorText(error) : 'Stopped: the table is still locked.'}</span>
            <button type="button" onClick={() => { retry(); focusInput(); }}>Retry</button>
            {stuckGate && <button type="button" onClick={() => dispatch({ type: 'released', gateId: stuckGate })}>Continue without Dan</button>}
          </div>
        ) : null}
      </div>
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea
          ref={inputRef} rows={open ? 2 : 3} value={input} aria-label="Message to Dan" placeholder="Ask Dan about this spot (Enter sends, Shift+Enter for a new line)"
          onChange={(e) => { setInput(e.target.value); voice.clearError(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send(input); }
          }}
        />
        {open !== null && <div className="chat-skip-hint">Sending a message skips the active card</div>}
        {voice.error && <div className="chat-voice-error" role="alert">{voice.error}</div>}
        <div className="chat-buttons">
          <button
            type="button" {...voice.button}
            className={`chat-mic chat-mic--${voice.state}`}
            disabled={!voice.supported || voice.state === 'transcribing'}
            aria-pressed={voice.state === 'recording'}
            title={voice.supported ? 'Hold to talk, or click to start and click again to stop · Esc cancels' : 'Voice input needs microphone access (HTTPS or localhost)'}
          >
            <MicIcon />{micLabel}
          </button>
          {voice.supported && <span className="chat-mic-hint">Hold or click · Esc cancels</span>}
          {busy && <button type="button" className="chat-stop" onClick={() => { stopDan(); focusInput(); }}>Stop</button>}
          <button type="submit" className="chat-send" disabled={busy || !input.trim()}>Send</button>
        </div>
      </form>
    </aside>
  );
}
