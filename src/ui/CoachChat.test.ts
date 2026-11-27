import { beforeEach, describe, expect, it } from 'vitest';
import { errorText, toolChip, type ToolPart } from './CoachChat';
import { chatRequestBody } from '../app/coachSession';
import { gameStore } from '../app/gameStore';

const part = (p: object) => ({ toolCallId: 't1', ...p }) as ToolPart;

beforeEach(() => gameStore.getState().reset());

describe('coach chat', () => {
  it('labels running, failed and finished tool calls with their key result', () => {
    expect(toolChip(part({ type: 'tool-equity', state: 'input-streaming' }), true)).toEqual({ text: 'Equity…', state: 'running' });
    expect(toolChip(part({ type: 'tool-outs', state: 'input-available', input: {} }), false)).toEqual({ text: 'Outs stopped', state: 'error' });
    expect(toolChip(part({ type: 'tool-spr', state: 'output-error', input: {}, errorText: 'no such tool' }), true).text).toBe('spr failed');
    expect(toolChip(part({ type: 'tool-outs', state: 'output-error', input: undefined, errorText: 'bad board' }), true)).toMatchObject({ text: 'Outs failed', state: 'error', detail: 'bad board' });
    expect(toolChip(part({ type: 'tool-icm', state: 'output-available', input: {}, output: { error: 'Bubble factor needs hero, opponent and risk together' } }), true).state).toBe('error');
    expect(toolChip(part({
      type: 'tool-equity', state: 'output-available',
      input: { hero: ['Ah', 'Kd'], board: [], opponents: ['TT+, AQs+', 'random'] },
      output: { equity: 0.38214, win: 0.37, tie: 0.01, iterations: 20000, standardErrorBound: 0.0034, rangeCombos: [] },
    }), true).text).toBe('Equity 38.2% vs TT+, AQs+ | random');
    expect(toolChip(part({ type: 'tool-pot_odds', state: 'output-available', input: {}, output: { requiredEquity: 0.25, oddsRatio: '3:1', finalPot: 200 } }), true).text).toBe('Pot odds: need 25.0%');
    expect(toolChip(part({ type: 'tool-icm', state: 'output-available', input: {}, output: { equities: [0.1837], expectedEquity: 0.1864, delta: 0.0027 } }), true).text).toBe('ICM 18.4% · EV Δ +0.27%');
    expect(toolChip(part({ type: 'tool-shove_ev', state: 'output-available', input: {}, output: { evChips: 66, evBB: 0.66, assumption: '' } }), true).text).toBe('Shove EV +66 chips (0.66 BB)');
    expect(toolChip(part({ type: 'tool-outs', state: 'output-available', input: {}, output: { completionCards: 9, nextCardProbability: 0.1915, byRiverProbability: 0.3497 } }), true).text).toBe('Outs 9: 19.1% next card, 35.0% by river');
    expect(toolChip(part({ type: 'tool-icm', state: 'output-available', input: {}, output: { equities: [0.65, 0.35] } }), true).text).toBe('ICM 65.0% / 35.0%');
  });

  it("shows the server's JSON error, a lost connection, or the raw message otherwise", () => {
    expect(errorText(new Error('{"error":"Coach is not configured: set OPENROUTER_API_KEY and OPENROUTER_MODEL"}'))).toMatch(/not configured/);
    expect(errorText(new TypeError('Failed to fetch'))).toBe('Lost connection to the coach server.');
    expect(errorText(new Error('Stream ended early'))).toBe('Stream ended early');
    expect(errorText(new Error('<html><body>502 Bad Gateway</body></html>'))).toBe('Coach could not answer right now.');
  });

  it('sends at most the capped unfolded messages plus the snapshot computed at send time', () => {
    const messages = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, parts: [{ type: 'text' as const, text: `q${i}` }] }));
    const body = chatRequestBody(messages);
    expect(body.messages).toHaveLength(40);
    expect(body.messages[0].id).toBe('m5');
    expect(body.snapshot).toBeNull();
    expect(body).toMatchObject({ mode: 'free', gate: null, summary: null });
  });
});
