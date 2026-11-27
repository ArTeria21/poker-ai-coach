// @vitest-environment happy-dom
import { dom, mockApi, tick, type, until, type Stream } from './appTestKit';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { chat, setTrainingMode, stopDiagnosis, useDiagnosisStore } from './coachSession';
import { decisionGateId } from '../agent/training';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';

const store = () => useGameStore.getState();
const PROBE = {
  question: 'Какое решение лучше?',
  context: 'Ривер, банк 300, соперник ставит 30. У тебя около 30% эквити.',
  options: [{ label: 'Колл', value: 'call' }, { label: 'Фолд', value: 'fold' }, { label: 'Рейз', value: 'raise' }],
  explanation: 'Колл 30 в итоговый банк 360 требует около 8% эквити.',
  correctAnswer: 'call',
};
const PROBE2 = { ...PROBE, question: 'Второй вопрос?', options: [{ label: 'Да', value: 'yes' }, { label: 'Нет', value: 'no' }], explanation: 'Потому что нет.', correctAnswer: 'no' };
const ASK = { question: 'Что хочешь улучшить?', options: [{ label: 'Префлоп' }, { label: 'Игру на баббле' }] };
const DONE_INPUT = {
  assessment: { strands: [{ strand: 'pot-odds', assessment: 'Считает шансы банка уверенно; потолок не найден.' }], summary: 'Начнём с ICM на баббле.' },
  topicStatuses: [{ topic: 'pot-odds', status: 2 }], bottlenecks: [], workingState: '## Current Workbench\n## Conventions\n## Student Profile',
};

let container: HTMLDivElement;
let root: Root;
let streams: Stream[];
let status: () => Response | Promise<Response>;
let api: ReturnType<typeof mockApi>;
const chatCalls = () => api.chatCalls();
const bodies = () => api.bodies();
const { button, click, locked, say } = dom(() => container);
const forms = () => container.querySelectorAll('form.q-card');
const probeParts = () => chat.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool-probe');
/** The last part of a type in a request's last message, as the client sent it. */
const sentPart = (body: { messages: { parts: { type: string; output?: object }[] }[] }, type: string) => body.messages.at(-1)!.parts.filter((p) => p.type === type).at(-1);

async function mount() {
  await act(async () => root.render(<App />));
  await tick();
}
async function startDiagnosis() {
  await click('Diagnose level');
  await tick();
}
/** Starts the diagnosis and lets Dan's first response pose a probe. */
async function posed(id = 'call_p1', input: object = PROBE) {
  await mount();
  await startDiagnosis();
  streams[0].call('probe', id, input);
  streams[0].end();
  await tick();
}
async function answer(label: string) {
  await click(label);
  await click('Submit');
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ speed: 'fast', soundEnabled: false });
  setTrainingMode('free');
  streams = [];
  status = () => Response.json({ initialized: true });
  api = mockApi(streams, () => status());
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  stopDiagnosis();
  await chat.stop();
  chat.clearError();
  chat.messages = [];
  useDiagnosisStore.setState({ initialized: null });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('level diagnosis', () => {
  it('offers the diagnosis in the greeting only while memory is empty and the chat is new', async () => {
    await mount();
    expect(button('Пройти диагностику')).toBeUndefined();
    act(() => root.unmount());

    // Back to unknown, so the offline mount cannot inherit a status.
    useDiagnosisStore.setState({ initialized: null });
    status = () => Promise.reject(new Error('offline'));
    root = createRoot(container);
    await mount();
    expect(button('Пройти диагностику')).toBeUndefined();
    expect(useDiagnosisStore.getState().initialized).toBeNull();
    act(() => root.unmount());

    status = () => Response.json({ initialized: false });
    root = createRoot(container);
    await mount();
    expect(container.querySelector('.chat-example')).not.toBeNull();
    await click('Пройти диагностику');
    await tick();
    expect(bodies()[0]).toMatchObject({ phase: 'diagnosis', gate: null });
    expect(bodies()[0].messages[0].parts[0].text).toMatch(/^\[Диагностика\]/);
    expect(container.querySelector('.chat-event')?.textContent).toBe('Level diagnosis');
    expect(button('Пройти диагностику')).toBeUndefined();
  });

  it('never shows the answer before submit, sends the compact record once, and the chat continues by itself', async () => {
    await mount();
    await startDiagnosis();
    // A call that failed the schema: its error text holds the whole input, answer included.
    streams[0].rejected('probe', 'call_bad', { ...PROBE, correctAnswer: 'check' });
    streams[0].call('probe', 'call_p1', PROBE);
    streams[0].end();
    await tick();
    const form = forms()[0];
    expect(forms()).toHaveLength(1);
    expect(form.textContent).toContain(PROBE.context);
    expect(container.innerHTML).not.toContain(PROBE.explanation);
    // Attributes included: no verdict markup, no option value, no explanation.
    expect(form.outerHTML).not.toMatch(/q-option--correct|q-tag|"call"|8% эквити/);
    // The display order is the call's stable shuffle: Рейз, Фолд, Колл.
    expect([...form.querySelectorAll('.q-option')].map((b) => b.textContent)).toEqual(['AРейз', 'BФолд', 'CКолл', '?Не знаю']);
    expect(button('Submit')!.disabled).toBe(true);

    await click('Колл');
    await type(form.querySelector<HTMLInputElement>('input[type=range]')!, '3');
    await type(form.querySelector<HTMLTextAreaElement>('textarea')!, 'нужно 8%, есть 30%');
    // Two clicks in one tick still answer once.
    await act(async () => { button('Submit')!.click(); button('Submit')?.click(); });
    await tick();
    expect(chatCalls()).toHaveLength(2);
    expect(bodies()[1].phase).toBe('diagnosis');
    expect(sentPart(bodies()[1], 'tool-probe')).toMatchObject({
      state: 'output-available',
      output: { optionOrder: { A: 3, B: 2, C: 1 }, answers: [{ index: 3, label: 'Колл', letter: 'C' }], correct: true, confidence: 70, thinking: 'нужно 8%, есть 30%' },
    });
    expect(forms()).toHaveLength(0);
    expect(container.querySelector('.q-verdict')?.textContent).toBe('Correct · confidence 70%');
    expect(container.textContent).toContain(PROBE.explanation);

    // The continuation ends with plain text: no further request.
    streams[1].end('Следующий вопрос позже.');
    await tick();
    await tick();
    expect(chatCalls()).toHaveLength(2);
  });

  it('answers two questions of one step one after another and continues only after the second', async () => {
    await mount();
    await startDiagnosis();
    streams[0].call('ask_user_question', 'call_q1', ASK);
    streams[0].call('probe', 'call_p2', PROBE);
    streams[0].end();
    await tick();
    expect(forms()).toHaveLength(1);
    expect(container.textContent).not.toContain(PROBE.question);

    await click('Другое');
    expect(button('Submit')!.disabled).toBe(true);
    await type(container.querySelector<HTMLInputElement>('form input.q-input')!, 'Турниры, играю год');
    await click('Submit');
    await tick();
    expect(chatCalls()).toHaveLength(1);
    expect(container.textContent).toContain('Другое: Турниры, играю год');
    expect(container.textContent).toContain(PROBE.question);

    await click('Не знаю');
    expect(container.querySelector<HTMLInputElement>('form.q-card input[type=range]')!.disabled).toBe(true);
    await click('Submit');
    await tick();
    expect(chatCalls()).toHaveLength(2);
    expect(sentPart(bodies()[1], 'tool-ask_user_question')).toMatchObject({ output: { optionOrder: { A: 1, B: 2 }, other: 'Турниры, играю год' } });
    expect(sentPart(bodies()[1], 'tool-probe')!.output).toEqual({ dontKnow: true, optionOrder: { A: 2, B: 3, C: 1 } });
    const dk = container.querySelector('[aria-label="Answered probe"]')!;
    expect(dk.querySelector('.q-verdict')?.textContent).toBe('Не знаю');
    expect(dk.querySelector('.q-option--correct')?.textContent).toContain('Колл');
    expect(dk.textContent).toContain(PROBE.explanation);
    streams[1].end('Ок.');
    await tick();
  });

  it('never continues by itself after ordinary turns, math tools or releases', async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-example')!.click());
    await tick();
    streams[0].tool('pot_odds', 'call_0', {}, { requiredEquity: 0.25, oddsRatio: '3:1', finalPot: 200 });
    streams[0].tool('release_actions', 'call_1', {}, { released: 'x#1', kind: 'decision' });
    streams[0].end('Нужно 25%.');
    await tick();
    await tick();
    expect(chatCalls()).toHaveLength(1);
    expect(bodies()[0].phase).toBeNull();
  });

  it('a card is answerable only in the last message and only when Dan is idle; typing instead dismisses it', async () => {
    await mount();
    await startDiagnosis();
    streams[0].call('probe', 'call_p1', PROBE);
    await tick();
    // Still streaming.
    expect(forms()).toHaveLength(0);
    streams[0].end();
    await tick();
    expect(forms()).toHaveLength(1);

    await say('Не понял вопрос');
    await tick();
    expect(chatCalls()).toHaveLength(2);
    expect(bodies()[1].messages.at(-2).parts.find((p: { type: string }) => p.type === 'tool-probe')).toMatchObject({ state: 'output-available', output: { dismissed: true } });
    expect(bodies()[1].messages.at(-1).parts[0].text).toBe('Не понял вопрос');
    expect(forms()).toHaveLength(0);
    expect(container.querySelector('.q-skipped')).not.toBeNull();
    streams[1].end('Перефразирую.');
    await tick();
    expect(forms()).toHaveLength(0);
  });

  it('typing dismisses every open question of the step', async () => {
    await mount();
    await startDiagnosis();
    streams[0].call('ask_user_question', 'call_q1', ASK);
    streams[0].call('probe', 'call_p2', PROBE);
    streams[0].end();
    await tick();
    await say('Пропущу');
    await tick();
    const sent = bodies()[1].messages.at(-2).parts.filter((p: { type: string }) => p.type === 'tool-probe' || p.type === 'tool-ask_user_question');
    expect(sent.map((p: { output: object }) => p.output)).toEqual([{ dismissed: true }, { dismissed: true }]);
    expect(container.querySelectorAll('.q-skipped')).toHaveLength(2);
    streams[1].end('Ок.');
    await tick();
  });

  it('Retry regenerates an ordinary answer of Dan', async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-example')!.click());
    await tick();
    streams[0].tool('pot_odds', 'call_0', {}, { requiredEquity: 0.25, oddsRatio: '3:1', finalPot: 200 });
    streams[0].fail();
    await tick();
    await click('Retry');
    await tick();
    expect(chatCalls()).toHaveLength(2);
    // The failed partial answer is dropped: the request ends with the player's question.
    expect(bodies()[1].messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    streams[1].end('Ок.');
    await tick();
  });

  it('Retry after a failed continuation keeps the answered cards and continues Dan\'s message', async () => {
    await posed();
    api.spy.mockResolvedValueOnce(Response.json({ error: 'Coach could not answer' }, { status: 500 }));
    await answer('Колл');
    expect(container.querySelector('.chat-error')?.textContent).toContain('Coach could not answer');
    await click('Retry');
    await tick();
    expect(chatCalls()).toHaveLength(3);
    expect(container.querySelector('.q-verdict')?.textContent).toMatch(/^Correct/);
    expect(sentPart(bodies()[2], 'tool-probe')).toMatchObject({ output: { correct: true } });
    expect(bodies()[2].messages).toHaveLength(2);
    streams[1].end('Ок.');
    await tick();
  });

  it('answers the right card when the provider reuses call ids, in the same message and in a later one', async () => {
    await posed('call_0');
    await answer('Колл');
    // The continuation's next step reuses the id.
    streams[1].call('probe', 'call_0', PROBE2);
    streams[1].end();
    await tick();
    expect(forms()).toHaveLength(1);
    await answer('Нет');
    expect(chatCalls()).toHaveLength(3);
    expect(probeParts().map((p) => p.state === 'output-available' && 'correct' in p.output && p.output.answers![0].label)).toEqual(['Колл', 'Нет']);

    streams[2].end('Расскажи, как считаешь.');
    await tick();
    await say('По формуле');
    await tick();
    streams[3].call('probe', 'call_0', PROBE2);
    streams[3].end();
    await tick();
    await answer('Да');
    expect(chatCalls()).toHaveLength(5);
    expect(probeParts().map((p) => p.state === 'output-available' && 'correct' in p.output && p.output.correct)).toEqual([true, true, false]);
    streams[4].end('Ок.');
    await tick();
  });

  it('suspends Training during the diagnosis and resumes it afterwards: the next decision locks again', async () => {
    setTrainingMode('training');
    await mount();
    await until(() => store().heroLegal !== null);
    await tick();
    expect(locked()).toBe(true);
    streams[0].end('Какой план?');
    await tick();

    await startDiagnosis();
    expect(locked()).toBe(false);
    expect(bodies()[1]).toMatchObject({ phase: 'diagnosis', mode: 'free', gate: null });
    expect(button('training')!.disabled).toBe(true);
    const decision = decisionGateId(store().handId!, store().handActions.length);

    streams[1].tool('diagnosis_done', 'call_d', DONE_INPUT, { saved: true, note: 'ack' });
    streams[1].end('Начнём с ICM.');
    await tick();
    expect(container.querySelector('[aria-label="Diagnosis assessment"]')?.textContent).toContain('Шансы банка и требуемое эквити');
    expect(useDiagnosisStore.getState()).toMatchObject({ resume: null, initialized: true });
    expect(button('training')!.disabled).toBe(false);
    // The decision on screen counts as handled: still unlocked, no new trigger.
    expect(decisionGateId(store().handId!, store().handActions.length)).toBe(decision);
    expect(locked()).toBe(false);
    await tick();
    expect(chatCalls()).toHaveLength(2);

    // Training is back: the next hand's decision locks with exactly one trigger.
    await click('Fold');
    await until(() => store().awaitingNext);
    const hand = store().handId;
    await click('Deal next hand');
    await until(() => store().heroLegal !== null && store().handId !== hand);
    await tick();
    expect(locked()).toBe(true);
    expect(chatCalls()).toHaveLength(3);
    expect(bodies()[2]).toMatchObject({ mode: 'training', phase: null, gate: { kind: 'decision' } });
  });

  it('a refused diagnosis_done keeps the phase', async () => {
    await mount();
    await startDiagnosis();
    streams[0].tool('diagnosis_done', 'call_d', DONE_INPUT, { error: 'A question is still open' });
    streams[0].end('Сначала ответь на вопрос.');
    await tick();
    expect(useDiagnosisStore.getState().resume).toBe('free');
    expect(button('Stop diagnosis')).toBeDefined();
    expect(container.querySelector('[aria-label="Diagnosis assessment"]')).toBeNull();
  });

  it('Stop diagnosis aborts a running answer, skips the open card and later requests carry no phase', async () => {
    await mount();
    await startDiagnosis();
    await click('Stop diagnosis');
    await tick();
    expect((chatCalls()[0][1]!.signal as AbortSignal).aborted).toBe(true);
    expect(chat.status).toBe('ready');

    await startDiagnosis();
    streams[1].call('probe', 'call_p1', PROBE);
    streams[1].end();
    await tick();
    expect(forms()).toHaveLength(1);
    await click('Stop diagnosis');
    expect(forms()).toHaveLength(0);
    expect(container.querySelector('.q-skipped')).not.toBeNull();
    expect(container.textContent).not.toContain(PROBE.explanation);

    await say('Давай просто играть');
    await tick();
    expect(chatCalls()).toHaveLength(3);
    expect(bodies()[2].phase).toBeNull();
    // The skipped card stays unanswered: it is not dismissed after the phase.
    expect(sentPart({ messages: bodies()[2].messages.slice(0, -1) }, 'tool-probe')).toMatchObject({ state: 'input-available' });
    streams[2].end('Ок.');
    await tick();
  });
});
