/**
 * Core engine types. This module (and everything under src/engine) is pure
 * TypeScript with no React/DOM dependencies — fully deterministic and testable.
 *
 * Chips are always integers. A hand is fully determined by {config, seed, actions[]}.
 */

/** Card as a 2-char string: rank in '23456789TJQKA' + suit in 'cdhs', e.g. 'As', 'Td'. */
export type Card = string;

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type GamePhase = Street | 'complete';

export type Position = 'BTN' | 'SB' | 'BB' | 'UTG' | 'HJ' | 'CO';

export interface SeatConfig {
  id: string;
  name: string;
  stack: number;
  isHero: boolean;
  /** Bot personality id; undefined for the human player. */
  personalityId?: string;
}

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  /** Dead money paid by the big blind after its live blind; defaults to zero. */
  bigBlindAnte?: number;
  /** Index into `seats`, or null when the button is on an empty physical seat. */
  buttonIndex: number | null;
  /** Explicit live blind positions for tournament hands with empty seats. */
  smallBlindIndex?: number | null;
  bigBlindIndex?: number;
  /** Players dealt into this hand, in seat order. All stacks must be > 0. */
  seats: SeatConfig[];
  /** Tournament prize shares by place; ignored by the engine, read by decision models. */
  payouts?: number[];
}

export interface PlayerState {
  seatIndex: number;
  id: string;
  name: string;
  isHero: boolean;
  /** Chips behind (excludes chips already committed). */
  stack: number;
  /** Stack at the start of the hand — net result = stack - startingStack once complete. */
  startingStack: number;
  holeCards: [Card, Card];
  folded: boolean;
  allIn: boolean;
  /** Chips committed during the current betting round. */
  streetBet: number;
  /** Total chips committed this hand (drives side pots). */
  totalCommitted: number;
  /**
   * Whether this player has acted since the last FULL raise this street.
   * Blinds do not count as acting. Reset by full raises only; cumulative
   * short all-ins can also restore raise rights based on streetBet.
   */
  hasActed: boolean;
}

export type ActionType = 'fold' | 'check' | 'call' | 'raise';

export interface PlayerAction {
  type: ActionType;
  /** For 'raise': the total street amount to raise TO (not the increment). */
  amount?: number;
}

export interface LegalActions {
  seatIndex: number;
  fold: boolean;
  check: boolean;
  /** Chips to add to call (already capped at stack). */
  call?: { amount: number; allIn: boolean };
  /** Raise-to totals. maxTo is all-in. minTo === maxTo means all-in is the only raise. */
  raise?: { minTo: number; maxTo: number };
}

/** Public, pre-action context; structural PlayerAction compatibility keeps seed/action replay unchanged. */
export interface PublicAction extends PlayerAction {
  seatIndex: number;
  street: Street;
  amountAdded: number;
  toStreetBet: number;
  potBefore: number;
  toCallBefore: number;
  stackBefore: number;
}

export interface GameState {
  handId: string;
  config: TableConfig;
  seed: number;
  /** Full shuffled deck order. Private — never expose to UI or bots. */
  deck: Card[];
  deckIndex: number;
  players: PlayerState[];
  buttonIndex: number | null;
  smallBlindIndex: number | null;
  bigBlindIndex: number;
  phase: GamePhase;
  board: Card[];
  /** Dead ante chips: do not count toward calls, side-pot caps, or uncalled bets. */
  antePot: number;
  /** Highest streetBet this round. */
  currentBet: number;
  /** Size of the last full bet/raise increment — the min-raise basis. */
  lastRaiseAmount: number;
  /** Seat index to act, or null (between streets / hand complete). */
  actionOn: number | null;
  /**
   * Last player to bet or raise this hand (blinds don't count). Public
   * information — everyone at the table saw it. Drives bot initiative
   * (continuation bets) without leaking anything private.
   */
  lastAggressor: number | null;
  /** Ordered actions applied so far — replaying these on {config, seed} rebuilds any state. */
  actionHistory: PublicAction[];
}

/** Sum of all chips committed to the pot this hand. */
export function totalPot(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.totalCommitted, state.antePot);
}

/** First occupied seat left of the actual button, including a dead button. */
export function firstToReceive(playerCount: number, smallBlindIndex: number | null, bigBlindIndex: number): number {
  return playerCount === 2 ? bigBlindIndex : smallBlindIndex ?? bigBlindIndex;
}

/** Positions for the given player count, ordered from the button clockwise. */
export function positionOfSeat(state: GameState, seatIndex: number): Position {
  const n = state.players.length;
  if (seatIndex === state.bigBlindIndex) return 'BB';
  if (seatIndex === state.smallBlindIndex) return 'SB';
  if (seatIndex === state.buttonIndex) return 'BTN';
  const otherSeats = Array.from({ length: n }, (_, i) => (state.bigBlindIndex + i + 1) % n)
    .filter((i) => i !== state.bigBlindIndex && i !== state.smallBlindIndex && i !== state.buttonIndex);
  // Label by distance from the button (4-handed first-in is the 6-max CO). Dead button: the seat right of the SB acts last postflop, so it is the effective button.
  const labels: Position[] = ['UTG', 'HJ', 'CO', 'BTN'];
  return labels[(state.buttonIndex === null ? 4 : 3) - otherSeats.length + otherSeats.indexOf(seatIndex)];
}
