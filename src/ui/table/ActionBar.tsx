import { useEffect, useState, type CSSProperties } from 'react';
import { useGameView } from '../../app/gameStore';
import { tableController } from '../../app/tableController';
import { formatChips } from '../../game/format';
import type { PlayerAction } from '../../engine/types';
import { dispatch, useTableLock } from '../../app/coachSession';
import { useSettingsStore } from '../../app/settingsStore';
import './ActionBar.css';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function ActionBar() {
  const heroLegal = useGameView((s) => s.heroLegal);
  const pot = useGameView((s) => s.pot);
  const currentBet = useGameView((s) => s.currentBet);
  const bigBlind = useGameView((s) => s.bigBlind);
  const phase = useGameView((s) => s.phase);
  const status = useGameView((s) => s.status);
  const awaitingNext = useGameView((s) => s.awaitingNext);
  const toCall = heroLegal?.call?.amount ?? 0;
  const raise = heroLegal?.raise;
  const lock = useTableLock();
  const training = useSettingsStore((s) => s.mode === 'training');

  const [raiseTo, setRaiseTo] = useState(0);
  const [draftAmount, setDraftAmount] = useState<string | null>(null);

  useEffect(() => {
    if (raise) {
      setRaiseTo(raise.minTo);
      setDraftAmount(null);
    }
  }, [raise]);

  const clamp = (v: number) => {
    if (!raise) return v;
    const snapped = Math.round(v);
    return Math.max(raise.minTo, Math.min(raise.maxTo, snapped));
  };

  const selectedRaiseTo = raise ? clamp(raiseTo || raise.minTo) : 0;

  // Reported before the controller runs, since the action may complete the hand.
  const act = (action: PlayerAction) => {
    dispatch({ type: 'heroActed', action: action.type });
    tableController.humanAct(action);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;

      if (!heroLegal) {
        if (awaitingNext && !lock.review && (e.key === 'Enter' || e.key === ' ')) {
          if (e.target instanceof HTMLElement && e.target.closest('button, a, summary')) return;
          e.preventDefault();
          tableController.continueNextHand();
        }
        return;
      }

      if (lock.decision) return;
      const key = e.key.toLowerCase();
      if (key === 'f' && heroLegal.fold) {
        e.preventDefault();
        act({ type: 'fold' });
      } else if (key === 'c') {
        if (heroLegal.check) {
          e.preventDefault();
          act({ type: 'check' });
        } else if (heroLegal.call) {
          e.preventDefault();
          act({ type: 'call' });
        }
      } else if (key === 'r' && raise) {
        e.preventDefault();
        act({ type: 'raise', amount: selectedRaiseTo });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!heroLegal) {
    if (awaitingNext) {
      return (
        <div className="action-bar">
          <div className="action-buttons action-buttons--between">
            <button
              className="btn btn--mint"
              data-key="Enter"
              title="Deal next hand (Enter)"
              disabled={lock.review}
              onClick={() => tableController.continueNextHand()}
            >
              Deal next hand →
            </button>
          </div>
          {/* Laid out for the whole of Training, so the button does not move when the review lock comes and goes. */}
          {training && (
            <span className="lock-hint" style={{ visibility: lock.review ? 'visible' : 'hidden' }} aria-hidden={!lock.review}>
              Next hand unlocks after Dan's review · answer him in the chat, or switch to Free Play
            </span>
          )}
        </div>
      );
    }
    return (
      <div className="action-bar action-bar--waiting">
        <span className="waiting-text">
          {status === 'playing' ? 'Waiting for the table…' : status === 'tournamentComplete' ? 'Tournament complete · Start a new SNG to play again' : ''}
        </span>
      </div>
    );
  }

  const presetTo = (frac: number) => clamp(currentBet + frac * (pot + toCall));
  const preflopUnit = currentBet > bigBlind ? currentBet : bigBlind;

  const presets: { label: string; value: number }[] = raise
    ? phase === 'preflop'
      ? [
          { label: 'Min', value: raise.minTo },
          { label: '2.5x', value: clamp(Math.round(preflopUnit * 2.5)) },
          { label: '3x', value: clamp(Math.round(preflopUnit * 3)) },
          { label: 'Pot', value: presetTo(1) },
          { label: 'All-in', value: raise.maxTo },
        ]
      : [
          { label: 'Min', value: raise.minTo },
          { label: '½ Pot', value: presetTo(0.5) },
          { label: '¾ Pot', value: presetTo(0.75) },
          { label: 'Pot', value: presetTo(1) },
          { label: 'All-in', value: raise.maxTo },
        ]
    : [];

  const isBet = currentBet === 0;
  const raiseIsAllIn = raise && selectedRaiseTo >= raise.maxTo;
  const sliderPct =
    raise && raise.maxTo > raise.minTo
      ? ((selectedRaiseTo - raise.minTo) / (raise.maxTo - raise.minTo)) * 100
      : 0;
  const sliderStyle = { '--slider-pct': `${sliderPct.toFixed(1)}%` } as CSSProperties;

  const commitDraft = () => {
    if (draftAmount === null) return;
    const parsed = Number(draftAmount);
    if (Number.isFinite(parsed) && draftAmount.trim() !== '') {
      setRaiseTo(clamp(parsed));
    }
    setDraftAmount(null);
  };

  return (
    <div className="action-bar">
      <div className="action-buttons">
        <button
          className="btn btn--fold"
          data-key="F"
          title="Fold (F)"
          disabled={lock.decision}
          onClick={() => act({ type: 'fold' })}
        >
          Fold
        </button>
        {heroLegal.check ? (
          <button
            className="btn btn--call"
            data-key="C"
            title="Check (C)"
            disabled={lock.decision}
            onClick={() => act({ type: 'check' })}
          >
            Check
          </button>
        ) : (
          <button
            className="btn btn--call"
            data-key="C"
            title="Call (C)"
            disabled={lock.decision}
            onClick={() => act({ type: 'call' })}
          >
            Call {formatChips(toCall)}
            {heroLegal.call?.allIn ? ' · all-in' : ''}
          </button>
        )}
        {raise && (
          <button
            className="btn btn--raise"
            data-key="R"
            title={`${raiseIsAllIn ? 'All-in' : isBet ? 'Bet' : 'Raise'} (R)`}
            disabled={lock.decision}
            onClick={() => act({ type: 'raise', amount: selectedRaiseTo })}
          >
            {raiseIsAllIn ? 'All-in' : isBet ? 'Bet' : 'Raise to'} {formatChips(selectedRaiseTo)}
          </button>
        )}
      </div>

      {/* In place of the raise controls, so the locked bar keeps its size. */}
      {lock.decision ? (
        <span className="lock-hint">Locked until Dan unlocks every legal action · answer him in the chat, or switch to Free Play</span>
      ) : raise && raise.minTo < raise.maxTo && (
        <div className="raise-controls">
          <div className="raise-input-row">
            <input
              type="range"
              min={raise.minTo}
              max={raise.maxTo}
              step={1}
              value={selectedRaiseTo}
              aria-label="Raise to"
              style={sliderStyle}
              onChange={(e) => {
                setDraftAmount(null);
                setRaiseTo(clamp(Number(e.target.value)));
              }}
              className="raise-slider"
            />
            <div className="raise-num-wrap">
              <input
                type="number"
                className="raise-number"
                min={raise.minTo}
                max={raise.maxTo}
                step={1}
                value={draftAmount ?? selectedRaiseTo}
                aria-label="Exact raise amount"
                onChange={(e) => {
                  const raw = e.target.value;
                  setDraftAmount(raw);
                  const parsed = Number(raw);
                  if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= raise.minTo && parsed <= raise.maxTo) {
                    setRaiseTo(Math.round(parsed));
                  }
                }}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitDraft();
                  }
                }}
              />
              <span className="raise-bb-hint">{(selectedRaiseTo / Math.max(1, bigBlind)).toFixed(1)} BB</span>
            </div>
          </div>
          <div className="raise-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`preset${selectedRaiseTo === p.value ? ' preset--active' : ''}`}
                onClick={() => {
                  setDraftAmount(null);
                  setRaiseTo(p.value);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
