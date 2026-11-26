import type { DecisionGrade } from '../analysis/gradeHand';
import { create } from 'zustand';
import type { ActionType, Card, GamePhase, LegalActions, Position, PublicAction } from '../engine/types';
import type { TournamentState } from '../game/tournament';

/**
 * UI-facing snapshot of the table. SANITIZED: bot hole cards are null until
 * a public reveal — components physically cannot leak what they don't
 * receive. Only the table controller writes to this store.
 */
export interface SeatView {
  seatIndex: number;
  id: string;
  name: string;
  isHero: boolean;
  avatar: string;
  personalityTagline: string | null;
  stack: number;
  /** Table position this hand; null when not dealt in. */
  position: Position | null;
  streetBet: number;
  /** Chips put into the pot this hand, including the big blind ante. */
  committed: number;
  folded: boolean;
  allIn: boolean;
  /** Visible cards: hero always; bots only after a public reveal. */
  holeCards: [Card, Card] | null;
  /** Whether this seat holds (face-down) cards right now. */
  hasCards: boolean;
  isButton: boolean;
  isActing: boolean;
  lastAction: { type: ActionType | 'bet' | 'small blind' | 'big blind'; amount: number } | null;
  /** Showdown hand description, e.g. "Two Pair, Kings and Nines". */
  showdownDescription: string | null;
  wonAmount: number | null;
  eliminated: boolean;
}

/** A public action of the current hand, keyed by player id (engine seat indexes are hand-local). */
export type HandAction = Omit<PublicAction, 'seatIndex' | 'amount'> & { playerId: string };

/** Blinds and ante actually posted this hand (a short stack may post less than the level). */
export interface ForcedBet {
  playerId: string;
  kind: 'small blind' | 'big blind' | 'big blind ante';
  amount: number;
}

export type TableStatus = 'idle' | 'playing' | 'handComplete' | 'tournamentComplete';

export interface GameViewState {
  /** Settled/prehand stacks and standings, no private cards; live stacks are in seats. */
  tournament: TournamentState | null;
  status: TableStatus;
  /** Engine hand id `<tournamentId>-hand-N`: public, seed-free. */
  handId: string | null;
  handNumber: number;
  phase: GamePhase | null;
  seats: SeatView[];
  board: Card[];
  pot: number;
  bigBlind: number;
  currentBet: number;
  forcedBets: ForcedBet[];
  handActions: HandAction[];
  /** Non-null exactly when the UI should show the action bar. */
  heroLegal: LegalActions | null;
  /** Latest accepted hero decision; compact public math/model evidence, no hidden hands or range arrays. */
  latestDecisionGrade: DecisionGrade | null;
  /** True while the game is paused waiting for "deal next hand". */
  awaitingNext: boolean;
  /** One-liner banner at hand end, e.g. "Selena wins 300 with a flush". */
  banner: string | null;
  /** Rolling human-readable action log (most recent last). */
  log: string[];
  /** Active table-talk bubbles by seat index. */
  quips: Record<number, { text: string; id: number }>;
}

const initialState: GameViewState = {
  tournament: null,
  status: 'idle',
  handId: null,
  handNumber: 0,
  phase: null,
  seats: [],
  board: [],
  pot: 0,
  bigBlind: 20,
  currentBet: 0,
  forcedBets: [],
  handActions: [],
  heroLegal: null,
  latestDecisionGrade: null,
  awaitingNext: false,
  banner: null,
  log: [],
  quips: {},
};

interface GameStore extends GameViewState {
  /** Controller-only: replace the snapshot. */
  publish: (partial: Partial<GameViewState>) => void;
  appendLog: (lines: string[]) => void;
  reset: () => void;
}

export const useGameStore = create<GameStore>()((set) => ({
  ...initialState,
  publish: (partial) => set(partial),
  appendLog: (lines) =>
    set((s) => ({ log: [...s.log, ...lines].slice(-200) })),
  reset: () => set(initialState),
}));
