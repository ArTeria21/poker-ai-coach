import { gradeDecision, type DecisionGrade } from '../analysis/gradeHand';
import type { GameState, PlayerAction } from '../engine/types';
import { positionOfSeat, totalPot } from '../engine/types';
import type { HandEvent } from '../engine/events';
import { applyAction, startHand } from '../engine/gameStateMachine';
import { legalActions } from '../engine/bettingRules';
import { mulberry32, randomSeed, type Rng } from '../engine/rng';
import { PERSONALITIES, type Personality } from '../bots/personalities';
import { buildBotView, decideAction } from '../bots/botDecision';
import { bluffRevealCheck } from './bluffReveal';
import { beginTournamentHand, createTournament, settleTournamentHand, type TournamentState } from './tournament';
import { sounds } from './sounds';
import { useGameStore, type GameViewState, type SeatView } from '../store/gameStore';
import { SPEED_FACTOR, useSettingsStore } from '../store/settingsStore';
import { formatCards } from './format';

const DEFAULT_BOTS = ['shark', 'rock', 'maniac', 'fish', 'nit'];

/** Runs the pure hand/tournament engines and publishes public table snapshots. */
export class TableController {
  private tournament: TournamentState | null = null;
  private state: GameState | null = null;
  private latestDecisionGrade: DecisionGrade | null = null;
  private handNumber = 0;
  private botRng: Rng = mulberry32(randomSeed());
  private pendingHuman: ((a: PlayerAction | null) => void) | null = null;
  private pendingNext: (() => void) | null = null;
  private sessionToken = 0;
  private lastActions = new Map<number, SeatView['lastAction']>();
  private reveals = new Map<number, string>();
  private winners = new Map<number, number>();
  private mainPotWinners: number[] = [];
  private banner: string | null = null;
  private streetHasBet = true;
  private quipId = 0;
  private lastQuipAt = 0;
  private lastQuipBySeat = new Map<number, number>();

  startSession(heroName = 'You'): void {
    this.stop();
    const lineup = [
      { id: 'hero', name: heroName, isHero: true },
      ...DEFAULT_BOTS.map((id) => ({ id, name: PERSONALITIES[id].name, isHero: false, personalityId: id })),
    ];
    const id = `sng-${Date.now().toString(36)}-${this.sessionToken}-${randomSeed().toString(36)}`;
    this.tournament = createTournament(lineup, Math.floor(Math.random() * 6), id);
    this.state = null;
    this.handNumber = 0;
    this.botRng = mulberry32(randomSeed());
    this.lastQuipAt = 0;
    this.lastQuipBySeat.clear();
    useGameStore.getState().reset();
    void this.runLoop(this.sessionToken);
  }

  stop(): void {
    this.sessionToken++;
    const human = this.pendingHuman;
    const next = this.pendingNext;
    this.pendingHuman = null;
    this.pendingNext = null;
    human?.(null);
    next?.();
  }

  continueNextHand(): void {
    const resume = this.pendingNext;
    this.pendingNext = null;
    resume?.();
  }

  humanAct(action: PlayerAction): void {
    const resolve = this.pendingHuman;
    if (!resolve || !this.state) return;
    const la = legalActions(this.state);
    if (!la || !['fold','check','call','raise'].includes(action.type)) return;
    if (action.type === 'fold' && !la.fold) return;
    if (action.type === 'check' && !la.check) return;
    if (action.type === 'call' && !la.call) return;
    if (action.type === 'raise') {
      if (!la.raise || action.amount == null || !Number.isFinite(action.amount)) return;
      action = { type: 'raise', amount: Math.max(la.raise.minTo, Math.min(la.raise.maxTo, Math.round(action.amount))) };
    }
    this.latestDecisionGrade = gradeDecision(buildBotView(this.state, la.seatIndex), action);
    this.pendingHuman = null;
    resolve(action);
  }

  private async runLoop(token: number): Promise<void> {
    while (token === this.sessionToken) {
      await this.playHand(token);
      if (token !== this.sessionToken) return;
      if (this.tournament!.players.filter((p) => p.stack > 0).length === 1) return;
      await this.delay(1500);
      if (token !== this.sessionToken) return;
      const next = new Promise<void>((resolve) => { this.pendingNext = resolve; });
      this.publishSnapshot({ awaitingNext: true });
      await next;
      if (token !== this.sessionToken) return;
      this.publishSnapshot({ awaitingNext: false });
    }
  }

  private async playHand(token: number): Promise<void> {
    const begun = beginTournamentHand(this.tournament!);
    this.tournament = begun.tournament;
    this.handNumber = this.tournament.completedHands + 1;
    this.latestDecisionGrade = null;
    this.lastActions.clear();
    this.reveals.clear();
    this.winners.clear();
    this.mainPotWinners = [];
    this.banner = null;
    this.streetHasBet = true;
    const started = startHand(begun.config, randomSeed(), begun.handId);
    this.state = started.state;
    this.consumeEvents(started.events);
    this.publishSnapshot({ heroLegal: null, awaitingNext: false });

    while (this.state.phase !== 'complete' && token === this.sessionToken) {
      const seat = this.state.actionOn!;
      const player = this.state.players[seat];
      let action: PlayerAction | null;
      if (player.isHero) {
        const human = new Promise<PlayerAction | null>((resolve) => { this.pendingHuman = resolve; });
        this.publishSnapshot({ heroLegal: legalActions(this.state) });
        sounds.yourTurn();
        action = await human;
        if (token !== this.sessionToken || action === null) return;
        this.publishSnapshot({ heroLegal: null });
      } else {
        await this.delay(450 + this.botRng() * 950);
        if (token !== this.sessionToken) return;
        const personality = PERSONALITIES[this.state.config.seats[seat].personalityId!];
        action = decideAction(buildBotView(this.state, seat), personality, useSettingsStore.getState().difficulty, this.botRng).action;
      }
      const result = applyAction(this.state, action);
      this.state = result.state;
      this.consumeEvents(result.events);
      this.publishSnapshot();
      if (result.events.some((e) => e.type === 'streetDealt')) {
        await this.delay(650);
        if (token !== this.sessionToken) return;
      }
      if (result.events.some((e) => e.type === 'showdown')) {
        await this.delay(900);
        if (token !== this.sessionToken) return;
      }
    }
    if (token !== this.sessionToken) return;
    this.maybeRevealBluff();
    this.tournament = settleTournamentHand(this.tournament, this.state);
    this.publishSnapshot({ heroLegal: null });
  }

  /**
   * Occasionally lets a bot say something in character. Rate-limited: one
   * quip per 6s globally and per 18s per bot, so the table never gets loud.
   */
  private maybeQuip(seatIndex: number, kind: keyof Personality['quips'], probability: number): void {
    const player = this.state?.config.seats[seatIndex];
    if (!player?.personalityId) return;
    const now = Date.now();
    if (now - this.lastQuipAt < 6000) return;
    const physicalSeat = this.tournament!.players.find((p) => p.id === player.id)!.seatIndex;
    if (now - (this.lastQuipBySeat.get(physicalSeat) ?? 0) < 18_000) return;
    if (this.botRng() > probability) return;
    this.emitQuip(seatIndex, kind);
  }

  /** Publishes a quip bubble unconditionally (cooldowns handled by callers). */
  private emitQuip(seatIndex: number, kind: keyof Personality['quips']): void {
    const player = this.state?.config.seats[seatIndex];
    if (!player?.personalityId) return;
    const lines = PERSONALITIES[player.personalityId].quips[kind];
    if (lines.length === 0) return;
    const text = lines[Math.floor(this.botRng() * lines.length)];
    const physicalSeat = this.tournament!.players.find((p) => p.id === player.id)!.seatIndex;
    this.lastQuipAt = Date.now();
    this.lastQuipBySeat.set(physicalSeat, this.lastQuipAt);
    const id = ++this.quipId;
    const token = this.sessionToken;
    useGameStore.getState().publish({ quips: { ...useGameStore.getState().quips, [physicalSeat]: { text, id } } });
    setTimeout(() => {
      if (token !== this.sessionToken) return;
      const current = useGameStore.getState().quips;
      if (current[physicalSeat]?.id !== id) return;
      const next = { ...current };
      delete next[physicalSeat];
      useGameStore.getState().publish({ quips: next });
    }, 4500);
  }

  /**
   * After winning without a showdown, a bot sometimes flips over a weak hand
   * to show the bluff — how often depends on personality. This is what makes
   * bluffing visible (and painful) enough to learn from.
   */
  private maybeRevealBluff(): boolean {
    const st = this.state;
    if (!st || this.reveals.size > 0 || this.mainPotWinners.length !== 1) return false;
    const seat = this.mainPotWinners[0];
    const player = st.config.seats[seat];
    if (!player?.personalityId) return false; // the hero shows his own bluffs
    const ps = st.players[seat];
    const reveal = bluffRevealCheck(
      PERSONALITIES[player.personalityId],
      ps.holeCards,
      st.board,
      this.botRng,
    );
    if (!reveal) return false;
    const desc = reveal.description;
    this.reveals.set(seat, reveal.semiBluff ? `${desc} with a draw — a semi-bluff` : `${desc} — a stone-cold bluff`);
    useGameStore
      .getState()
      .appendLog([reveal.semiBluff
        ? `${player.name} shows the semi-bluff: ${formatCards(ps.holeCards)} — ${desc} with a live draw!`
        : `${player.name} shows the bluff: ${formatCards(ps.holeCards)} — just ${desc}!`]);
    this.emitQuip(seat, 'showBluff');
    return true;
  }

  private consumeEvents(events: HandEvent[]): void {
    const name = (seat: number) => this.state!.players[seat].name;
    // "You call" vs "Selena calls"
    const verb = (seat: number, v: string) => (this.state!.players[seat].isHero ? v : `${v}s`);
    const lines: string[] = [];
    for (const e of events) {
      switch (e.type) {
        case 'handStarted':
          lines.push(`— Hand #${this.handNumber} —`);
          break;
        case 'holeCardsDealt':
          break;
        case 'blindPosted':
          this.lastActions.set(e.seatIndex, {
            type: e.kind === 'small' ? 'small blind' : 'big blind',
            amount: e.amount,
          });
          lines.push(`${name(e.seatIndex)} posts the ${e.kind} blind (${e.amount})`);
          break;
        case 'antePosted':
          lines.push(`${name(e.seatIndex)} posts the big blind ante (${e.amount})`);
          break;
        case 'actionTaken': {
          const allIn = e.allIn ? ' — all-in!' : '';
          const isBet = e.action === 'raise' && !this.streetHasBet;
          if (e.action === 'fold') sounds.fold();
          else if (e.action === 'check') sounds.check();
          else if (e.allIn) sounds.allIn();
          else sounds.chips();
          if (e.allIn && e.action === 'raise') this.maybeQuip(e.seatIndex, 'allIn', 0.5);
          else if (e.action === 'raise') this.maybeQuip(e.seatIndex, 'raise', 0.12);
          else if (e.action === 'fold') this.maybeQuip(e.seatIndex, 'fold', 0.08);
          if (e.action === 'fold') lines.push(`${name(e.seatIndex)} ${verb(e.seatIndex, 'fold')}`);
          else if (e.action === 'check') lines.push(`${name(e.seatIndex)} ${verb(e.seatIndex, 'check')}`);
          else if (e.action === 'call')
            lines.push(`${name(e.seatIndex)} ${verb(e.seatIndex, 'call')} ${e.amount}${allIn}`);
          else if (isBet)
            lines.push(`${name(e.seatIndex)} ${verb(e.seatIndex, 'bet')} ${e.toStreetBet}${allIn}`);
          else lines.push(`${name(e.seatIndex)} ${verb(e.seatIndex, 'raise')} to ${e.toStreetBet}${allIn}`);
          if (e.action === 'raise') this.streetHasBet = true;
          this.lastActions.set(e.seatIndex, {
            type: isBet ? 'bet' : e.action,
            amount: e.action === 'raise' ? e.toStreetBet : e.amount,
          });
          break;
        }
        case 'streetDealt':
          sounds.deal();
          this.lastActions.clear();
          this.streetHasBet = false;
          lines.push(`${e.street[0].toUpperCase() + e.street.slice(1)}: ${formatCards(e.board)}`);
          break;
        case 'showdown':
          for (const r of e.reveals) {
            this.reveals.set(r.seatIndex, r.description);
            lines.push(`${name(r.seatIndex)} shows ${formatCards(r.cards)} — ${r.description}`);
          }
          break;
        case 'uncalledBetReturned':
          lines.push(`Uncalled bet (${e.amount}) returned to ${name(e.seatIndex)}`);
          break;
        case 'potAwarded': {
          if (e.potIndex === 0) this.mainPotWinners = e.winners.map((w) => w.seatIndex);
          for (const w of e.winners) {
            this.winners.set(w.seatIndex, (this.winners.get(w.seatIndex) ?? 0) + w.amount);
            const withHand = w.description ? ` with ${w.description}` : '';
            lines.push(`${name(w.seatIndex)} wins ${w.amount}${withHand}`);
            if (!this.banner) this.banner = `${name(w.seatIndex)} wins ${w.amount}${withHand}`;
            if (this.state!.players[w.seatIndex].isHero) sounds.win();
            else this.maybeQuip(w.seatIndex, e.amount >= 400 ? 'bigWin' : 'win', e.amount >= 400 ? 0.7 : 0.3);
          }
          break;
        }
        case 'handComplete':
          break;
      }
    }
    if (lines.length > 0) useGameStore.getState().appendLog(lines);
  }

  private publishSnapshot(overrides?: Partial<GameViewState>): void {
    const st = this.state;
    const tournament = this.tournament;
    if (!st || !tournament) return;
    const seats: SeatView[] = tournament.players.map((player) => {
      const p = st.players.find((candidate) => candidate.id === player.id);
      const personality = player.personalityId ? PERSONALITIES[player.personalityId] : null;
      const revealed = p ? this.reveals.has(p.seatIndex) : false;
      return {
        seatIndex: player.seatIndex,
        id: player.id,
        name: player.name,
        isHero: player.isHero,
        avatar: player.isHero ? '🧑' : personality!.avatar,
        personalityTagline: personality?.tagline ?? null,
        stack: p?.stack ?? player.stack,
        position: p ? positionOfSeat(st, p.seatIndex) : null,
        streetBet: p?.streetBet ?? 0,
        committed: p ? p.totalCommitted + (p.seatIndex === st.bigBlindIndex ? st.antePot : 0) : 0,
        folded: p?.folded ?? false,
        allIn: st.phase !== 'complete' && (p?.allIn ?? false),
        holeCards: p && (p.isHero || revealed) ? p.holeCards : null,
        hasCards: !!p && !p.folded && (st.phase !== 'complete' || revealed || p.isHero),
        isButton: tournament.buttonSeat === player.seatIndex,
        isActing: !!p && st.actionOn === p.seatIndex,
        lastAction: p ? this.lastActions.get(p.seatIndex) ?? null : null,
        showdownDescription: p ? this.reveals.get(p.seatIndex) ?? null : null,
        wonAmount: p ? this.winners.get(p.seatIndex) ?? null : null,
        eliminated: player.place !== null && player.stack === 0,
      };
    });
    const sb = st.smallBlindIndex === null ? null : st.players[st.smallBlindIndex];
    const bb = st.players[st.bigBlindIndex];
    const forcedBets: GameViewState['forcedBets'] = [
      ...(sb ? [{ playerId: sb.id, kind: 'small blind' as const, amount: Math.min(st.config.smallBlind, sb.startingStack) }] : []),
      { playerId: bb.id, kind: 'big blind', amount: Math.min(st.config.bigBlind, bb.startingStack) },
      ...(st.antePot > 0 ? [{ playerId: bb.id, kind: 'big blind ante' as const, amount: st.antePot }] : []),
    ];
    const handActions = st.actionHistory.map((a) => ({
      playerId: st.players[a.seatIndex].id, type: a.type, street: a.street, amountAdded: a.amountAdded,
      toStreetBet: a.toStreetBet, potBefore: a.potBefore, toCallBefore: a.toCallBefore, stackBefore: a.stackBefore,
    }));
    const complete = tournament.players.filter((p) => p.stack > 0).length === 1 && tournament.pendingHandId === null;
    useGameStore.getState().publish({
      tournament,
      latestDecisionGrade: this.latestDecisionGrade,
      handId: st.handId,
      handNumber: this.handNumber,
      phase: st.phase,
      seats,
      board: [...st.board],
      pot: totalPot(st),
      currentBet: st.currentBet,
      forcedBets,
      handActions,
      bigBlind: st.config.bigBlind,
      status: complete ? 'tournamentComplete' : st.phase === 'complete' ? 'handComplete' : 'playing',
      banner: st.phase === 'complete' ? this.banner : null,
      ...overrides,
    });
  }

  private delay(ms: number): Promise<void> {
    const factor = SPEED_FACTOR[useSettingsStore.getState().speed];
    return new Promise((res) => setTimeout(res, ms * factor));
  }
}

export const tableController = new TableController();
