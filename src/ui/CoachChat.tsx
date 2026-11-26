import { useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import type { Mode } from '../agent/training';
import { useSettingsStore } from '../store/settingsStore';
import { Segmented } from './Segmented';
import { chat, dispatch, lockedGate, sendUserText, setTrainingMode, stopDan, useTrainingStore, type DanMessage, type TriggerMeta } from './coachSession';
import './CoachChat.css';

type Part = DanMessage['parts'][number];
export type ToolPart = Extract<Part, { type: `tool-${string}` }>;

const EXAMPLES = ['Какие у меня шансы в этой раздаче?', 'Как ICM влияет на мои решения сейчас?', 'Что бы ты сделал на моём месте и почему?'];

export const triggerLine = (meta: TriggerMeta) =>
  meta.trigger === 'review' ? 'Hand over — review with Dan' : `Your turn · ${meta.street} — discussing with Dan`;

/** The transport puts the raw response body into the message; the server answers errors as `{ error }`. */
export function errorText(error: Error): string {
  const fallback = 'Coach could not answer right now.';
  // An HTML body (e.g. a proxy 502 page) means nothing to the player.
  if (error.message.trimStart().startsWith('<')) return fallback;
  try {
    const parsed: unknown = JSON.parse(error.message);
    if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') return parsed.error;
  } catch { /* not JSON: a network or stream error message */ }
  return error.message || fallback;
}

const LABELS: Record<string, string> = {
  'tool-equity': 'Equity', 'tool-range_combos': 'Combos', 'tool-pot_odds': 'Pot odds', 'tool-outs': 'Outs', 'tool-icm': 'ICM', 'tool-release_actions': 'Unlock',
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
    case 'tool-outs': return done(`Outs ${part.output.completionCards}: ${pct(part.output.nextCardProbability)} next card${part.output.byRiverProbability === null ? '' : `, ${pct(part.output.byRiverProbability)} by river`}`);
    case 'tool-icm': return done(`ICM ${part.output.equities.map(pct).join(' / ')}${part.output.bubbleFactor == null ? '' : ` · bubble factor ${part.output.bubbleFactor}`}`);
    case 'tool-release_actions': return done(part.output.kind === 'decision' ? 'Actions unlocked' : 'Next hand unlocked');
  }
}

const isTool = (part: Part): part is ToolPart => part.type.startsWith('tool-');

export function CoachChat() {
  const { messages, status, error, regenerate } = useChat<DanMessage>({ chat });
  const mode = useSettingsStore((s) => s.mode);
  // The latest request's gate, while still locked; after an error or Stop nobody else can release it, so the player may go on without Dan.
  const requestGate = useTrainingStore((s) => s.requestGate && lockedGate(s.state)?.id === s.requestGate.id ? s.requestGate.id : null);
  const stopped = useTrainingStore((s) => s.requestStopped);
  const stuckGate = status === 'error' || (status === 'ready' && stopped) ? requestGate : null;
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const last = messages.at(-1);
  // Reasoning is not streamed, so this is the only sign of life until text arrives, including between tool steps.
  const thinking = busy && !(last?.role === 'assistant' && last.parts.at(-1)?.type === 'text');
  const pinned = useRef(true);

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

  return (
    <aside className="coach-chat" aria-label="Chat with coach Dan">
      <div className="chat-header">
        <span className="panel-kicker">Coach</span><h2>Dan</h2>
        <Segmented label="Mode" value={mode} options={['free', 'training'] as Mode[]} onChange={setTrainingMode} />
      </div>
      <div
        className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation"
        // Follow new output only while the reader is at the bottom, not while rereading older messages.
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="chat-text">Привет, я Дэн. Спроси о текущей раздаче — разберём её с расчётами.</p>
            {EXAMPLES.map((example) => <button key={example} className="chat-example" onClick={() => send(example)}>{example}</button>)}
          </div>
        )}
        {messages.map((message) => message.metadata?.trigger ? (
          <div key={message.id} className="chat-event">{triggerLine(message.metadata)}</div>
        ) : (
          <article key={message.id} className={`chat-msg chat-msg--${message.role}`}>
            <div className="chat-author">{message.role === 'user' ? 'You' : 'Dan'}</div>
            {message.parts.map((part, i) => {
              if (part.type === 'text') return <p key={i} className="chat-text">{part.text}</p>;
              if (!isTool(part)) return null;
              const chip = toolChip(part, busy && message === last);
              return <span key={i} className={`chat-chip chat-chip--${chip.state}`} title={chip.detail ?? chip.text}>{chip.text}</span>;
            })}
          </article>
        ))}
        {thinking && <div className="chat-thinking">Dan is thinking…</div>}
        {(status === 'error' && error) || stuckGate ? (
          <div className="chat-error" role="alert">
            <span>{status === 'error' && error ? errorText(error) : 'Stopped: the table is still locked.'}</span>
            <button onClick={() => { void regenerate(); focusInput(); }}>Retry</button>
            {stuckGate && <button onClick={() => dispatch({ type: 'released', gateId: stuckGate })}>Continue without Dan</button>}
          </div>
        ) : null}
      </div>
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea
          ref={inputRef} rows={3} value={input} aria-label="Message to Dan" placeholder="Ask Dan about this spot (Enter sends, Shift+Enter for a new line)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send(input); }
          }}
        />
        <div className="chat-buttons">
          {busy && <button type="button" className="chat-stop" onClick={() => { stopDan(); focusInput(); }}>Stop</button>}
          <button type="submit" className="chat-send" disabled={busy || !input.trim()}>Send</button>
        </div>
      </form>
    </aside>
  );
}
