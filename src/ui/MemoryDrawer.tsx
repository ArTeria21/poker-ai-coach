import { useEffect, useId, useRef, useState } from 'react';
import type { MemoryOverview } from '../../server/memory';
import { CloseIcon, DiagnosticsIcon, MemoryIcon } from './Icons';
import { useDiagnosisStore } from '../app/coachSession';
import './MemoryDrawer.css';

interface MemoryDrawerProps {
  open: boolean;
  onClose: () => void;
  onStartDiagnostics: () => void;
  onEnterTournament: () => void;
}

const TABS = ['Profile', 'Knowledge Map', 'Highlights'] as const;
type Tab = typeof TABS[number];
const PROFILE_SECTIONS = [
  ['workbench', 'Current Workbench'], ['studentProfile', 'Student Profile'], ['conventions', 'Conventions'],
] as const;

export function MemoryDrawer({ open, ...props }: MemoryDrawerProps) {
  // Each opening gets a fresh snapshot; the closed drawer never fetches.
  return open ? <OpenMemoryDrawer {...props} /> : null;
}

function OpenMemoryDrawer({ onClose, onStartDiagnostics, onEnterTournament }: Omit<MemoryDrawerProps, 'open'>) {
  const [memory, setMemory] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<Tab>('Profile');
  const initialized = useDiagnosisStore((s) => s.initialized);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const controller = new AbortController();
    setMemory(null);
    setError(false);
    queueMicrotask(async () => {
      if (controller.signal.aborted) return;
      try {
        const res = await fetch('/api/memory', { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as MemoryOverview;
        if (controller.signal.aborted) return;
        setMemory(data);
        useDiagnosisStore.setState({ initialized: data.initialized });
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const buttons = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]');
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const empty = memory && !memory.initialized && !memory.knowledgeMap && !memory.knowledgeMapError && memory.highlights.total === 0;

  return (
    <div className="memory-drawer">
      <div className="memory-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="memory-drawer-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={(event) => event.stopPropagation()}>
        <header className="memory-drawer-header">
          <div><span className="panel-kicker">AGENT MEMORY</span><h2 id={`${id}-title`}>What Dan Remembers</h2></div>
          <button type="button" className="memory-close" ref={closeRef} onClick={onClose} aria-label="Close memory drawer"><CloseIcon /></button>
          <button type="button" className="memory-diagnose" onClick={onStartDiagnostics}><DiagnosticsIcon width={14} height={14} />{initialized === true ? 'Re-run diagnostics' : 'Take diagnostics'}</button>
        </header>
        <div className="memory-tabs segmented-options" role="tablist" aria-label="Agent memory sections">
          {TABS.map((name, index) => (
            <button
              key={name} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
              aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
              className={`segmented-opt${tab === name ? ' segmented-opt--active' : ''}`}
              onClick={() => setTab(name)}
              onKeyDown={(event) => {
                const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
                  : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
                if (next === null) return;
                event.preventDefault();
                setTab(TABS[next]);
                document.getElementById(`${id}-tab-${next}`)?.focus();
              }}
            >{name}</button>
          ))}
        </div>
        <div className="memory-drawer-content" role="tabpanel" id={`${id}-panel-${TABS.indexOf(tab)}`} aria-labelledby={`${id}-tab-${TABS.indexOf(tab)}`} tabIndex={0}>
          {error ? (
            <div className="memory-state" role="alert">
              <h3>Could not load memory</h3>
              <p>Make sure the local API server is running, or enter the table to play offline.</p>
              <div className="memory-state-actions"><button type="button" className="memory-action memory-action--primary" onClick={() => setAttempt((value) => value + 1)}>Retry</button><button type="button" className="memory-action" onClick={onEnterTournament}>Enter Tournament</button></div>
            </div>
          ) : !memory ? <p className="memory-loading" role="status">Loading Coach Dan's memory…</p> : empty ? (
            <div className="memory-state">
              <span className="memory-empty-icon"><MemoryIcon width={28} height={28} /></span>
              <h3>Dan doesn't know your game yet.</h3>
              <p>Run a quick level diagnostic to map your poker fundamentals, or play a few coached hands. Dan will automatically track your strengths, active leaks, and key hand highlights here.</p>
              <div className="memory-state-actions"><button type="button" className="memory-action memory-action--primary" onClick={onStartDiagnostics}>Take Diagnostics</button><button type="button" className="memory-action" onClick={onEnterTournament}>Enter Tournament</button></div>
            </div>
          ) : tab === 'Profile' ? (
            memory.workingState ? PROFILE_SECTIONS.map(([key, title]) => (
              <section className="memory-section" key={key}><h3>{title}</h3><p className="memory-profile-text">{memory.workingState!.sections[key] || 'Nothing recorded yet.'}</p></section>
            )) : <p className="memory-note">No student profile saved yet. Run diagnostics or play a few coached hands.</p>
          ) : tab === 'Knowledge Map' ? (
            <KnowledgeMap memory={memory} />
          ) : (
            memory.highlights.entries.length === 0 ? <p className="memory-note">No hand highlights saved yet. Ask Dan to review an instructive spot during play.</p> : (
              <>
                <p className="memory-note">Showing {memory.highlights.entries.length} of {memory.highlights.total} saved highlights</p>
                {[...memory.highlights.entries].reverse().sort((a, b) => b.date.localeCompare(a.date)).map((entry) => (
                  <article className="memory-highlight" key={entry.handId}>
                    <div className="memory-entry-meta"><time dateTime={entry.date}>{entry.date}</time><span className="memory-badge">Independence {entry.independence}/3</span></div>
                    <h3>{entry.handId}</h3>
                    <dl><dt>Spot</dt><dd>{entry.spot}</dd><dt>Takeaway</dt><dd>{entry.takeaway}</dd></dl>
                  </article>
                ))}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Mastery({ value, max = 3, label }: { value: number; max?: number; label: string }) {
  return (
    <div className="memory-mastery" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      {Array.from({ length: max }, (_, index) => <span key={index} className={index < value ? 'memory-mastery-filled' : ''} />)}
    </div>
  );
}

function KnowledgeMap({ memory }: { memory: MemoryOverview }) {
  if (memory.knowledgeMapError) return <div className="memory-state" role="alert"><h3>Could not read the knowledge map</h3><p>{memory.knowledgeMapError}</p></div>;
  const map = memory.knowledgeMap;
  return (
    <>
      <section className="memory-section">
        <h3>Active Bottlenecks</h3>
        {!map?.bottlenecks.length ? <p className="memory-note">No active bottlenecks tracked right now.</p> : map.bottlenecks.map((bottleneck) => (
          <article className="memory-bottleneck" key={bottleneck.id}>
            <h4>{bottleneck.title}</h4>
            <span className="memory-badge">Overcome {bottleneck.overcome.length}/{bottleneck.target}</span>
            <Mastery value={bottleneck.overcome.length} max={bottleneck.target} label={`Overcoming ${bottleneck.title}`} />
            {bottleneck.seen && <p className="memory-note">Last seen · {bottleneck.seen}</p>}
          </article>
        ))}
      </section>
      <section className="memory-section">
        <h3>12-Topic Catalog</h3>
        {!map ? <p className="memory-note">No knowledge map saved yet. Take diagnostics to map your fundamentals.</p> : <div className="memory-topic-grid">
          {map.topics.map((topic) => (
            <article className={`memory-topic memory-topic--${topic.status}`} key={topic.id}>
              <h4>{topic.title}</h4>
              <span className="memory-badge">{topic.label}</span>
              <Mastery value={topic.status} label={`${topic.title} mastery`} />
            </article>
          ))}
        </div>}
      </section>
    </>
  );
}
