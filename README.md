# Poker AI-Coach

A browser-based, six-player No-Limit Hold'em single-table tournament against five bots. The current implementation covers tournament rules, chip accounting, the table, and standings. AI coaching, ICM calculations, and range-based analysis are later stages described in [PROJECT.md](PROJECT.md).

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
- Prize pool shares are **65% for first** and **35% for second**. These are percentages, with no cash buy-in or ICM calculation.
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

The five bots retain their existing personalities and easy/medium/hard settings. Their current policy uses starting-hand tiers, hand/draw strength, and configured tendencies. It does not use an LLM or a Monte Carlo decision policy on hard difficulty. The old curriculum, live template coach, stats, replay UI, post-hand review, summary modal, and automatic cash-table rebuy are removed.

## Architecture and checks

- `src/engine/`: deterministic NLHE hands, legal actions, separate BBA accounting, side pots, evaluation, and pure replay. A hand is reproducible from its configuration, seed, and actions.
- `src/game/tournament.ts`: pure tournament lifecycle, physical markers, blind levels, eliminations, and prize shares.
- `src/game/tableController.ts`: paced play, human/bot turns, cancellation, and public snapshots.
- `src/store/` and `src/ui/`: Zustand snapshots and React UI. Private deck and hidden bot cards do not enter the UI store.
- `src/bots/`: existing deterministic bot policies. `src/coach/`, `src/analysis/gradeHand.ts`, and `src/equity/` retain pure groundwork for later stages; they are not presented as a live coach.

Tests cover evaluator cross-checks, betting rules, chip conservation during hands, ante and side-pot fixtures, replay, dead-button/HU positions, blind-level boundaries, simultaneous elimination payouts, controller cancellation/restarts, spectator play, and completed tournaments.

The stack is TypeScript, React, Vite, Zustand, `phe`, Vitest, and fast-check. No backend or credentials are needed for the current SNG.

## License and origin

[MIT](LICENSE). Based on [Easternguy/poker-mentor](https://github.com/Easternguy/poker-mentor), with the direction and implementation changes described in [PROJECT.md](PROJECT.md).
