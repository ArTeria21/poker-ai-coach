import type { GameState, SeatConfig, TableConfig } from '../engine/types';

export const STARTING_STACK = 2000;
export const HANDS_PER_LEVEL = 6;
export const PAYOUT_SHARES = [0.65, 0.35] as const;
export const BLIND_LEVELS = [
  [10, 20, 0], [15, 30, 0], [25, 50, 50], [50, 100, 100], [75, 150, 150],
  [100, 200, 200], [150, 300, 300], [200, 400, 400], [300, 600, 600],
  [500, 1000, 1000], [750, 1500, 1500], [1000, 2000, 2000],
  [2000, 4000, 4000], [4000, 8000, 8000], [8000, 16000, 16000],
].map(([smallBlind, bigBlind, bigBlindAnte]) => ({ smallBlind, bigBlind, bigBlindAnte }));

export interface TournamentPlayer extends SeatConfig {
  /** Permanent physical seat, retained after elimination. */
  seatIndex: number;
  /** Equal places share the payouts for all places occupied by the tie. */
  place: number | null;
  payoutShare: number;
}

export interface TournamentState {
  id: string;
  players: TournamentPlayer[];
  completedHands: number;
  /** The current/last hand's level; advanced only by beginTournamentHand. */
  levelIndex: number;
  /** Physical markers can be on empty seats. */
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  pendingHandId: string | null;
}

export function createTournament(lineup: Omit<SeatConfig, 'stack'>[], buttonSeat: number, id: string): TournamentState {
  if (
    lineup.length !== 6 || !id || !Number.isInteger(buttonSeat) || buttonSeat < 0 || buttonSeat >= 6 ||
    lineup.some((p) => !p.id) || new Set(lineup.map((p) => p.id)).size !== 6
  ) throw new Error('Invalid six-player tournament lineup or button');
  return {
    id,
    players: lineup.map((p, seatIndex) => ({ ...p, seatIndex, stack: STARTING_STACK, place: null, payoutShare: 0 })),
    completedHands: 0,
    levelIndex: 0,
    buttonSeat,
    smallBlindSeat: (buttonSeat + 1) % 6,
    bigBlindSeat: (buttonSeat + 2) % 6,
    pendingHandId: null,
  };
}

function handConfig(t: TournamentState): TableConfig {
  const live = t.players.filter((p) => p.stack > 0);
  const indexOf = (seat: number) => {
    const index = live.findIndex((p) => p.seatIndex === seat);
    return index === -1 ? null : index;
  };
  const bigBlindIndex = indexOf(t.bigBlindSeat);
  if (bigBlindIndex === null) throw new Error('Big blind must occupy a live seat');
  return {
    ...BLIND_LEVELS[t.levelIndex],
    buttonIndex: indexOf(t.buttonSeat),
    smallBlindIndex: indexOf(t.smallBlindSeat),
    bigBlindIndex,
    seats: live.map((p) => ({ id: p.id, name: p.name, stack: p.stack, isHero: p.isHero, personalityId: p.personalityId })),
    payouts: [...PAYOUT_SHARES],
  };
}

export function beginTournamentHand(t: TournamentState): { tournament: TournamentState; config: TableConfig; handId: string } {
  const live = t.players.filter((p) => p.stack > 0);
  if (t.pendingHandId !== null || live.length < 2) throw new Error('Tournament is already playing or complete');
  const next = {
    ...t,
    levelIndex: Math.min(Math.floor(t.completedHands / HANDS_PER_LEVEL), BLIND_LEVELS.length - 1),
    pendingHandId: `${t.id}-hand-${t.completedHands + 1}`,
  };
  if (t.completedHands > 0) {
    next.bigBlindSeat = (live.find((p) => p.seatIndex > t.bigBlindSeat) ?? live[0]).seatIndex;
    next.smallBlindSeat = t.bigBlindSeat;
    next.buttonSeat = t.smallBlindSeat;
    if (live.length === 2) {
      next.smallBlindSeat = live.find((p) => p.seatIndex !== next.bigBlindSeat)!.seatIndex;
      next.buttonSeat = next.smallBlindSeat;
    }
  }
  return { tournament: next, config: handConfig(next), handId: next.pendingHandId };
}

export function settleTournamentHand(t: TournamentState, hand: GameState): TournamentState {
  if (t.pendingHandId === null || hand.handId !== t.pendingHandId || hand.phase !== 'complete') {
    throw new Error('Expected the current completed tournament hand');
  }
  const expected = handConfig(t);
  const bb = expected.bigBlindIndex!;
  const actualAnte = Math.min(expected.bigBlindAnte!, Math.max(0, expected.seats[bb].stack - expected.bigBlind));
  if (
    hand.players.length !== expected.seats.length || hand.config.seats.length !== expected.seats.length ||
    hand.config.smallBlind !== expected.smallBlind || hand.config.bigBlind !== expected.bigBlind ||
    (hand.config.bigBlindAnte ?? 0) !== expected.bigBlindAnte || hand.antePot !== actualAnte ||
    hand.buttonIndex !== expected.buttonIndex || hand.smallBlindIndex !== expected.smallBlindIndex ||
    hand.bigBlindIndex !== bb || hand.config.buttonIndex !== expected.buttonIndex ||
    hand.config.smallBlindIndex !== expected.smallBlindIndex || hand.config.bigBlindIndex !== bb ||
    hand.players.some((p, i) => p.id !== expected.seats[i].id || p.seatIndex !== i ||
      p.startingStack !== expected.seats[i].stack || !Number.isSafeInteger(p.stack) || p.stack < 0 ||
      hand.config.seats[i].id !== p.id || hand.config.seats[i].stack !== p.startingStack) ||
    hand.players.reduce((sum, p) => sum + p.stack, 0) !== expected.seats.reduce((sum, p) => sum + p.stack, 0)
  ) throw new Error('Hand does not match tournament players, stacks, blinds, or chips');

  const results = new Map(hand.players.map((p) => [p.id, p.stack]));
  const players = t.players.map((p) => ({ ...p, stack: results.get(p.id) ?? p.stack }));
  const live = players.filter((p) => p.stack > 0);
  const rankStack = (p: GameState['players'][number]) => p.startingStack - (p.seatIndex === bb ? actualAnte : 0);
  const busted = hand.players.filter((p) => p.stack === 0).sort((a, b) => rankStack(b) - rankStack(a));
  let place = live.length + 1;
  for (let i = 0; i < busted.length;) {
    let end = i + 1;
    while (end < busted.length && rankStack(busted[end]) === rankStack(busted[i])) end++;
    const payout = Array.from({ length: end - i }, (_, offset) => PAYOUT_SHARES[place - 1 + offset] ?? 0)
      .reduce((sum, share) => sum + share, 0) / (end - i);
    for (const p of busted.slice(i, end)) {
      const player = players.find((candidate) => candidate.id === p.id)!;
      player.place = place;
      player.payoutShare = payout;
    }
    place += end - i;
    i = end;
  }
  if (live.length === 1) {
    live[0].place = 1;
    live[0].payoutShare = PAYOUT_SHARES[0];
  }
  return { ...t, players, completedHands: t.completedHands + 1, pendingHandId: null };
}
