import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore, type GameSpeed } from '../store/settingsStore';
import { tableController } from '../game/tableController';
import type { Difficulty } from '../bots/personalities';
import { PokerTable } from './table/PokerTable';
import { ActionBar } from './table/ActionBar';
import { TournamentPanel } from './TournamentPanel';
import { CoachChat } from './CoachChat';
import { Segmented } from './Segmented';
import { BrandSpadeIcon, ChipsBBIcon, CoachIcon, DeckColorIcon, SoundOffIcon, SoundOnIcon, TableIcon } from './Icons';
import { connectTraining, lockedGate, useDiagnosisStore, useTrainingStore } from './coachSession';
import './App.css';

export function App() {
  const tournament = useGameStore((s) => s.tournament);
  const seats = useGameStore((s) => s.seats);
  const tableAttention = useGameStore((s) => s.heroLegal !== null || s.awaitingNext);
  const coachAttention = useTrainingStore((s) => lockedGate(s.state) !== null);
  const diagnosisActive = useDiagnosisStore((s) => s.resume !== null);
  const [mobilePane, setMobilePane] = useState<'table' | 'coach'>('table');

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
      <nav className="mobile-tabs" aria-label="Workspace view">
        <button
          type="button"
          className={`mobile-tab${mobilePane === 'table' ? ' mobile-tab--active' : ''}`}
          aria-pressed={mobilePane === 'table'}
          onClick={() => setMobilePane('table')}
        >
          <TableIcon />
          <span>Table</span>
          {tableAttention && <span className="mobile-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`mobile-tab${mobilePane === 'coach' ? ' mobile-tab--active' : ''}`}
          aria-pressed={mobilePane === 'coach'}
          onClick={() => setMobilePane('coach')}
        >
          <CoachIcon />
          <span>Coach Dan</span>
          {(coachAttention || diagnosisActive) && <span className="mobile-dot" aria-hidden="true" />}
        </button>
      </nav>
      <main className="main-row">
        <div className={`play-column${mobilePane === 'table' ? '' : ' mobile-pane--hidden'}`}>
          {tournament && <TournamentPanel tournament={tournament} seats={seats} />}
          <HandLog />
          <PokerTable />
          <ActionBar />
        </div>
        <CoachChat className={mobilePane === 'coach' ? '' : 'mobile-pane--hidden'} />
      </main>
    </div>
  );
}

function Header() {
  const handNumber = useGameStore((s) => s.handNumber);
  const status = useGameStore((s) => s.status);
  const difficulty = useSettingsStore((s) => s.difficulty);
  const speed = useSettingsStore((s) => s.speed);
  const soundEnabled = useSettingsStore((s) => s.soundEnabled);
  const displayBB = useSettingsStore((s) => s.displayBB);
  const fourColorDeck = useSettingsStore((s) => s.fourColorDeck);
  const setDifficulty = useSettingsStore((s) => s.setDifficulty);
  const setSpeed = useSettingsStore((s) => s.setSpeed);
  const setSoundEnabled = useSettingsStore((s) => s.setSoundEnabled);
  const setDisplayBB = useSettingsStore((s) => s.setDisplayBB);
  const setFourColorDeck = useSettingsStore((s) => s.setFourColorDeck);

  const [confirmReset, setConfirmReset] = useState(false);
  const needsConfirm = status !== 'tournamentComplete' && handNumber > 1;

  useEffect(() => {
    if (!needsConfirm && confirmReset) setConfirmReset(false);
  }, [needsConfirm, confirmReset]);

  useEffect(() => {
    if (!confirmReset) return;
    const id = setTimeout(() => setConfirmReset(false), 3000);
    return () => clearTimeout(id);
  }, [confirmReset]);

  const handleNewSng = () => {
    if (needsConfirm && !confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    tableController.startSession();
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-suit"><BrandSpadeIcon /></span>
        <h1>Poker AI-Coach</h1>
      </div>
      <div className="header-meta">
        <span className="meta-item">6-max SNG · Hand #{handNumber || 1}</span>
      </div>
      <div className="header-controls">
        <Segmented label="Bots" value={difficulty} options={['easy', 'medium', 'hard'] as Difficulty[]} onChange={setDifficulty} />
        <Segmented label="Speed" value={speed} options={['slow', 'normal', 'fast'] as GameSpeed[]} onChange={setSpeed} />
        <button
          type="button"
          className={`icon-toggle${displayBB ? ' icon-toggle--active' : ''}`}
          aria-pressed={displayBB}
          aria-label={displayBB ? 'Show chips' : 'Show big blinds'}
          title="Toggle Chips / Big Blinds display"
          onClick={() => setDisplayBB(!displayBB)}
        >
          <ChipsBBIcon />
          <span>BB</span>
        </button>
        <button
          type="button"
          className={`icon-toggle${fourColorDeck ? ' icon-toggle--active' : ''}`}
          aria-pressed={fourColorDeck}
          aria-label={fourColorDeck ? 'Switch to 2-color deck' : 'Switch to 4-color deck'}
          title="Toggle 2-color / 4-color deck"
          onClick={() => setFourColorDeck(!fourColorDeck)}
        >
          <DeckColorIcon />
          <span>4C</span>
        </button>
        <button
          type="button"
          className="sound-toggle"
          aria-label={soundEnabled ? 'Mute sounds' : 'Enable sounds'}
          title={soundEnabled ? 'Mute sounds' : 'Enable sounds'}
          onClick={() => setSoundEnabled(!soundEnabled)}
        >
          {soundEnabled ? <SoundOnIcon /> : <SoundOffIcon />}
        </button>
        <button
          type="button"
          className={`new-tournament${confirmReset ? ' new-tournament--confirm' : ''}`}
          onClick={handleNewSng}
          onBlur={() => setConfirmReset(false)}
        >
          {confirmReset ? 'Confirm?' : 'New SNG'}
        </button>
      </div>
    </header>
  );
}

function logLineClass(line: string): string {
  if (line.startsWith('—')) return 'log-line log-line--hand';
  if (/^(Flop|Turn|River):/.test(line)) return 'log-line log-line--street';
  if (/\bwins \d/.test(line) || /shows the (semi-)?bluff/.test(line)) return 'log-line log-line--win';
  if (/posts the |Uncalled bet/.test(line)) return 'log-line log-line--meta';
  return 'log-line';
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
        {log.map((line, i) => <div key={i} className={logLineClass(line)}>{line}</div>)}
      </div>
    </section>
  );
}
