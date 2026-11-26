import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableController } from './tableController';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import * as botModule from '../bots/botDecision';
import { gradeHandFromSteps } from '../analysis/gradeHand';
import { applyAction } from '../engine/gameStateMachine';
import { decideAction } from '../bots/botDecision';

vi.mock('./sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
vi.mock('../engine/rng', async (original) => ({ ...await original<typeof import('../engine/rng')>(), randomSeed: () => 42 }));
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
    const spy=vi.spyOn(botModule,'buildBotView');
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
    const identities: [string, string | undefined][] = [];
    vi.mocked(decideAction).mockImplementation((view, personality) => {
      identities.push([personality.id, store().seats.find((p) => p.isActing)?.id]);
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
      identities.push([personality.id, store().seats.find((p) => p.isActing)?.id]);
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
    expect(identities.every(([expected, actual]) => expected === actual)).toBe(true);
    expect(store().seats.map((p) => p.id)).toEqual(['hero', 'shark', 'rock', 'maniac', 'fish', 'nit']);
    expect(store().log.some((line) => /buy.*in/i.test(line))).toBe(false);
    const handNumber = store().handNumber;
    controller.continueNextHand();
    await vi.runAllTimersAsync();
    expect(store().handNumber).toBe(handNumber);
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
