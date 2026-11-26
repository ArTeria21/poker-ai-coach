import { useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore, type GameSpeed } from '../store/settingsStore';
import { tableController } from '../game/tableController';
import type { Difficulty } from '../bots/personalities';
import { PokerTable } from './table/PokerTable';
import { ActionBar } from './table/ActionBar';
import { TournamentPanel } from './TournamentPanel';
import { CoachChat } from './CoachChat';
import { Segmented } from './Segmented';
import { connectTraining } from './coachSession';
import './App.css';

export function App() {
  const tournament = useGameStore((s) => s.tournament);
  const seats = useGameStore((s) => s.seats);
  useEffect(() => {
    const disconnect = connectTraining();
    tableController.startSession();
    return () => {
      tableController.stop();
      disconnect();
    };
  }, []);
  return (
    <div className="app">
      <Header />
      <main className="main-row">
        <div className="play-column">
          {tournament && <TournamentPanel tournament={tournament} seats={seats} />}
          <HandLog />
          <PokerTable />
          <ActionBar />
        </div>
        <CoachChat />
      </main>
    </div>
  );
}

function Header() {
  const handNumber = useGameStore((s) => s.handNumber);
  const difficulty = useSettingsStore((s) => s.difficulty);
  const speed = useSettingsStore((s) => s.speed);
  const soundEnabled = useSettingsStore((s) => s.soundEnabled);
  const setDifficulty = useSettingsStore((s) => s.setDifficulty);
  const setSpeed = useSettingsStore((s) => s.setSpeed);
  const setSoundEnabled = useSettingsStore((s) => s.setSoundEnabled);
  return (
    <header className="header">
      <div className="brand"><span className="brand-suit">♠</span><h1>Poker AI-Coach</h1></div>
      <div className="header-meta">
        <span className="meta-item">6-max SNG · Hand #{handNumber || 1}</span>
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
