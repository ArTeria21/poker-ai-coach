import { describe, expect, it } from 'vitest';
import { diagnosisTools } from '../../../server/tools';
import { askRecord, correctIndices, displayOptions, emptySelection, probeRecord, toggleDontKnow, toggleOption, toggleOther } from './questions';

const OPTIONS = [{ label: 'Колл', value: 'call' }, { label: 'Фолд', value: 'fold' }, { label: 'Рейз' }];
// The server validates every answer record in the history with these schemas.
const { probe, ask_user_question: ask } = diagnosisTools(null, false);
const valid = (schema: typeof probe.outputSchema | typeof ask.outputSchema, record: unknown) => (schema as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse(record).success;

describe('diagnosis question core', () => {
  it('shuffles probe options stably per call, letters single-select ones and keeps ask options in order', () => {
    const a = displayOptions(OPTIONS, true, false, 'call_p1');
    expect(a).toEqual(displayOptions(OPTIONS, true, false, 'call_p1'));
    expect(a.options.map((o) => o.value)).toEqual(['Рейз', 'fold', 'call']);
    expect(a.optionOrder).toEqual({ A: 3, B: 2, C: 1 });
    expect(displayOptions(OPTIONS, true, true, 'call_p1').optionOrder).toBeUndefined();
    expect(displayOptions(OPTIONS, false, false, 'call_p1')).toMatchObject({ options: [{ value: 'call' }, { value: 'fold' }, { value: 'Рейз' }], optionOrder: { A: 1, B: 2, C: 3 } });
  });

  it('selection: single displaces, multi toggles, "Don\'t know" clears every pick', () => {
    let sel = toggleOption(false, emptySelection(), 0);
    sel = toggleOption(false, sel, 2);
    expect([...sel.selected]).toEqual([2]);
    expect(toggleOther(false, sel)).toEqual({ selected: new Set(), other: true, dontKnow: false });
    const multi = toggleOther(true, toggleOption(true, toggleOption(true, emptySelection(), 0), 2));
    expect(multi).toEqual({ selected: new Set([0, 2]), other: true, dontKnow: false });
    expect(toggleOption(true, multi, 0).selected).toEqual(new Set([2]));
    const dk = toggleDontKnow(multi);
    expect(dk).toEqual({ selected: new Set(), other: false, dontKnow: true });
    expect(toggleOption(false, dk, 1).dontKnow).toBe(false);
  });

  it('grades by exact set and builds the compact records the server accepts', () => {
    const { options, optionOrder } = displayOptions(OPTIONS, true, false, 'call_p1');
    const correct = correctIndices(options, 'call');
    expect(correct).toEqual([3]);
    const right = probeRecord({ options, optionOrder, correct }, toggleOption(false, emptySelection(), 2), 3, '  колл по шансам ');
    expect(right).toEqual({ optionOrder, answers: [{ index: 3, label: 'Колл', letter: 'C' }], correct: true, confidence: 70, thinking: 'колл по шансам' });
    const wrong = probeRecord({ options, optionOrder, correct }, toggleOption(false, emptySelection(), 0), 2, ' ');
    expect(wrong).toEqual({ optionOrder, answers: [{ index: 1, label: 'Рейз', letter: 'A' }], correct: false, confidence: 50 });
    const dk = probeRecord({ options, optionOrder, correct }, toggleDontKnow(emptySelection()), 5, '');
    expect(dk).toEqual({ dontKnow: true, optionOrder });

    const multi = displayOptions(OPTIONS, true, true, 'call_p1');
    const both = correctIndices(multi.options, ['call', 'fold']);
    const partial = probeRecord({ ...multi, correct: both }, toggleOption(true, emptySelection(), 2), 2, '');
    expect(partial).toEqual({ answers: [{ index: 3, label: 'Колл' }], correct: false, confidence: 50 });
    expect(probeRecord({ ...multi, correct: both }, { selected: new Set([2, 1]), other: false, dontKnow: false }, 2, '')).toMatchObject({ correct: true });
    for (const r of [right, wrong, dk, partial]) expect(valid(probe.outputSchema, r)).toBe(true);
    expect(valid(probe.outputSchema, { ...dk, confidence: 50 })).toBe(false);
    // The player wrote instead of answering.
    expect(valid(probe.outputSchema, { dismissed: true }) && valid(ask.outputSchema, { dismissed: true })).toBe(true);
    expect(valid(probe.outputSchema, { dismissed: true, correct: false })).toBe(false);

    const asked = displayOptions(OPTIONS, false, false, 'call_q1');
    const other = askRecord(asked, toggleOther(false, emptySelection()), ' турниры 6-max ', '', 'играю год');
    expect(other).toEqual({ optionOrder: { A: 1, B: 2, C: 3 }, other: 'турниры 6-max', thinking: 'играю год' });
    expect(askRecord(asked, toggleOption(false, emptySelection(), 1), 'ignored', '', '')).toEqual({ optionOrder: { A: 1, B: 2, C: 3 }, answers: [{ index: 2, label: 'Фолд', letter: 'B' }] });
    const free = askRecord(displayOptions(undefined, false, false, 'q'), emptySelection(), '', ' MTT ', '');
    expect(free).toEqual({ text: 'MTT' });
    for (const r of [other, free]) expect(valid(ask.outputSchema, r)).toBe(true);
  });
});
