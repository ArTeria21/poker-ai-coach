import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Difficulty } from '../bots/personalities';
import type { Mode } from '../agent/training';

export type GameSpeed = 'slow' | 'normal' | 'fast';

interface SettingsState {
  difficulty: Difficulty;
  speed: GameSpeed;
  soundEnabled: boolean;
  /** Coach mode; change it through `setTrainingMode`, which also feeds the training state machine. */
  mode: Mode;
  setDifficulty: (d: Difficulty) => void;
  setSpeed: (s: GameSpeed) => void;
  setSoundEnabled: (on: boolean) => void;
  setMode: (mode: Mode) => void;
}

export const SPEED_FACTOR: Record<GameSpeed, number> = {
  slow: 1.6,
  normal: 1,
  fast: 0.45,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      difficulty: 'medium',
      speed: 'normal',
      soundEnabled: true,
      mode: 'free',
      setDifficulty: (difficulty) => set({ difficulty }),
      setSpeed: (speed) => set({ speed }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setMode: (mode) => set({ mode }),
    }),
    { name: 'poker-mentor-settings' },
  ),
);
