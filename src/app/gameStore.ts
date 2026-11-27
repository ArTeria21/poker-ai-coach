import { createStore, useStore } from 'zustand';
import type { GameViewState } from './tableView';

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
};

interface GameStore extends GameViewState {
  /** Controller-only: merge a partial snapshot into the view. */
  publish: (partial: Partial<GameViewState>) => void;
  appendLog: (lines: string[]) => void;
  reset: () => void;
}

/**
 * The writable table store. App-internal: only the table controller publishes
 * into it (tests arrange scenarios through it too). Components read through
 * `useGameView`, which never hands out the writers.
 */
export const gameStore = createStore<GameStore>()((set) => ({
  ...initialState,
  publish: (partial) => set(partial),
  appendLog: (lines) =>
    set((s) => ({ log: [...s.log, ...lines].slice(-200) })),
  reset: () => set(initialState),
}));

/** Public read access for components: select from the sanitized table view. */
export function useGameView<T>(selector: (view: GameViewState) => T): T {
  return useStore(gameStore, selector);
}
