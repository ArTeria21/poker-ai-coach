import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableController } from './tableController';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import * as decisionViewModule from '../engine/decisionView';
import { gradeHandFromSteps } from '../analysis/gradeHand';
import { applyAction } from '../engine/gameStateMachine';
import { decideAction } from '../bots/botDecision';
import { buildDecisionView } from '../engine/decisionView';
import { modelOpponentRanges } from '../bots/opponentRanges';
import { decisionEquity } from '../equity/decisionEquity';
import { PERSONALITIES, type Personality } from '../bots/personalities';
import type { GameState } from '../engine/types';
import { coachSnapshot } from '../agent/snapshot';

vi.mock('./sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
vi.mock('../random', async (original) => ({ ...await original<typeof import('../random')>(), randomSeed: () => 42 }));
// Pass-through mock so the projection can be spied on.
vi.mock('../engine/decisionView', async (original) => ({ ...await original<typeof import('../engine/decisionView')>() }));
vi.mock('../bots/botDecision', async (original) => ({
  ...await original<typeof import('../bots/botDecision')>(),
  decideAction: vi.fn((view) => ({ action: { type: view.legal.check ? 'check' : 'call' }, trace: [] })),
}));

let controller: TableController;
const store = () => useGameStore.getState();

async function advanceUntil(predicate: () => boolean, limit = 1000): Promise<void> {
  for (let i = 0; i < limit && !predicate(); i++) await vi.advanceTimersByTimeAsync(500);
  expect(predicate(), 'controller did not reach the expected boundary').toBe(true);
}

async function finishHand(fold = false): Promise<void> {
  for (let i = 0; i < 500 && !store().awaitingNext && store().status !== 'tournamentComplete'; i++) {
    const legal = store().heroLegal;
    if (legal) controller.humanAct({ type: fold ? 'fold' : legal.check ? 'check' : 'call' });
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(store().awaitingNext || store().status === 'tournamentComplete').toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.mocked(decideAction).mockImplementation((view) => ({ action: { type: view.legal.check ? 'check' : 'call' }, trace: [] }));
  useSettingsStore.setState({ speed: 'fast', soundEnabled: false });
  useGameStore.getState().reset();
  controller = new TableController();
});

afterEach(() => {
  controller.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SNG table controller', () => {
  it('publishes the same pre-action grade as batch, preserves it through bot responses, and clears on a new hand', async () => {
    const spy=vi.spyOn(decisionViewModule,'buildDecisionView');
    controller.startSession();
    await advanceUntil(()=>store().heroLegal!==null);
    expect(store().latestDecisionGrade).toBeNull();
    const action={type:store().heroLegal!.check?'check' as const:'call' as const};
    controller.humanAct(action);
    const before=spy.mock.calls.at(-1)![0];
    const seatIndex=before.actionOn!;
    const result=applyAction(before,action);
    const batch=gradeHandFromSteps(before.handId,[{state:before,events:[]},{...result,action,seatIndex}],seatIndex).decisions[0];
    await Promise.resolve();
    expect(store().latestDecisionGrade).toEqual(batch);
    expect(JSON.stringify(store().latestDecisionGrade)).not.toMatch(/opponentRanges|weightedCombos|"seed"|"deck"/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store().latestDecisionGrade).toEqual(batch);
    await finishHand();
    expect(store().latestDecisionGrade).not.toBeNull();
    controller.continueNextHand();await Promise.resolve();
    expect(store().latestDecisionGrade).toBeNull();
  });

  it('cannot publish a stale accepted grade after an immediate restart or rejected action', async () => {
    controller.startSession();await advanceUntil(()=>store().heroLegal!==null);
    controller.humanAct({type:'raise',amount:NaN});
    expect(store().latestDecisionGrade).toBeNull();
    controller.humanAct({type:store().heroLegal!.check?'check':'call'});
    controller.startSession('Restarted');
    await advanceUntil(()=>store().heroLegal!==null);
    expect(store().latestDecisionGrade).toBeNull();
    await vi.runAllTimersAsync();
    expect(store().latestDecisionGrade).toBeNull();
  });

  it('publishes six fixed seats, real blinds, and sanitized cards', async () => {
    controller.startSession();
    await advanceUntil(() => store().heroLegal !== null);
    expect(store().seats.map((p) => p.seatIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(store().tournament?.players.map((p) => p.stack)).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    expect(store().bigBlind).toBe(20);
    expect(store().currentBet).toBe(20);
    expect(store().seats.filter((p) => !p.isHero).every((p) => p.holeCards === null)).toBe(true);
    expect(store().seats[0].holeCards).toHaveLength(2);
    const snapshot = store();
    controller.humanAct({ type: 'raise', amount: NaN });
    controller.humanAct({ type: 'raise', amount: Infinity });
    await Promise.resolve();
    expect(store()).toBe(snapshot);
    controller.humanAct({ type: 'raise', amount: 41.4 });
    await Promise.resolve();
    expect(store().log).toContain('You raise to 41');
  });

  it('keeps the current level between hands and advances it on the next deal', async () => {
    controller.startSession();
    for (let i = 0; i < 6; i++) {
      await finishHand();
      expect(store().tournament?.levelIndex).toBe(0);
      expect(store().seats.reduce((sum, p) => sum + p.stack, 0)).toBe(12000);
      if (i < 5) {
        controller.continueNextHand();
        await Promise.resolve();
      }
    }
    expect(store().handNumber).toBe(6);
    controller.continueNextHand();
    await Promise.resolve();
    expect(store().handNumber).toBe(7);
    expect(store().bigBlind).toBe(30);
    expect(store().tournament?.levelIndex).toBe(1);
  });

  it('lets an eliminated hero spectate, preserves bot identities after compaction, and finishes without a rebuy', async () => {
    const identities: [Personality, string | undefined][] = [];
    vi.mocked(decideAction).mockImplementation((view, personality) => {
      identities.push([personality, store().seats.find((p) => p.isActing)?.id]);
      return { action: { type: view.legal.check ? 'check' : 'call' }, trace: [] };
    });
    controller.startSession();
    for (let hand = 0; hand < 60; hand++) {
      await finishHand(true);
      if (store().tournament!.players[0].stack === 0) break;
      controller.continueNextHand();
      await Promise.resolve();
    }
    expect(store().seats[0]).toMatchObject({ id: 'hero', stack: 0, eliminated: true });
    expect(store().status).toBe('handComplete');
    expect(store().tournament!.players.filter((p) => p.stack > 0).length).toBeGreaterThan(1);
    expect(store().heroLegal).toBeNull();
    vi.mocked(decideAction).mockImplementation((view, personality) => {
      identities.push([personality, store().seats.find((p) => p.isActing)?.id]);
      return { action: view.legal.raise ? { type: 'raise', amount: view.legal.raise.maxTo } : { type: view.legal.check ? 'check' : 'call' }, trace: [] };
    });
    for (let hand = 0; hand < 20 && store().status !== 'tournamentComplete'; hand++) {
      controller.continueNextHand();
      await Promise.resolve();
      await finishHand();
    }
    expect(store().status).toBe('tournamentComplete');
    expect(store().awaitingNext).toBe(false);
    expect(store().tournament!.players.filter((p) => p.stack > 0)).toHaveLength(1);
    expect(store().tournament!.players.every((p) => p.place !== null)).toBe(true);
    expect(store().tournament!.players.reduce((sum, p) => sum + p.payoutShare, 0)).toBeCloseTo(1);
    // Each bot keeps one hidden personality object for the whole tournament, through seat compaction.
    const byId = new Map<string | undefined, Set<Personality>>();
    for (const [personality, id] of identities) byId.set(id, (byId.get(id) ?? new Set()).add(personality));
    expect([...byId.keys()].sort()).toEqual(['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5']);
    expect([...byId.values()].every((set) => set.size === 1)).toBe(true);
    expect(new Set([...byId.values()].flatMap((set) => [...set])).size).toBe(5);
    expect(store().seats.map((p) => p.id)).toEqual(['hero', 'bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5']);
    expect(store().log.some((line) => /buy.*in/i.test(line))).toBe(false);
    const handNumber = store().handNumber;
    controller.continueNextHand();
    await vi.runAllTimersAsync();
    expect(store().handNumber).toBe(handNumber);
  });

  it('seats five neutral, uniquely named bots and publishes no hidden personality', async () => {
    // Allow-lists: a new public field, even a neutral-named number, must be added here consciously.
    const allowed = {
      store: ['appendLog', 'awaitingNext', 'banner', 'bigBlind', 'board', 'currentBet', 'forcedBets', 'handActions', 'handId', 'handNumber', 'heroLegal', 'latestDecisionGrade', 'log', 'phase', 'pot', 'publish', 'reset', 'seats', 'status', 'tournament'],
      seat: ['allIn', 'avatar', 'committed', 'eliminated', 'folded', 'hasCards', 'holeCards', 'id', 'isActing', 'isButton', 'isHero', 'lastAction', 'name', 'position', 'seatIndex', 'showdownDescription', 'stack', 'streetBet', 'wonAmount'],
      lastAction: ['amount', 'type'],
      tournament: ['bigBlindSeat', 'buttonSeat', 'completedHands', 'id', 'levelIndex', 'pendingHandId', 'players', 'smallBlindSeat'],
      tournamentPlayer: ['id', 'isHero', 'name', 'payoutShare', 'place', 'seatIndex', 'stack'],
      snapshotPlayer: ['allIn', 'committedThisHand', 'eliminated', 'finishPlace', 'folded', 'isActing', 'isHero', 'name', 'position', 'seat', 'shownCards', 'showdownDescription', 'stack', 'stackBB', 'streetBet', 'wonThisHand'],
    };
    const published: Record<keyof typeof allowed, Set<string>> = { store: new Set(), seat: new Set(), lastAction: new Set(), tournament: new Set(), tournamentPlayer: new Set(), snapshotPlayer: new Set() };
    const collect = (kind: keyof typeof allowed, objects: (object | null | undefined)[]) => {
      for (const o of objects) if (o) published[kind].add(Object.keys(o).sort().join());
    };
    const unsubscribe = useGameStore.subscribe((view) => {
      collect('store', [view]);
      collect('seat', view.seats);
      collect('lastAction', view.seats.map((seat) => seat.lastAction));
      collect('tournament', [view.tournament]);
      collect('tournamentPlayer', view.tournament?.players ?? []);
      collect('snapshotPlayer', coachSnapshot(view)?.players ?? []);
    });
    controller.startSession('Priya'); // seed 42 would otherwise seat a bot named Priya
    await advanceUntil(() => store().heroLegal !== null);
    const bots = store().seats.filter((p) => !p.isHero);
    expect(bots.map((p) => p.id)).toEqual(['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5']);
    expect(new Set(bots.map((p) => p.name)).size).toBe(5);
    expect(bots.map((p) => p.name)).not.toContain('Priya');
    controller.humanAct({ type: store().heroLegal!.check ? 'check' : 'call' });
    await advanceUntil(() => store().latestDecisionGrade !== null);
    const hidden = /\b(shark|rock|maniac|fish|nit)\b|personality|pfrRatio|vpipTier|aggressionFactor|bluffFrequency|callStation|foldToAggression/i;
    const { seats, tournament, handActions, forcedBets, latestDecisionGrade, log } = store();
    // Avatar values are decorative ("shark" is a figurine); the allow-list pins the key and the Avatar type the values.
    const publicJson = JSON.stringify({ seats, snapshot: coachSnapshot(store()), tournament, handActions, forcedBets, latestDecisionGrade, log }, (key, value: unknown) => (key === 'avatar' ? undefined : value));
    expect(publicJson).not.toMatch(hidden);
    const state = (controller as unknown as { state: GameState }).state;
    expect(JSON.stringify(state)).not.toMatch(hidden);
    await finishHand();
    unsubscribe();
    for (const kind of Object.keys(allowed) as (keyof typeof allowed)[]) expect([...published[kind]], kind).toEqual([allowed[kind].sort().join()]);
  });

  it('grades and models opponents identically whatever hidden personalities the bots have', async () => {
    const run = async (archetype: string) => {
      vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
      useGameStore.getState().reset();
      const used = new Set<string>();
      vi.mocked(decideAction).mockImplementation((view, personality) => {
        used.add(personality.id);
        return { action: { type: view.legal.check ? 'check' : 'call' }, trace: [] };
      });
      controller = new TableController();
      controller.startSession();
      const hidden = (controller as unknown as { personalities: Map<string, Personality> }).personalities;
      for (const id of hidden.keys()) hidden.set(id, PERSONALITIES[archetype]);
      const observed: unknown[] = [];
      for (let i = 0; i < 500 && !store().awaitingNext; i++) {
        const legal = store().heroLegal;
        if (legal) {
          const state = (controller as unknown as { state: GameState }).state;
          const view = buildDecisionView(state, legal.seatIndex);
          const action = { type: legal.check ? 'check' as const : 'call' as const };
          controller.humanAct(action);
          const grade = (controller as unknown as { latestDecisionGrade: unknown }).latestDecisionGrade;
          expect(grade).not.toBeNull();
          observed.push({ grade, ranges: modelOpponentRanges(view), equity: decisionEquity(view, { iterations: 300, seed: 1 }) });
        }
        await vi.advanceTimersByTimeAsync(500);
      }
      controller.stop();
      expect(used).toEqual(new Set([archetype]));
      return observed;
    };
    const tight = await run('nit');
    expect(tight.length).toBeGreaterThan(1);
    expect(await run('maniac')).toEqual(tight);
  });

  it.each(['bot delay', 'human wait', 'street delay', 'showdown delay', 'between-hands delay', 'next wait'])('cancels an old session during %s', async (boundary) => {
    controller.startSession('Old hero');
    if (boundary === 'human wait') await advanceUntil(() => store().heroLegal !== null);
    if (boundary !== 'bot delay' && boundary !== 'human wait') {
      const reached = () => boundary === 'street delay' ? store().phase === 'flop'
        : boundary === 'showdown delay' ? store().phase === 'complete' && store().tournament!.pendingHandId !== null
        : boundary === 'between-hands delay' ? store().phase === 'complete' && store().tournament!.pendingHandId === null && !store().awaitingNext
        : store().awaitingNext;
      for (let i = 0; i < 2000 && !reached(); i++) {
        const legal = store().heroLegal;
        if (legal) controller.humanAct({ type: legal.check ? 'check' : 'call' });
        await vi.advanceTimersByTimeAsync(25);
      }
      expect(reached()).toBe(true);
    }
    controller.stop();
    controller.startSession('New hero');
    await advanceUntil(() => store().heroLegal !== null);
    const snapshot = store();
    await vi.runAllTimersAsync();
    expect(store().tournament?.id).toBe(snapshot.tournament!.id);
    expect(store().handNumber).toBe(1);
    expect(store().seats[0].name).toBe('New hero');
    expect(store().heroLegal).not.toBeNull();
    expect(store().log.some((line) => line.includes('Old hero'))).toBe(false);
  });
});
