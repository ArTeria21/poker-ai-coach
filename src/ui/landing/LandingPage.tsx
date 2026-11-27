import type { MouseEvent } from 'react';
import { ArrowRightIcon, BrandSpadeIcon, DiagnosticsIcon, FeltOverlaySvg, MemoryIcon, TableIcon } from '../shared/Icons';
import './LandingPage.css';

interface LandingPageProps {
  initialized: boolean | null;
  hasActiveSession: boolean;
  handNumber: number;
  onEnterTournament: () => void;
  onStartDiagnostics: () => void;
  onOpenMemory: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function LandingPage({ initialized, hasActiveSession, handNumber, onEnterTournament, onStartDiagnostics, onOpenMemory }: LandingPageProps) {
  const tournamentAction = hasActiveSession ? 'Resume Tournament' : 'Enter Tournament';
  const diagnosticsAction = initialized === true ? 'Re-run Diagnostics' : 'Take Diagnostics';
  const memoryStatus = initialized === true ? 'Memory active' : initialized === false ? 'New player' : 'Local table';
  const cards = [
    {
      title: 'Tournament Table', icon: <TableIcon width={22} height={22} />,
      badge: hasActiveSession ? `HAND #${handNumber} LIVE` : '6-MAX SNG',
      description: 'Seat yourself against five bots with hidden archetypes across 15 rising blind levels, big blind ante, and exact 65/35 ICM payouts.',
      action: hasActiveSession ? `Resume Hand #${handNumber}` : tournamentAction, onClick: onEnterTournament,
    },
    {
      title: 'Level Diagnostics', icon: <DiagnosticsIcon />,
      badge: initialized === true ? 'CALIBRATED' : initialized === false ? 'RECOMMENDED' : 'LEVEL CHECK',
      description: 'Answer concise tournament mini-spots with confidence calibration. Dan maps your floor and ceiling before coaching begins—no trivia, no fluff.',
      action: diagnosticsAction, onClick: onStartDiagnostics, recommended: initialized === false,
    },
    {
      title: 'Agent Memory', icon: <MemoryIcon />,
      badge: initialized === true ? 'ACTIVE' : initialized === false ? 'EMPTY' : 'INSPECT',
      description: 'Inspect what Coach Dan remembers across sessions: your student profile, 12-topic knowledge map, active leaks, and saved hand highlights.',
      action: 'View Agent Memory', onClick: onOpenMemory,
    },
  ];

  return (
    <div className="landing">
      <div className="landing-backdrop" aria-hidden="true">
        <div className="landing-orb landing-orb--emerald" />
        <div className="landing-orb landing-orb--brass" />
        <div className="landing-orb landing-orb--mint" />
        <FeltOverlaySvg />
      </div>
      <header className="landing-nav">
        <div className="brand">
          <span className="brand-suit"><BrandSpadeIcon /></span>
          <span className="landing-brand-name">Poker AI-Coach</span>
        </div>
        <div className="landing-nav-actions">
          <button type="button" className={`landing-status-pill landing-status-pill--${initialized === true ? 'active' : initialized === false ? 'new' : 'local'}`} onClick={onOpenMemory}>
            <span className="landing-status-dot" aria-hidden="true" />{memoryStatus}
          </button>
          <button type="button" className="landing-nav-cta" onClick={onEnterTournament}>
            {hasActiveSession ? `Resume · Hand #${handNumber}` : 'Enter table'}<ArrowRightIcon />
          </button>
        </div>
      </header>
      <main className="landing-content">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-heading">
            <p className="landing-eyebrow">6-MAX NO-LIMIT HOLD'EM · AI COACHING SALON</p>
            <h1 id="landing-title">Play the table.<br /><span>Sharpen your edge.</span></h1>
          </div>
          <div className="landing-hero-details">
            <p className="landing-subtitle">A 6-max SNG tournament room with adaptive bots, exact ICM &amp; equity math, and Coach Dan—an AI mentor that diagnoses your game and remembers every leak across sessions.</p>
            <div className="landing-cta-row">
              <button type="button" className="landing-btn landing-btn--primary" onClick={onEnterTournament}>{tournamentAction}<ArrowRightIcon /></button>
              <button type="button" className="landing-btn landing-btn--mint" onClick={onStartDiagnostics}>{diagnosticsAction}</button>
              <button type="button" className="landing-btn landing-btn--ghost" onClick={onOpenMemory}>View Agent Memory</button>
            </div>
          </div>
        </section>
        <section className="landing-cards" aria-label="Explore your coaching room">
          {cards.map((card) => (
            <button type="button" key={card.title} className={`landing-card${card.recommended ? ' landing-card--recommended' : ''}`} onClick={card.onClick}>
              <span className="landing-card-top"><span className="landing-icon-badge">{card.icon}</span><span className="landing-card-badge">{card.badge}</span></span>
              <h2>{card.title}</h2>
              <p>{card.description}</p>
              <span className="landing-card-cta">{card.action}<ArrowRightIcon className="landing-card-cta-arrow" /></span>
            </button>
          ))}
        </section>
        <section className="landing-flow" aria-labelledby="landing-flow-title">
          <h2 id="landing-flow-title" className="panel-kicker">HOW IT WORKS</h2>
          <ol>
            <li><span className="landing-step-number">01</span><h3>Play real tournament spots</h3><p>Face five adaptive bots in a full 6-max SNG with deterministic math, Monte Carlo equity, and exact ICM pressure.</p></li>
            <li><span className="landing-step-number">02</span><h3>Coach live with Dan</h3><p>Switch between Free Play and Training Mode. Dan pauses key decisions, calculates pot odds &amp; ICM, and coaches via text or Push-to-Talk voice.</p></li>
            <li><span className="landing-step-number">03</span><h3>Build persistent memory</h3><p>Completed spots update your Knowledge Map, track recurring leaks until overcome 3×, and save instructive hand highlights.</p></li>
          </ol>
        </section>
        <footer className="landing-footer">
          <span>2,000 starting chips · 6 hands/level · 65% / 35% ICM · Text &amp; Voice</span>
          <span>Table runs offline anytime · Coach Dan requires server API</span>
        </footer>
      </main>
    </div>
  );
}
