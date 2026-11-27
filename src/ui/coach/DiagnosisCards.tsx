import { useEffect, useRef, useState } from 'react';
import { CONFIDENCE_STOPS, TOPICS } from '../../agent/contract';
import { answerQuestion, type DanMessage } from '../../app/coachSession';
import {
  askRecord, canSubmitAsk, canSubmitProbe, correctIndices, DEFAULT_CONFIDENCE_INDEX, displayOptions, emptySelection, letterAt,
  probeRecord, toggleDontKnow, toggleOption, toggleOther, type DisplayOption, type OptionOrder,
} from './questions';

type Part = DanMessage['parts'][number];
type QuestionPart = Extract<Part, { type: 'tool-probe' | 'tool-ask_user_question' }>;
type Ready = Extract<QuestionPart, { state: 'input-available' | 'output-available' }>;
type DonePart = Extract<Part, { type: 'tool-diagnosis_done'; state: 'output-available' }>;

/** Display order is derived from the call, so the form and the answered card letter the options the same way. */
const shown = (part: Ready) =>
  displayOptions(part.input.options, part.type === 'tool-probe', part.input.multiSelect === true, part.toolCallId);

/** Single-select options always carry letters; multi-select ones show a checkbox mark. */
function Mark({ order, index, on }: { order?: OptionOrder; index: number; on: boolean }) {
  return <span className="q-mark" aria-hidden>{letterAt(order, index) ?? (on ? '■' : '□')}</span>;
}

function Head({ part }: { part: Ready }) {
  const extra = part.type === 'tool-probe' ? part.input.context : part.input.details;
  return (
    <>
      <div className="q-kicker">{part.type === 'tool-probe' ? 'Probe' : 'Question'}{part.input.multiSelect ? ' · select all that apply' : ''}</div>
      <p className="q-question">{part.input.question}</p>
      {extra && <p className="q-context">{extra}</p>}
    </>
  );
}

/** The open question: select → confidence → thinking → submit. The correct answer and explanation stay in the call until then. */
export function QuestionForm({ part }: { part: Extract<QuestionPart, { state: 'input-available' }> }) {
  const probe = part.type === 'tool-probe';
  const multi = part.input.multiSelect === true;
  const { options, optionOrder } = shown(part);
  const [sel, setSel] = useState(emptySelection);
  const [confidence, setConfidence] = useState(DEFAULT_CONFIDENCE_INDEX);
  const [thinking, setThinking] = useState('');
  const [other, setOther] = useState('');
  const [text, setText] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  // "Другое" grows the card: keep its bottom (Submit) in view in the chat log.
  useEffect(() => { if (sel.other) formRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [sel.other]);
  const canSubmit = probe ? canSubmitProbe(sel) : canSubmitAsk(options.length > 0, sel, other, text);

  const submit = () => {
    if (!canSubmit) return;
    if (part.type === 'tool-probe') {
      answerQuestion<'probe'>(part.toolCallId, probeRecord({ options, optionOrder, correct: correctIndices(options, part.input.correctAnswer) }, sel, confidence, thinking));
    } else {
      answerQuestion<'ask_user_question'>(part.toolCallId, askRecord({ options, optionOrder }, sel, other, text, thinking));
    }
  };

  return (
    <form ref={formRef} className="q-card" aria-label={probe ? 'Probe question' : 'Question from Dan'} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Head part={part} />
      {options.length > 0 && (
        <div className="q-options" role="group" aria-label="Answer options">
          {options.map((o, i) => (
            <button key={o.value} type="button" className="q-option" aria-pressed={sel.selected.has(i)} onClick={() => setSel(toggleOption(multi, sel, i))}>
              <Mark order={optionOrder} index={i + 1} on={sel.selected.has(i)} />
              <span>{o.label}{o.description && <small className="q-desc">{o.description}</small>}</span>
            </button>
          ))}
          {probe ? (
            <button type="button" className="q-option q-option--aside" aria-pressed={sel.dontKnow} onClick={() => setSel(toggleDontKnow(sel))}>
              <span className="q-mark" aria-hidden>?</span><span>Не знаю</span>
            </button>
          ) : (
            <button type="button" className="q-option q-option--aside" aria-pressed={sel.other} onClick={() => setSel(toggleOther(multi, sel))}>
              <span className="q-mark" aria-hidden>…</span><span>Другое</span>
            </button>
          )}
          {!probe && sel.other && <input className="q-input" aria-label="Your own answer" value={other} onChange={(e) => setOther(e.target.value)} autoFocus />}
        </div>
      )}
      {probe && (
        <label className={`q-confidence${sel.dontKnow ? ' q-confidence--off' : ''}`}>
          <span>Confidence</span>
          <input
            type="range" aria-label="Confidence: the probability your pick is correct" min={0} max={CONFIDENCE_STOPS.length - 1} step={1} value={confidence} disabled={sel.dontKnow}
            aria-valuetext={`${CONFIDENCE_STOPS[confidence]} percent`} title="The probability your pick is correct: 50% is a coin flip"
            onChange={(e) => setConfidence(Number(e.target.value))}
          />
          <span className="q-confidence-value">{sel.dontKnow ? '—' : `${CONFIDENCE_STOPS[confidence]}%`}</span>
        </label>
      )}
      {options.length > 0 ? (
        <textarea className="q-input" rows={2} aria-label="Your thinking (optional)" placeholder="Your thinking (optional)" value={thinking} onChange={(e) => setThinking(e.target.value)} />
      ) : (
        <textarea className="q-input" rows={3} aria-label="Your answer" placeholder="Your answer" value={text} onChange={(e) => setText(e.target.value)} />
      )}
      <button type="submit" className="chat-send q-submit" disabled={!canSubmit}>Submit</button>
    </form>
  );
}

function OptionList({ options, order, picked, correct }: { options: DisplayOption[]; order?: OptionOrder; picked: Set<number>; correct?: Set<number> }) {
  return (
    <ul className="q-options">
      {options.map((o, i) => {
        const index = i + 1;
        const isPicked = picked.has(index);
        const isCorrect = correct?.has(index) ?? false;
        const state = isCorrect ? ' q-option--correct' : isPicked && correct ? ' q-option--wrong' : isPicked ? ' q-option--picked' : '';
        return (
          <li key={o.value} className={`q-option q-option--static${state}`}>
            <Mark order={order} index={index} on={isPicked} />
            <span className="q-option-label">{o.label}</span>
            {(isPicked || isCorrect) && (
              <span className="q-tags">
                {isPicked && <span className="q-tag q-tag--picked">your pick</span>}
                {isCorrect && <span className="q-tag q-tag--correct">correct</span>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export const Skipped = () => <div className="chat-event q-skipped">Question skipped</div>;

/** After submit: the verdict, the correct option(s) and the explanation for a probe; the player's answer for an ask. */
export function AnsweredQuestion({ part }: { part: Extract<QuestionPart, { state: 'output-available' }> }) {
  const { options, optionOrder } = shown(part);
  const o = part.output;
  // The player sent a message instead of answering.
  if ('dismissed' in o) return <Skipped />;
  const picked = new Set((o.answers ?? []).map((a) => a.index));
  if (part.type === 'tool-probe' && ('correct' in o || 'dontKnow' in o)) {
    const verdict = o.dontKnow ? 'Не знаю' : o.correct ? 'Correct' : 'Incorrect';
    return (
      <section className="q-card q-card--done" aria-label="Answered probe">
        <Head part={part} />
        <OptionList options={options} order={optionOrder} picked={picked} correct={new Set(correctIndices(options, part.input.correctAnswer))} />
        <p className={`q-verdict q-verdict--${o.dontKnow ? 'gap' : o.correct ? 'right' : 'wrong'}`}>
          {verdict}{o.confidence === undefined ? '' : ` · confidence ${o.confidence}%`}
        </p>
        {o.thinking && <p className="q-context">Your thinking: {o.thinking}</p>}
        <p className="q-explanation">{part.input.explanation}</p>
      </section>
    );
  }
  return (
    <section className="q-card q-card--done" aria-label="Answered question">
      <Head part={part} />
      {options.length > 0 && <OptionList options={options} order={optionOrder} picked={picked} />}
      {'other' in o && o.other && <p className="q-answer">Другое: {o.other}</p>}
      {'text' in o && o.text && <p className="q-answer">{o.text}</p>}
      {o.thinking && <p className="q-context">Your thinking: {o.thinking}</p>}
    </section>
  );
}

/** diagnosis_done succeeded: the assessment the player gets to see. */
export function AssessmentCard({ part }: { part: DonePart }) {
  const { strands, summary } = part.input.assessment;
  return (
    <section className="q-card q-card--done" aria-label="Diagnosis assessment">
      <div className="q-kicker">Level diagnosis · assessment</div>
      <dl className="q-strands">
        {strands.map((s) => (
          <div key={s.strand}><dt>{TOPICS[s.strand]}</dt><dd>{s.assessment}</dd></div>
        ))}
      </dl>
      <p className="q-explanation">{summary}</p>
    </section>
  );
}
