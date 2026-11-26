import { useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { tableController } from '../../game/tableController';
import { formatChips } from '../../game/format';
import type { PlayerAction } from '../../engine/types';
import { dispatch, useTableLock } from '../coachSession';
import { useSettingsStore } from '../../store/settingsStore';
import './ActionBar.css';

export function ActionBar() {
  const heroLegal = useGameStore((s) => s.heroLegal);
  const pot = useGameStore((s) => s.pot);
  const currentBet = useGameStore((s) => s.currentBet);
  const status = useGameStore((s) => s.status);
  const awaitingNext = useGameStore((s) => s.awaitingNext);
  const toCall = heroLegal?.call?.amount ?? 0;
  const raise = heroLegal?.raise;
  const lock = useTableLock();
  const training = useSettingsStore((s) => s.mode === 'training');

  const [raiseTo, setRaiseTo] = useState(0);
  useEffect(() => {
    if (raise) setRaiseTo(raise.minTo);
  }, [raise]);

  if (!heroLegal) {
    if (awaitingNext) {
      return (
        <div className="action-bar">
          <div className="action-buttons action-buttons--between">
            <button className="btn btn--raise" disabled={lock.review} onClick={() => tableController.continueNextHand()}>
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

  const clamp = (v: number) => {
    if (!raise) return v;
    const snapped = Math.round(v);
    return Math.max(raise.minTo, Math.min(raise.maxTo, snapped));
  };

  const presetTo = (frac: number) => clamp(currentBet + frac * (pot + toCall));

  const presets: { label: string; value: number }[] = raise
    ? [
        { label: 'Min', value: raise.minTo },
        { label: '½ Pot', value: presetTo(0.5) },
        { label: '¾ Pot', value: presetTo(0.75) },
        { label: 'Pot', value: presetTo(1) },
        { label: 'All-in', value: raise.maxTo },
      ]
    : [];

  // Reported before the controller runs, since the action may complete the hand.
  const act = (action: PlayerAction) => {
    dispatch({ type: 'heroActed', action: action.type });
    tableController.humanAct(action);
  };

  const isBet = currentBet === 0;
  const selectedRaiseTo = raise ? clamp(raiseTo || raise.minTo) : 0;
  const raiseIsAllIn = raise && selectedRaiseTo >= raise.maxTo;

  return (
    <div className="action-bar">
      <div className="action-buttons">
        <button className="btn btn--fold" disabled={lock.decision} onClick={() => act({ type: 'fold' })}>
          Fold
        </button>
        {heroLegal.check ? (
          <button className="btn btn--call" disabled={lock.decision} onClick={() => act({ type: 'check' })}>
            Check
          </button>
        ) : (
          <button className="btn btn--call" disabled={lock.decision} onClick={() => act({ type: 'call' })}>
            Call {formatChips(toCall)}
            {heroLegal.call?.allIn ? ' · all-in' : ''}
          </button>
        )}
        {raise && (
          <button
            className="btn btn--raise"
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
          <input
            type="range"
            min={raise.minTo}
            max={raise.maxTo}
            step={1}
            value={selectedRaiseTo}
            aria-label="Raise to"
            onChange={(e) => setRaiseTo(clamp(Number(e.target.value)))}
            className="raise-slider"
          />
          <div className="raise-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                className={`preset${selectedRaiseTo === p.value ? ' preset--active' : ''}`}
                onClick={() => setRaiseTo(p.value)}
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
