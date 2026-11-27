import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTournament } from '../../game/tournament';
import { gameStore } from '../../app/gameStore';
import type { GameViewState, SeatView } from '../../app/tableView';
import { TournamentPanel } from '../table/TournamentPanel';
import { PokerTable } from '../table/PokerTable';
import { ActionBar } from '../table/ActionBar';

// SSR normally uses Zustand's initial state; read each fixture's current state.
vi.mock('../../app/gameStore', async (original) => {
  const actual = await original<typeof import('../../app/gameStore')>();
  return { ...actual, useGameView: <T,>(select: (view: GameViewState) => T) => select(actual.gameStore.getState()) };
});

function fixture() {
  const tournament = createTournament(Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, isHero: i === 0 })), 0, 'ui');
  const seats: SeatView[] = tournament.players.map((p) => ({
    ...p, avatar: null, position: null, streetBet: 0, committed: 0, folded: false, allIn: false,
    holeCards: null, hasCards: false, isButton: p.seatIndex === 0, isActing: false,
    lastAction: null, showdownDescription: null, wonAmount: null, eliminated: false,
  }));
  return { tournament, seats };
}

beforeEach(() => gameStore.getState().reset());

describe('SNG interface', () => {
  it('uses live stacks while retaining all-in players in the remaining count', () => {
    const { tournament, seats } = fixture();
    seats[0].stack = 0;
    seats[0].allIn = true;
    seats[1].stack = 1947;
    const html = renderToStaticMarkup(<TournamentPanel tournament={tournament} seats={seats} />);
    expect(html).toContain('6 players remaining');
    expect(html).toContain('1,947 · 97.3 BB');
    expect(html).not.toContain('Spectating');
  });

  it('keeps dead-button and eliminated seats in their fixed physical slots', () => {
    const { seats } = fixture();
    seats[0].isButton = false;
    seats[4] = { ...seats[4], eliminated: true, stack: 0, isButton: true };
    gameStore.getState().publish({ seats });
    const html = renderToStaticMarkup(<PokerTable />);
    expect(html.match(/data-seat=/g)).toHaveLength(6);
    expect(html).toContain('seat--pos4 seat--eliminated');
    expect(html).toContain('title="Dead button"');
    expect(html).toContain('OUT');
  });

  it('shows tied prize shares without truncating fractional percentages', () => {
    const { tournament, seats } = fixture();
    tournament.players = tournament.players.map((p, i) => ({ ...p, stack: i === 0 ? 12000 : 0, place: i === 0 ? 1 : i < 4 ? 2 : i + 1, payoutShare: i === 0 ? 0.65 : i < 4 ? 0.35 / 3 : 0 }));
    const html = renderToStaticMarkup(<TournamentPanel tournament={tournament} seats={seats} />);
    expect(html).toContain('Final standings');
    expect(html.match(/11\.6667%/g)).toHaveLength(3);
    expect(html.match(/>T2</g)).toHaveLength(3);
  });

  it('uses the nominal bring-in for raise controls and permits single-chip increments', () => {
    const { seats } = fixture();
    seats[1].streetBet = 5;
    seats[2].streetBet = 7;
    gameStore.getState().publish({
      seats, currentBet: 10, status: 'playing',
      heroLegal: { seatIndex: 0, fold: true, check: false, call: { amount: 10, allIn: false }, raise: { minTo: 20, maxTo: 101 } },
    });
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain('step="1"');
    expect(html).toContain('Raise to');
    expect(html).toContain('value="20"');
    expect(html).not.toContain('Hand summary');
  });

  it('does not offer another hand after the tournament ends', () => {
    gameStore.getState().publish({ status: 'tournamentComplete', awaitingNext: false });
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain('Tournament complete');
    expect(html).not.toContain('Deal next hand');
  });
});
