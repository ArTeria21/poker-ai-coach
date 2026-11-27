import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coachSnapshotSchema } from '../agent/contract';
import { coachSnapshot } from './coachSnapshot';
import { TableController } from './tableController';
import { beginTournamentHand, createTournament } from '../game/tournament';
import { applyAction, startHand } from '../engine/gameStateMachine';
import { legalActions } from '../engine/bettingRules';
import { mulberry32 } from '../random';
import type { GameState } from '../engine/types';
import { gameStore } from './gameStore';
import type { GameViewState } from './tableView';
import { useSettingsStore } from './settingsStore';

vi.mock('./sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
vi.mock('../random', async (original) => {
  let n = 0;
  return { ...await original<typeof import('../random')>(), randomSeed: () => (++n * 2654435761) >>> 0 };
});

const store = () => gameStore.getState();
const lineup = [
  { id: 'hero', name: 'You', isHero: true },
  ...['Ivan', 'Lena', 'Mateo', 'Priya', 'Hugo'].map((name, i) => ({ id: `bot-${i + 1}`, name, isHero: false })),
];
/** Card strings that appear as whole JSON string values. */
const jsonCards = (json: string) => new Set([...json.matchAll(/"([2-9TJQKA][cdhs])"/g)].map((m) => m[1]));

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ speed: 'fast', soundEnabled: false });
  store().reset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('coach snapshot', () => {
  it('is null before a table exists', () => {
    expect(coachSnapshot(store())).toBeNull();
  });

  it('never exposes hidden cards, the deck or seeds while real bots play many hands', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // button seat; bots and hero use seeded rngs
    const controller = new TableController();
    let checked = 0, showdowns = 0, foldWins = 0, bluffShows = 0;
    const unsubscribe = gameStore.subscribe((view: GameViewState, prev: GameViewState) => {
      if (view.seats === prev.seats) return; // log only; the snapshot ignores it
      const { state: st, reveals } = controller as unknown as { state: GameState; reveals: Map<number, string> };
      const snapshot = coachSnapshot(view)!;
      coachSnapshotSchema.parse(snapshot);
      const json = JSON.stringify(snapshot);
      expect(json).not.toMatch(/"(seed|deck|deckIndex)":/);
      // The hand id is the tournament's public id plus the hand number; the deal seed is a separate draw.
      expect(snapshot.handId).toBe(`${view.tournament!.id}-hand-${snapshot.handNumber}`);
      expect(snapshot.handId).toBe(st.handId);
      expect(snapshot.handId).not.toContain(String(st.seed));
      expect(snapshot.handId).not.toContain(st.seed.toString(36));
      const visible = new Set([...st.board, ...(snapshot.hero.cards ?? [])]);
      // Bot cards are public only at a real showdown or after a voluntary show.
      const live = st.players.filter((p) => !p.folded);
      const showdown = st.phase === 'complete' && live.length > 1;
      for (const p of st.players) if (!p.folded && (showdown || reveals.has(p.seatIndex))) p.holeCards.forEach((c) => visible.add(c));
      const hidden = st.deck.filter((c) => !visible.has(c));
      const shown = jsonCards(json);
      expect(hidden.filter((c) => shown.has(c))).toEqual([]);
      if (showdown) showdowns++;
      // Once per hand: the awaitingNext update follows any bluff show.
      if (view.awaitingNext && !prev.awaitingNext && live.length === 1 && !live[0].isHero) (reveals.size ? bluffShows++ : foldWins++);
      checked++;
    });
    const rng = mulberry32(7);
    controller.startSession();
    for (let i = 0; i < 20000 && store().status !== 'tournamentComplete'; i++) {
      const legal = store().heroLegal;
      if (legal) {
        const r = rng();
        controller.humanAct(r < 0.2 && legal.fold ? { type: 'fold' }
          : r < 0.35 && legal.raise ? { type: 'raise', amount: r < 0.25 ? legal.raise.maxTo : legal.raise.minTo }
          : { type: legal.check ? 'check' : 'call' });
      }
      if (store().awaitingNext) controller.continueNextHand();
      await vi.advanceTimersByTimeAsync(500);
    }
    unsubscribe();
    controller.stop();
    expect(store().handNumber).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(100);
    expect(showdowns).toBeGreaterThan(0);
    expect(foldWins).toBeGreaterThan(0);
    expect(bluffShows).toBeGreaterThan(0);
  }, 60_000);

  type Act = ['fold' | 'check' | 'call' | 'raise', number?];
  /** Dead button on busted seat 1, seat 4 busted; hand-local order: hero(0), Lena(1, SB), Mateo(2, BB), Hugo(3). */
  function deadButtonHand(acts: Act[], stacks = [3000, 0, 1500, 2500, 0, 5000]) {
    const t = createTournament(lineup, 0, 't');
    t.players.forEach((p, i) => Object.assign(p, { stack: stacks[i], place: stacks[i] ? null : i === 1 ? 6 : 5 }));
    // Previous hand: SB on seat 1 (since busted), BB on seat 2.
    Object.assign(t, { completedHands: 12, smallBlindSeat: 1, bigBlindSeat: 2 });
    const begun = beginTournamentHand(t);
    let state = startHand(begun.config, 1, begun.handId).state;
    for (const [type, amount] of acts) state = applyAction(state, { type, amount }).state;
    const controller = new TableController() as unknown as Record<string, unknown> & { publishSnapshot(o?: Partial<GameViewState>): void };
    Object.assign(controller, { tournament: begun.tournament, state, handNumber: 13 });
    controller.publishSnapshot({ heroLegal: legalActions(state)?.seatIndex === 0 ? legalActions(state) : null });
    return coachSnapshotSchema.parse(coachSnapshot(store()));
  }
  const preflop: Act[] = [['raise', 150], ['call'], ['fold'], ['call']];
  const flopBet: Act[] = [...preflop, ['check'], ['raise', 200]];

  it('maps a dead-button hand with eliminated seats across the hand-local index gap', () => {
    const s = deadButtonHand([...flopBet, ['raise', 600], ['fold'], ['call'], ['check']]);

    expect(s.status).toBe('heroToAct');
    expect(s.handId).toBe('t-hand-13');
    expect(s.street).toBe('turn');
    expect(s.tournament).toMatchObject({ level: 3, smallBlind: 25, bigBlind: 50, bigBlindAnte: 50, handsPlayedAtLevel: 0, handsPerLevel: 6,
      nextLevel: { smallBlind: 50, bigBlind: 100, bigBlindAnte: 100 }, playersRemaining: 4 });
    expect(s.players.map((p) => p.position)).toEqual(['BTN', null, 'SB', 'BB', null, 'CO']);
    expect(s.players.filter((p) => p.eliminated).map((p) => [p.seat, p.finishPlace])).toEqual([[1, 6], [4, 5]]);
    expect(s.players.reduce((sum, p) => sum + p.committedThisHand, 0)).toBe(s.pot);
    expect(s.players[3].committedThisHand).toBe(200);
    expect(s).toMatchObject({ pot: 1725, potBB: 34.5, currentBet: 0 });
    expect(s.forcedBets).toEqual([
      { player: 'Lena', kind: 'small blind', amount: 25 },
      { player: 'Mateo', kind: 'big blind', amount: 50 },
      { player: 'Mateo', kind: 'big blind ante', amount: 50 },
    ]);
    expect(s.hero).toMatchObject({ position: 'BTN', stack: 2250, stackBB: 45, effectiveStack: 2250, effectiveStackBB: 45, sprAtStreetStart: 1.3, toCall: 0 });
    expect(s.legalActions).toMatchObject({ check: true });
    expect(s.legalActions).not.toHaveProperty('seatIndex');
    expect(s.history.map((a) => [a.street, a.player, a.position, a.action, a.raiseTo])).toEqual([
      ['preflop', 'Hugo', 'CO', 'raise', 150],
      ['preflop', 'You', 'BTN', 'call', null],
      ['preflop', 'Lena', 'SB', 'fold', null],
      ['preflop', 'Mateo', 'BB', 'call', null],
      ['flop', 'Mateo', 'BB', 'check', null],
      ['flop', 'Hugo', 'CO', 'bet', 200],
      ['flop', 'You', 'BTN', 'raise', 600],
      ['flop', 'Mateo', 'BB', 'fold', null],
      ['flop', 'Hugo', 'CO', 'call', null],
      ['turn', 'Hugo', 'CO', 'check', null],
    ]);
    expect(s.history[6]).toMatchObject({ amountAdded: 600, potBefore: 725, toCallBefore: 200, stackBefore: 2850, allIn: false });
    expect(s.players.filter((p) => !p.isHero).every((p) => p.shownCards === null)).toBe(true);
  });

  it('reports street-start SPR while the hero faces a bet, and none preflop', () => {
    const s = deadButtonHand(flopBet);
    expect(s).toMatchObject({ street: 'flop', pot: 725, currentBet: 200 });
    // Street start: 2850 effective behind (hero vs Hugo) into 525.
    expect(s.hero).toMatchObject({ toCall: 200, effectiveStack: 2850, sprAtStreetStart: 5.43 });
    expect(deadButtonHand([['raise', 150]]).hero).toMatchObject({ toCall: 150, sprAtStreetStart: null });
  });

  it('zeroes street bets after an uncalled bet ends the hand', () => {
    const s = deadButtonHand([...flopBet, ['fold'], ['fold']]);
    expect(s).toMatchObject({ status: 'handComplete', street: 'complete', currentBet: 0, pot: 525 });
    expect(s.players.every((p) => p.streetBet === 0)).toBe(true);
    expect(s.players[5].committedThisHand).toBe(150);
    expect(s.hero).toMatchObject({ effectiveStack: null, sprAtStreetStart: null, toCall: null });
    expect(s.history.at(-3)).toMatchObject({ action: 'bet', raiseTo: 200, amountAdded: 200 });
  });

  it('records the blinds and ante a short stack actually posted', () => {
    const s = deadButtonHand([], [3000, 0, 10, 70, 0, 8920]);
    expect(s.forcedBets).toEqual([
      { player: 'Lena', kind: 'small blind', amount: 10 },
      { player: 'Mateo', kind: 'big blind', amount: 50 },
      { player: 'Mateo', kind: 'big blind ante', amount: 20 },
    ]);
    expect(s.players.slice(2, 4).map((p) => [p.committedThisHand, p.allIn])).toEqual([[10, true], [70, true]]);
    expect(s.pot).toBe(80);
  });
});
