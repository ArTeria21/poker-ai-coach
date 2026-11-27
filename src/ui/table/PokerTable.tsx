import { useGameStore } from '../../store/gameStore';
import type { SeatView } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { formatChips } from '../../game/format';
import { FeltOverlaySvg, SeatAvatarIcon } from '../Icons';
import { CardView } from './CardView';
import './PokerTable.css';

const formatBB = (chips: number, bigBlind: number) => `${(chips / Math.max(1, bigBlind)).toFixed(1)} BB`;

export function PokerTable() {
  const seats = useGameStore((s) => s.seats);
  const board = useGameStore((s) => s.board);
  const pot = useGameStore((s) => s.pot);
  const bigBlind = useGameStore((s) => s.bigBlind);
  const phase = useGameStore((s) => s.phase);
  const banner = useGameStore((s) => s.banner);
  const displayBB = useSettingsStore((s) => s.displayBB);

  const heroIndex = seats.find((s) => s.isHero)?.seatIndex ?? 0;
  const displaySlot = (seatIndex: number) => (seatIndex - heroIndex + 6) % 6;
  const formatTableChips = (chips: number) => (displayBB ? formatBB(chips, bigBlind) : formatChips(chips));

  return (
    <div className="table-zone">
      <div className="table-oval">
        <div className="table-rail" />
        <div className="table-felt">
          <FeltOverlaySvg />
        </div>

        <div className="table-center">
          <div className="pot-pill">
            <span className="pot-label">POT</span>
            <span className="pot-amount" title={formatBB(pot, bigBlind)}>{formatTableChips(pot)}</span>
            {!displayBB && pot > 0 && <span className="pot-bb">{formatBB(pot, bigBlind)}</span>}
          </div>
          <div className="board-row">
            {board.map((card, i) => (
              <CardView key={card} card={card} size="board" dealIndex={i >= 3 ? 0 : i} />
            ))}
            {Array.from({ length: 5 - board.length }, (_, i) => (
              <div key={`slot-${i}`} className="board-slot" />
            ))}
          </div>
          {banner ? (
            <div className="result-banner" role="status">{banner}</div>
          ) : (
            phase && phase !== 'complete' && <div className="phase-tag">{phase}</div>
          )}
        </div>

        {seats.map((seat) => (
          <Seat
            key={seat.seatIndex}
            seat={seat}
            slot={displaySlot(seat.seatIndex)}
            bigBlind={bigBlind}
            displayBB={displayBB}
            showBetChip={seat.lastAction !== null && phase !== 'complete'}
          />
        ))}
      </div>
    </div>
  );
}

function Seat({
  seat,
  slot,
  bigBlind,
  displayBB,
  showBetChip,
}: {
  seat: SeatView;
  slot: number;
  bigBlind: number;
  displayBB: boolean;
  showBetChip: boolean;
}) {
  const classes = [
    'seat',
    `seat--pos${slot}`,
    seat.folded ? 'seat--folded' : '',
    seat.eliminated ? 'seat--eliminated' : '',
    seat.isActing ? 'seat--acting' : '',
    seat.wonAmount != null ? 'seat--winner' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const cardSize = seat.isHero ? 'hole' : 'mini';
  const formatTableChips = (chips: number) => (displayBB ? formatBB(chips, bigBlind) : formatChips(chips));

  return (
    <>
      <div className={classes} data-seat={seat.seatIndex}>
        {seat.hasCards && (
          <div className="seat-cards">
            {seat.holeCards ? (
              <>
                <CardView card={seat.holeCards[0]} size={cardSize} dealIndex={0} dimmed={seat.folded} />
                <CardView card={seat.holeCards[1]} size={cardSize} dealIndex={1} dimmed={seat.folded} />
              </>
            ) : (
              <>
                <CardView size="mini" dealIndex={0} />
                <CardView size="mini" dealIndex={1} />
              </>
            )}
          </div>
        )}
        <div className="seat-pod">
          {seat.wonAmount != null && <span className="seat-won">+{formatTableChips(seat.wonAmount)}</span>}
          <span className={`seat-avatar${seat.isHero ? ' seat-avatar--hero' : ''}`}>
            <SeatAvatarIcon avatar={seat.avatar} isHero={seat.isHero} />
          </span>
          <span className="seat-info">
            <span className="seat-header-row">
              <span className="seat-name">{seat.name}</span>
              {seat.position && !seat.eliminated && (
                <span className={`seat-pos${seat.isHero ? ' seat-pos--hero' : ''}`}>{seat.position}</span>
              )}
            </span>
            <span className="seat-stack-row">
              <span
                className={`seat-stack${seat.allIn ? ' seat-stack--allin' : ''}`}
                title={!seat.eliminated && !seat.allIn ? formatBB(seat.stack, bigBlind) : undefined}
              >
                {seat.eliminated ? 'OUT' : seat.allIn ? 'ALL-IN' : formatTableChips(seat.stack)}
              </span>
              {seat.isHero && !seat.eliminated && !seat.allIn && !displayBB && (
                <span className="seat-bb">{formatBB(seat.stack, bigBlind)}</span>
              )}
            </span>
          </span>
        </div>
        {seat.showdownDescription && <div className="seat-descr">{seat.showdownDescription}</div>}
      </div>

      {(seat.isButton || showBetChip) && (
        <div className={`bet-spot bet-spot--pos${slot}`}>
          {seat.isButton && (
            <span className="dealer-button" title={seat.eliminated ? 'Dead button' : 'Dealer button'}>
              D
            </span>
          )}
          {showBetChip && seat.lastAction && (
            <span className="bet-chip" key={`${seat.lastAction.type}-${seat.lastAction.amount}`}>
              <span className="bet-action">{actionLabel(seat)}</span>
              {seat.lastAction.amount > 0 && <span>{formatTableChips(seat.lastAction.amount)}</span>}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function actionLabel(seat: SeatView): string {
  const a = seat.lastAction!;
  switch (a.type) {
    case 'small blind':
      return 'SB';
    case 'big blind':
      return 'BB';
    case 'raise':
      return seat.allIn ? 'ALL-IN' : 'RAISE';
    case 'bet':
      return seat.allIn ? 'ALL-IN' : 'BET';
    case 'call':
      return seat.allIn ? 'ALL-IN' : 'CALL';
    case 'check':
      return 'CHECK';
    case 'fold':
      return 'FOLD';
  }
}
