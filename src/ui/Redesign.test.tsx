// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true }));
vi.mock('../game/sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));

import { createTournament } from '../game/tournament';
import { tableController } from '../game/tableController';
import { useGameStore, type SeatView } from '../store/gameStore';
import type { Avatar } from '../bots/lineup';
import { useSettingsStore } from '../store/settingsStore';
import { App } from './App';
import { AnsweredQuestion } from './DiagnosisCards';
import { TournamentPanel } from './TournamentPanel';
import { ActionBar } from './table/ActionBar';
import { CardView } from './table/CardView';
import { PokerTable } from './table/PokerTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFixture() {
  const tournament = createTournament(
    [
      { id: 'hero', name: 'You', isHero: true },
      { id: 'bot-1', name: 'Ivan', isHero: false },
      { id: 'bot-2', name: 'Lena', isHero: false },
      { id: 'bot-3', name: 'Mateo', isHero: false },
      { id: 'bot-4', name: 'Priya', isHero: false },
      { id: 'bot-5', name: 'Hugo', isHero: false },
    ],
    0,
    'ui-test',
  );
  const positions = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'] as const;
  const avatars: Avatar[] = ['shark', 'owl', 'key', 'cactus', 'rocket'];
  const seats: SeatView[] = tournament.players.map((p, i) => ({
    ...p,
    avatar: p.isHero ? null : avatars[i - 1],
    position: positions[i],
    streetBet: 0,
    committed: 0,
    folded: false,
    allIn: false,
    holeCards: p.isHero ? ['As', 'Kd'] : null,
    hasCards: true,
    isButton: i === 0,
    isActing: false,
    lastAction: null,
    showdownDescription: null,
    wonAmount: null,
    eliminated: false,
  }));
  return { tournament, seats };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useGameStore.getState().reset();
  useSettingsStore.setState({
    difficulty: 'medium',
    speed: 'fast',
    soundEnabled: false,
    displayBB: false,
    fourColorDeck: false,
    mode: 'free',
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('Botanical Casino Glasshouse UI & fixes', () => {
  it('places .result-banner inside .table-center and suppresses stale .bet-chip at showdown while keeping dealer button', () => {
    const { seats } = makeFixture();
    seats[3].isButton = true;
    seats[0].isButton = false;
    seats[3].lastAction = { type: 'raise', amount: 120 };
    seats[0].wonAmount = 2450;
    useGameStore.getState().publish({
      seats,
      board: ['Ah', 'Kh', 'Qh', 'Jh', '2c'],
      pot: 2450,
      bigBlind: 20,
      phase: 'complete',
      banner: 'You win 2,450 with a Royal Flush',
    });

    act(() => root.render(<PokerTable />));
    const center = container.querySelector('.table-center')!;
    expect(center.querySelector('.result-banner')?.textContent).toBe('You win 2,450 with a Royal Flush');
    expect(container.querySelectorAll('.bet-chip')).toHaveLength(0);
    expect(container.querySelector('.bet-spot--pos3 .dealer-button')?.textContent).toBe('D');
    expect(container.querySelector('.seat--pos0 .seat-won')?.textContent).toBe('+2,450');
    expect(container.querySelector('.seat--pos0 .seat-pos')?.textContent).toBe('BTN');
    // Hidden bot archetypes: no tooltip; each bot shows its drawn decorative figurine, the hero the hero emblem.
    expect(container.querySelector('.seat--pos1 .seat-pod')?.getAttribute('title')).toBeNull();
    expect(container.querySelector('.seat--pos1 .seat-avatar svg')?.getAttribute('data-avatar')).toBe('shark');
    expect([...container.querySelectorAll('.seat-avatar svg[data-avatar]')].map((svg) => svg.getAttribute('data-avatar')).sort()).toEqual(['cactus', 'key', 'owl', 'rocket', 'shark']);
    expect(container.querySelector('.seat--pos0 .seat-avatar svg')?.getAttribute('class')).toContain('seat-avatar-svg--hero');
  });

  it('toggles Chips vs BB display across pot, stacks, bets, and payouts', () => {
    const { seats } = makeFixture();
    seats[1].lastAction = { type: 'bet', amount: 60 };
    seats[0].wonAmount = 200;
    useGameStore.getState().publish({
      seats,
      pot: 120,
      bigBlind: 20,
      phase: 'flop',
    });
    useSettingsStore.setState({ displayBB: true });

    act(() => root.render(<PokerTable />));
    expect(container.querySelector('.pot-amount')?.textContent).toBe('6.0 BB');
    expect(container.querySelector('.seat--pos0 .seat-stack')?.textContent).toBe('100.0 BB');
    expect(container.querySelector('.bet-spot--pos1 .bet-chip')?.textContent).toContain('3.0 BB');
    expect(container.querySelector('.seat--pos0 .seat-won')?.textContent).toBe('+10.0 BB');
  });

  it('switches CardView between 2-color and 4-color deck classes', () => {
    useSettingsStore.setState({ fourColorDeck: false });
    act(() => root.render(
      <>
        <CardView card="Ad" />
        <CardView card="Ac" />
      </>,
    ));
    expect(container.children[0].className).toContain('card--red');
    expect(container.children[1].className).toContain('card--black');

    act(() => {
      useSettingsStore.setState({ fourColorDeck: true });
    });
    act(() => root.render(
      <>
        <CardView card="Ah" />
        <CardView card="Ad" />
        <CardView card="Ac" />
        <CardView card="As" />
      </>,
    ));
    expect(container.children[0].className).toContain('card--red');
    expect(container.children[1].className).toContain('card--blue');
    expect(container.children[2].className).toContain('card--green');
    expect(container.children[3].className).toContain('card--black');
  });

  it('avoids duplicating "You · you" in TournamentPanel and closes on Escape / outside click', () => {
    const { tournament, seats } = makeFixture();
    act(() => root.render(<TournamentPanel tournament={tournament} seats={seats} />));
    const details = container.querySelector<HTMLDetailsElement>('.tournament-panel')!;
    expect(details.textContent).not.toContain('You · you');

    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(details.open).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(details.open).toBe(false);

    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(details.open).toBe(false);
  });

  it('wraps dual .q-tag pills inside .q-tags in AnsweredQuestion', () => {
    // With toolCallId 'call_p1', displayOptions shuffles ['Call', 'Fold'] -> ['Fold', 'Call'], so Call is index 2.
    const part = {
      type: 'tool-probe' as const,
      toolCallId: 'call_p1',
      state: 'output-available' as const,
      input: {
        question: 'Best play?',
        context: 'River',
        options: [{ label: 'Call', value: 'call' }, { label: 'Fold', value: 'fold' }],
        explanation: 'Call is +EV.',
        correctAnswer: 'call',
      },
      output: {
        optionOrder: { A: 2, B: 1 },
        answers: [{ index: 2, label: 'Call', letter: 'B' }],
        correct: true,
        confidence: 80,
      },
    };
    act(() => root.render(<AnsweredQuestion part={part} />));
    const tags = container.querySelector('.q-option--correct .q-tags');
    expect(tags).not.toBeNull();
    expect([...tags!.querySelectorAll('.q-tag')].map((el) => el.textContent)).toEqual(['your pick', 'correct']);
  });

  it('shows preflop vs postflop presets, syncs number input, and supports safe keyboard shortcuts', () => {
    const actSpy = vi.spyOn(tableController, 'humanAct').mockImplementation(() => {});
    useGameStore.getState().publish({
      phase: 'preflop',
      pot: 30,
      currentBet: 20,
      bigBlind: 20,
      status: 'playing',
      heroLegal: { seatIndex: 0, fold: true, check: false, call: { amount: 20, allIn: false }, raise: { minTo: 40, maxTo: 2000 } },
    });

    act(() => root.render(<ActionBar />));
    const preflopPresets = [...container.querySelectorAll('.raise-presets .preset')].map((b) => b.textContent);
    expect(preflopPresets).toEqual(['Min', '2.5x', '3x', 'Pot', 'All-in']);

    // Typing inside the number input must NOT trigger keyboard fold/call/raise shortcuts
    const numInput = container.querySelector<HTMLInputElement>('input.raise-number')!;
    act(() => {
      numInput.focus();
      numInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    });
    expect(actSpy).not.toHaveBeenCalled();

    // Pressing R outside editable elements raises to current slider/number amount
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    });
    expect(actSpy).toHaveBeenCalledWith({ type: 'raise', amount: 40 });

    // Postflop presets
    act(() => {
      useGameStore.getState().publish({ phase: 'flop', currentBet: 0, pot: 120 });
    });
    const postflopPresets = [...container.querySelectorAll('.raise-presets .preset')].map((b) => b.textContent);
    expect(postflopPresets).toEqual(['Min', '½ Pot', '¾ Pot', 'Pot', 'All-in']);
  });

  it('guards New SNG mid-tournament with inline Confirm? and toggles BB / 4C header buttons', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ initialized: true }));
    const startSpy = vi.spyOn(tableController, 'startSession').mockImplementation(() => {});

    await act(async () => root.render(<App />));
    expect(startSpy).toHaveBeenCalledTimes(1);

    const bbBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Show big blinds"]')!;
    const deckBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to 4-color deck"]')!;
    act(() => bbBtn.click());
    act(() => deckBtn.click());
    expect(useSettingsStore.getState().displayBB).toBe(true);
    expect(useSettingsStore.getState().fourColorDeck).toBe(true);

    // Mid-tournament (handNumber > 1, playing): first click enters Confirm?, second click resets
    act(() => {
      useGameStore.getState().publish({ handNumber: 4, status: 'playing' });
    });
    const newBtn = container.querySelector<HTMLButtonElement>('.new-tournament')!;
    expect(newBtn.textContent).toBe('New SNG');
    act(() => newBtn.click());
    expect(newBtn.textContent).toBe('Confirm?');
    expect(startSpy).toHaveBeenCalledTimes(1);

    act(() => newBtn.click());
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});
