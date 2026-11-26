import { useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore, type GameSpeed } from '../store/settingsStore';
import { tableController } from '../game/tableController';
import type { Difficulty } from '../bots/personalities';
import { BLIND_LEVELS } from '../game/tournament';
import { PokerTable } from './table/PokerTable';
import { ActionBar } from './table/ActionBar';
import { TournamentPanel } from './TournamentPanel';
import './App.css';

export function App() {
  const tournament = useGameStore((s) => s.tournament);
  const seats = useGameStore((s) => s.seats);
  useEffect(() => {
    tableController.startSession();
    return () => tableController.stop();
  }, []);
  return (
    <div className="app">
      <Header />
      <main className="main-row">
        <div className="play-column">
          <HandLog />
          <PokerTable />
          <ActionBar />
        </div>
        {tournament && <TournamentPanel tournament={tournament} seats={seats} />}
      </main>
    </div>
  );
}

function Header() {
  const handNumber = useGameStore((s) => s.handNumber);
  const tournament = useGameStore((s) => s.tournament);
  const difficulty = useSettingsStore((s) => s.difficulty);
  const speed = useSettingsStore((s) => s.speed);
  const soundEnabled = useSettingsStore((s) => s.soundEnabled);
  const setDifficulty = useSettingsStore((s) => s.setDifficulty);
  const setSpeed = useSettingsStore((s) => s.setSpeed);
  const setSoundEnabled = useSettingsStore((s) => s.setSoundEnabled);
  const level = BLIND_LEVELS[tournament?.levelIndex ?? 0];
  return (
    <header className="header">
      <div className="brand"><span className="brand-suit">♠</span><h1>Poker AI-Coach</h1></div>
      <div className="header-meta">
        <span className="meta-item">6-max SNG · Hand #{handNumber || 1}</span>
        <span className="meta-item">{level.smallBlind} / {level.bigBlind} · BBA {level.bigBlindAnte}</span>
      </div>
      <div className="header-controls">
        <Segmented label="Bots" value={difficulty} options={['easy', 'medium', 'hard'] as Difficulty[]} onChange={setDifficulty} />
        <Segmented label="Speed" value={speed} options={['slow', 'normal', 'fast'] as GameSpeed[]} onChange={setSpeed} />
        <button className="sound-toggle" aria-label={soundEnabled ? 'Mute sounds' : 'Enable sounds'} onClick={() => setSoundEnabled(!soundEnabled)}>
          {soundEnabled ? '🔊' : '🔇'}
        </button>
        <button className="new-tournament" onClick={() => tableController.startSession()}>New SNG</button>
      </div>
    </header>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: T[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      <span className="segmented-label">{label}</span>
      <div className="segmented-options">
        {options.map((option) => (
          <button key={option} className={`segmented-opt${value === option ? ' segmented-opt--active' : ''}`} aria-pressed={value === option} onClick={() => onChange(option)}>{option}</button>
        ))}
      </div>
    </div>
  );
}

function HandLog() {
  const log = useGameStore((s) => s.log);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [log]);
  return (
    <section className="hand-log" aria-label="Hand log">
      <div className="hand-log-title">Hand log</div>
      <div className="hand-log-body" ref={bodyRef}>
        {log.map((line, i) => <div key={i} className={`log-line${line.startsWith('—') ? ' log-line--hand' : /wins \d/.test(line) ? ' log-line--win' : ''}`}>{line}</div>)}
      </div>
    </section>
  );
}
