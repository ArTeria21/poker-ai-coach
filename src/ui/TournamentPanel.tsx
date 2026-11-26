import { BLIND_LEVELS, HANDS_PER_LEVEL, PAYOUT_SHARES, type TournamentState } from '../game/tournament';
import { formatChips } from '../game/format';
import type { SeatView } from '../store/gameStore';

const percent = (share: number) => new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 4 }).format(share);

export function TournamentPanel({ tournament, seats }: { tournament: TournamentState; seats: SeatView[] }) {
  const live = tournament.players.filter((p) => p.stack > 0);
  const complete = live.length === 1 && tournament.pendingHandId === null;
  const hero = tournament.players.find((p) => p.isHero)!;
  const level = BLIND_LEVELS[tournament.levelIndex];
  const standings = [...tournament.players].sort((a, b) => {
    if (a.place === null && b.place === null) return b.stack - a.stack;
    return (a.place ?? 0) - (b.place ?? 0) || a.seatIndex - b.seatIndex;
  });
  const completedAtLevel = tournament.completedHands - tournament.levelIndex * HANDS_PER_LEVEL;
  const levelCapped = tournament.levelIndex === BLIND_LEVELS.length - 1;
  return (
    <details className="tournament-panel" onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.open = false; }}>
      <summary>
        <span className="panel-kicker">SNG</span>
        {complete ? 'Tournament complete' : `${live.length} left`} · Level {tournament.levelIndex + 1} · {formatChips(level.smallBlind)}/{formatChips(level.bigBlind)} · BBA {formatChips(level.bigBlindAnte)}
        {' · '}{levelCapped ? 'final level' : `${Math.min(completedAtLevel, HANDS_PER_LEVEL)}/${HANDS_PER_LEVEL} hands`} · Prizes {PAYOUT_SHARES.map(percent).join(' / ')}
      </summary>
      <div className="tournament-body">
        <h2>{complete ? 'Tournament complete' : `${live.length} players remaining`}</h2>
        {hero.stack === 0 && <p className="spectator-note">You finished {tournament.players.filter((p) => p.place === hero.place).length > 1 ? 'tied ' : ''}#{hero.place}. {complete ? '' : 'Spectating the remaining players.'}</p>}
        {complete && <p className="winner-note">{live[0].name} wins the SNG.</p>}
        <section className="tournament-section">
          <div className="section-heading"><h3>Level {tournament.levelIndex + 1}</h3><span>{levelCapped ? 'Final level' : `${Math.min(completedAtLevel, HANDS_PER_LEVEL)} / ${HANDS_PER_LEVEL} hands complete`}</span></div>
          <div className="blind-values"><strong>{formatChips(level.smallBlind)} / {formatChips(level.bigBlind)}</strong><span>Big blind ante <b>{formatChips(level.bigBlindAnte)}</b></span></div>
          <p className="panel-note">Six completed hands per level. Changes apply on the next deal.</p>
        </section>
        <section className="tournament-section">
          <h3>Prize pool shares</h3>
          <div className="payout-grid">{PAYOUT_SHARES.map((share, i) => <div key={i}><span>#{i + 1}</span><strong>{percent(share)}</strong></div>)}</div>
          <p className="panel-note">Play chips · no rebuys. Equal places split their combined prize shares.</p>
        </section>
        <section className="tournament-section">
          <h3>{complete ? 'Final standings' : 'Standings'}</h3>
          <table className="standings"><thead><tr><th>Place</th><th>Player</th><th>{complete ? 'Prize share' : 'Stack / prize'}</th></tr></thead><tbody>
            {standings.map((player) => {
              const tied = player.place !== null && tournament.players.filter((p) => p.place === player.place).length > 1;
              const stack = seats.find((seat) => seat.id === player.id)?.stack ?? player.stack;
              return <tr key={player.id} className={player.isHero ? 'standings-hero' : ''}>
                <td>{player.place === null ? '—' : `${tied ? 'T' : ''}${player.place}`}</td>
                <td>{player.name}{player.isHero ? ' · you' : ''}</td>
                <td>{player.place === null ? `${formatChips(stack)} · ${(stack / level.bigBlind).toFixed(1)} BB` : percent(player.payoutShare)}</td>
              </tr>;
            })}
          </tbody></table>
        </section>
        <details className="tournament-section blind-schedule">
          <summary>Blind schedule</summary>
          <table><thead><tr><th>Level</th><th>SB / BB</th><th>BBA</th></tr></thead><tbody>
            {BLIND_LEVELS.map((entry, i) => <tr key={i} className={i === tournament.levelIndex ? 'current-level' : ''}><td>{i + 1}</td><td>{formatChips(entry.smallBlind)} / {formatChips(entry.bigBlind)}</td><td>{formatChips(entry.bigBlindAnte)}</td></tr>)}
          </tbody></table>
        </details>
      </div>
    </details>
  );
}
