import type { CoachSnapshot } from '../agent/contract';
import type { GameViewState } from './tableView';
import { BLIND_LEVELS, HANDS_PER_LEVEL, PAYOUT_SHARES } from '../game/tournament';
import { effectiveStack, spr } from '../math/pokerMath';

/** Maps the sanitized store view to the coach contract; null before the first hand. */
export function coachSnapshot(view: GameViewState): CoachSnapshot | null {
  const t = view.tournament;
  const hero = view.seats.find((s) => s.isHero);
  if (!t || !hero) return null;
  const toBB = (amount: number) => Math.round((amount / view.bigBlind) * 100) / 100;
  const place = (id: string) => t.players.find((p) => p.id === id)!.place;
  const seatOf = (id: string) => view.seats.find((s) => s.id === id)!;

  const inHand = view.status === 'playing' && hero.position !== null && !hero.folded;
  const opponents = view.seats.filter((s) => !s.isHero && s.position !== null && !s.folded);
  const covers = inHand && opponents.length > 0
    ? opponents.map((o) => effectiveStack({ behind: hero.stack, streetBet: hero.streetBet }, { behind: o.stack, streetBet: o.streetBet }))
    : null;
  const effective = covers && Math.max(...covers.map((c) => c.heroAdditionalCover));
  const streetStartPot = view.pot - view.seats.reduce((sum, s) => sum + s.streetBet, 0);
  const sprValue = covers && view.phase !== 'preflop'
    ? spr(Math.max(...covers.map((c) => c.totalStreetCover)), streetStartPot).value
    : null;

  const history = view.handActions.map((a): CoachSnapshot['history'][number] => {
    const seat = seatOf(a.playerId);
    // Preflop the blinds are the opening bet, so every preflop aggression is a raise.
    const action = a.type === 'raise' && a.street !== 'preflop' && a.toCallBefore === 0 ? 'bet' : a.type;
    return {
      street: a.street, player: seat.name, position: seat.position!, action,
      amountAdded: a.amountAdded, raiseTo: a.type === 'raise' ? a.toStreetBet : null,
      potBefore: a.potBefore, toCallBefore: a.toCallBefore, stackBefore: a.stackBefore,
      allIn: a.amountAdded > 0 && a.amountAdded === a.stackBefore,
    };
  });

  const level = BLIND_LEVELS[t.levelIndex];
  const legal = view.heroLegal;
  const complete = view.phase === 'complete';
  // Outs lists over-count and the grader's SPR is mid-street; the snapshot's own SPR and the outs tool cover the live spot.
  const grade = view.latestDecisionGrade;
  let lastDecisionGrade: CoachSnapshot['lastDecisionGrade'] = null;
  if (grade) {
    const { draws: _draws, spr: _spr, ...facts } = grade.facts;
    lastDecisionGrade = { ...grade, facts };
  }
  return {
    status: view.status === 'tournamentComplete' || view.status === 'handComplete' ? view.status
      : legal ? 'heroToAct' : 'botsActing',
    awaitingNextHand: view.awaitingNext,
    handId: view.handId!,
    handNumber: view.handNumber,
    street: view.phase!,
    tournament: {
      ...level,
      level: t.levelIndex + 1,
      handsPlayedAtLevel: Math.min(t.completedHands - t.levelIndex * HANDS_PER_LEVEL, HANDS_PER_LEVEL),
      handsPerLevel: HANDS_PER_LEVEL,
      nextLevel: BLIND_LEVELS[t.levelIndex + 1] ?? null,
      // Settled stacks: a player all-in during the hand still counts until it is settled.
      playersRemaining: t.players.filter((p) => p.stack > 0).length,
      payoutSharesByPlace: [...PAYOUT_SHARES],
    },
    players: view.seats.map((s) => ({
      seat: s.seatIndex, name: s.name, isHero: s.isHero, position: s.position,
      stack: s.stack, stackBB: toBB(s.stack), streetBet: complete ? 0 : s.streetBet, committedThisHand: s.committed,
      folded: s.folded, allIn: s.allIn, isActing: s.isActing, eliminated: s.eliminated, finishPlace: place(s.id),
      shownCards: s.isHero ? null : s.holeCards, showdownDescription: s.showdownDescription, wonThisHand: s.wonAmount,
    })),
    hero: {
      name: hero.name,
      cards: hero.holeCards,
      position: hero.position,
      stack: hero.stack,
      stackBB: toBB(hero.stack),
      effectiveStack: effective,
      effectiveStackBB: effective === null ? null : toBB(effective),
      sprAtStreetStart: sprValue === null ? null : Math.round(sprValue * 100) / 100,
      toCall: legal ? legal.call?.amount ?? 0 : null,
      eliminated: hero.eliminated,
      finishPlace: place(hero.id),
    },
    board: view.board,
    pot: view.pot,
    potBB: toBB(view.pot),
    // Uncalled bets are refunded at hand end but the engine leaves street bets in place.
    currentBet: complete ? 0 : view.currentBet,
    // The engine's seatIndex is hand-local; the hero is implied.
    legalActions: legal && { fold: legal.fold, check: legal.check, call: legal.call, raise: legal.raise },
    forcedBets: view.forcedBets.map((f) => ({ player: seatOf(f.playerId).name, kind: f.kind, amount: f.amount })),
    history,
    lastDecisionGrade,
  };
}
