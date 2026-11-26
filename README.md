# Poker AI-Coach

A browser-based, six-player No-Limit Hold'em single-table tournament against five bots. The current implementation includes tournament rules, public opponent-range modeling, poker math and exact ICM tools, Monte Carlo decisions on hard difficulty, and a per-decision grader. The conversational AI coach and training workflow are future stages described in [PROJECT.md](PROJECT.md).

The table opens automatically. Play your actions, then choose **Deal next hand** when ready. If you are eliminated, you can continue watching the remaining players. **New SNG** starts a fresh tournament. The tournament stays in memory; refreshing the page starts again.

## Run locally

```sh
npm install
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

## Tournament format

- Six players start with **2,000 chips** each: **12,000 total chips**, with no rebuys or add-ons.
- Levels last **six completed hands**, so time spent thinking does not advance the blinds. The new level takes effect when the next hand is dealt. The final level remains in effect until there is a winner.
- The big blind pays the **live blind first**, then as much of the big blind ante as its remaining stack allows. BBA continues at its full listed amount heads-up.
- Ante chips are dead money in the main pot. They do not count toward a call, raise, side-pot limit, or an uncalled-bet refund. A short stack can win the whole ante: at 4/8 with an ante of 8, a player all-in for 1 can win 11 from the main pot.
- Eliminated players keep their physical seat. The dead button can occupy an empty seat; dealing order, postflop action, and odd-chip awards follow the actual button. When heads-up begins, the button is the small blind and the previous surviving big blind does not pay BB again immediately.
- Prize pool shares are **65% for first** and **35% for second**. These are percentages, with no cash buy-in. The independent ICM tools can evaluate prize equity; bot and grader chip-EV decisions do not claim to optimize prize equity.
- Simultaneous eliminations are ordered by starting stack **after the ante actually paid**, with a larger stack finishing higher. This project applies that convention to every simultaneous elimination; TDA Rule 22 explicitly discusses the after-ante treatment for in-the-money eliminations.
- Equal after-ante starting stacks tie for the same place. Their shares are the sum of the payouts for the occupied places divided by the number of tied players. A tie for second and third pays each 17.5%; a tie across second through fourth pays each 35% / 3. The interface displays fractional percentages to four decimal places.

The level lengths, blind schedule, full BBA heads-up, payouts, and application of the after-ante ranking convention to every elimination are this app's house format. Rule references: [Poker TDA rules](https://www.pokertda.com/view-poker-tda-rules/) and [Big Blind Ante rules with a short-stack example](https://www.casinosofwinnipeg.com/wp-content/uploads/2018/11/Big-Blind-Ante-Rules.pdf).

| Level | Small blind | Big blind | Big blind ante |
| --- | ---: | ---: | ---: |
| 1 | 10 | 20 | 0 |
| 2 | 15 | 30 | 0 |
| 3 | 25 | 50 | 50 |
| 4 | 50 | 100 | 100 |
| 5 | 75 | 150 | 150 |
| 6 | 100 | 200 | 200 |
| 7 | 150 | 300 | 300 |
| 8 | 200 | 400 | 400 |
| 9 | 300 | 600 | 600 |
| 10 | 500 | 1,000 | 1,000 |
| 11 | 750 | 1,500 | 1,500 |
| 12 | 1,000 | 2,000 | 2,000 |
| 13 | 2,000 | 4,000 | 4,000 |
| 14 | 4,000 | 8,000 | 8,000 |
| 15 | 8,000 | 16,000 | 16,000 |

## Current interface

The hand log sits above the table; action controls sit below it. The right panel shows the current level, ante, remaining players, prize shares, and standings. All six physical seats remain visible after elimination, including a dead dealer button. Folded bot cards stay hidden unless the bot voluntarily shows its winning hand; showdown cards are revealed by the engine.

The five bots retain their personalities and easy/medium/hard settings. All difficulties use a positional push/fold heuristic at effective depths up to 10 BB. Hard decisions facing a raised preflop price or a postflop bet use 1,000 Monte Carlo samples against public modeled ranges, with shared side-pot accounting. Continuation bets, semi-bluffs and personality tendencies remain heuristic. Bots use no LLM. The old curriculum, live template coach, stats, replay UI, post-hand review, summary modal, and automatic cash-table rebuy are removed.

Every accepted human action also produces a compact `latestDecisionGrade` in the game store. It is preserved during bot responses and cleared on the next hand or session reset. This groundwork is available to the future trainer; the table does not restore a review or coaching panel.

## Architecture and checks

- `src/engine/`: deterministic NLHE hands, legal actions, separate BBA accounting, side pots, evaluation, and pure replay. A hand is reproducible from its configuration, seed, and actions.
- `src/game/tournament.ts`: pure tournament lifecycle, physical markers, blind levels, eliminations, and prize shares.
- `src/game/tableController.ts`: paced play, human/bot turns, cancellation, and public snapshots.
- `src/store/` and `src/ui/`: Zustand snapshots and React UI. Private deck and hidden bot cards do not enter the UI store.
- `src/bots/`: sanitized decision views, a shared public opponent-range model and deterministic policies. Views contain the acting player's cards and copied public players/history; they exclude the deal seed, deck and hidden opponent cards.
- `src/equity/`: range expansion, weighted joint Monte Carlo sampling, integer side-pot/odd-chip awards, a worker client with explicit errors, and the shared capped-call decision projection.
- `src/math/`: structural draw completions, pot odds, effective cover, SPR, explicit terminal EV models, exact 1–6-player ICM, settled-outcome prize EV and matched-risk bubble factors.
- `src/analysis/gradeHand.ts`: one deterministic pre-action grading path for live decisions and seed/action replay, with factual, sizing-model and chip-EV-model evidence. The obsolete template advice implementation has been removed.

Tests cover evaluator cross-checks, betting rules, chip conservation, ante and side-pot fixtures, replay, dead-button/HU positions, tournament payouts, completed SNGs, exact range/joint sampling oracles, known blockers, worker failures, ICM invariants, public-information isolation, hard bot behavior, grading uncertainty, live/replay equivalence and controller cancellation/restarts.

The stack is TypeScript, React, Vite, Zustand, `phe`, Vitest, and fast-check. No backend or credentials are needed for the current SNG.

## Math and grading APIs

- `parseRange('TT+, AQs+, AKo', blockers)` expands unique concrete hands. Pair intervals (`22-66`), same-high-rank intervals (`A2s-A5s`), unsuffixed hands (`AK`) and exact combos (`AsKh`) are supported.
- `monteCarloEquity` accepts uniform unknown opponents, known hands, and string or weighted concrete opponent ranges (`{ cards: ['As', 'Kh'], weight: 2 }`). Weighted duplicate unordered hands are rejected; zero weights are ignored, and each range must retain positive unblocked support. Independent weighted joint draws are rejected as a whole on card collisions; sampling exhaustion is an explicit error, never an ATC substitution. With `pots` and a clockwise `oddChipOrder`, the same samples return expected chip awards and sampling standard error, with integer payouts and odd-chip splitting applied per sample. Participant order is hero, uniform unknowns, ranged opponents, then known hands.
- `decisionEquity(view, { iterations, seed })` projects the capped call, constructs main/side pots and uncalled refunds, and returns conditional call chip EV. A terminal flag requires betting to be closed after that call; a hero all-in with two still-live opponents does not guarantee closure. Otherwise the model explicitly assumes a checkdown. Public range likelihoods use position, personality, observed action and size; historical actions use only that street's board prefix. Folded-card likelihoods and future betting responses are not modeled.
- `drawCompletionOuts` separates personal straight/flush completion cards, their unique union, category improvements and current next-card leaders against supplied known hands. Its next-card hit probability assumes uniformly unseen cards. These structural completions are neither range-conditioned clean winning outs nor full-runout equity.
- `potOdds`, `effectiveStack`, `spr`, `terminalCallEV` and `headsUpRaiseEV` have explicit chip/exposure semantics. Chips and their totals must be safe integers; probabilities and payouts may be fractional. Zero-pot SPR is explicitly undefined. The raise EV helper requires caller-supplied fold probability and conditional called pot share, excludes uncalled excess, and assumes no future bets or side pots.
- `icmEquities` computes exact independent-chip prize shares. A single zero stack receives the next remaining bottom-place payout. Multiple zero stacks require explicit best-to-worst `eliminationGroups`; tied groups split their occupied payouts. `icmOutcomeEV` weights separately supplied settled outcomes, including ties, while conserving chips exactly. Fractional showdown equity is not treated as a win probability. `bubbleFactor` evaluates matched symmetric chip transfers without a dead pot; equal prizes produce an undefined factor, and numerically unresolved ratios report `precision-limit`.
- `gradeDecision(view, action)` calculates its own shared call model with a deterministic public-identity seed and 1,000 iterations. `gradeHand` and `gradeHandFromSteps` use that same function before every hero action. A 95% bounded-award Hoeffding band covers sampling uncertainty only; it does not quantify range-model error. Terminal conclusions are explicitly scoped to chip EV, not prize EV or GTO. A fold despite positive modeled call chip EV remains uncertain and does not count as a mistake without prize-EV analysis. Price facts use net call cost divided by eligible pot awards, excluding inaccessible side pots and refunds; this required award share must not be compared directly with whole-field showdown equity. Nonterminal equity does not establish action EV, raise sizes use only matched exposure, and plausible continuation bets/semi-bluffs remain model judgments. Near-zero bands, unresolved betting and exhausted sampling produce an explicit `uncertain` verdict.

The conversational trainer, action-lock training mode, long-term memory, voice input and backend remain future work. No credentials are needed for the current implementation.

## License and origin

[MIT](LICENSE). Based on [Easternguy/poker-mentor](https://github.com/Easternguy/poker-mentor), with the direction and implementation changes described in [PROJECT.md](PROJECT.md).
