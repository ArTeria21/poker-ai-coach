# Poker AI-Coach

A browser-based, six-player No-Limit Hold'em single-table tournament against five bots. The current implementation includes tournament rules, public opponent-range modeling, poker math and exact ICM tools, Monte Carlo decisions on hard difficulty, a per-decision grader, and a chat with coach Dan (`POST /api/chat`: OpenRouter model, math tools, public table snapshot) in two modes: Free Play and Training, with Push-to-Talk voice input (see [Voice input](#voice-input), [Training Mode](#training-mode) and [PROJECT.md](PROJECT.md)).

The table opens automatically. Play your actions, then choose **Deal next hand** when ready. If you are eliminated, you can continue watching the remaining players. **New SNG** starts a fresh tournament. The tournament stays in memory; refreshing the page starts again.

## Run locally

Requires Node.js 22.9 or newer.

```sh
npm install
npm run dev            # API on :8787 (tsx watch) + Vite web app; Vite proxies /api
```

```sh
npm test
npm run build
npm start              # production: one server for the built dist/ and /api on PORT (default 8787)
```

The coach chat needs an OpenRouter key; the game itself runs without any credentials (`/api/chat` then answers 503). Answer time depends on `OPENROUTER_MODEL`: reasoning models may take ~15–60 s per answer (Dan shows progress meanwhile).

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter API key, server side only |
| `OPENROUTER_MODEL` | OpenRouter model id, e.g. a tool-calling chat model; no default |
| `DEEPGRAM_API_KEY` | Deepgram API key for voice input, server side only; without it `/api/stt` answers 503 and the chat stays text-only |
| `PORT` | Server port, default 8787 |
| `HOST` | Listen address, default `127.0.0.1` (the Docker image sets `0.0.0.0`) |
| `MEMORY_DIR` | Folder for Dan's long-term memory files, default `./memory` (gitignored; the Docker image uses the volume `/app/memory`) |

`npm run dev:api` and `npm start` load `.env` if it exists (Node's `--env-file-if-exists`). Docker: `docker build -t poker-coach . && docker run -p 127.0.0.1:8080:80 -e OPENROUTER_API_KEY=... -e OPENROUTER_MODEL=... -e DEEPGRAM_API_KEY=... poker-coach`; add `-v poker-coach-memory:/app/memory` to keep Dan's memory across containers.

## Tournament format

- Six players start with **2,000 chips** each: **12,000 total chips**, with no rebuys or add-ons.
- Levels last **six completed hands**, so time spent thinking does not advance the blinds. The new level takes effect when the next hand is dealt. The final level remains in effect until there is a winner.
- The big blind pays the **live blind first**, then as much of the big blind ante as its remaining stack allows. BBA continues at its full listed amount heads-up.
- Ante chips are dead money in the main pot. They do not count toward a call, raise, side-pot limit, or an uncalled-bet refund. A short stack can win the whole ante: at 4/8 with an ante of 8, a player all-in for 1 can win 11 from the main pot.
- Eliminated players keep their physical seat. The dead button can occupy an empty seat; dealing order, postflop action, and odd-chip awards follow the actual button. When heads-up begins, the button is the small blind and the previous surviving big blind does not pay BB again immediately.
- Prize pool shares are **65% for first** and **35% for second**. These are percentages, with no cash buy-in. Tournament hands carry these shares, so hard bots facing a preflop raise or a postflop bet, and the grader, judge terminal calls contested by two players with exact ICM prize EV while three or more players remain; their other decisions are chip-EV or heuristic and do not claim to optimize prize equity.
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

Desktop and tablet-landscape browsers only (the layout keeps a 1024 px minimum width; there is no phone layout). The left three fifths are the play column: a one-line tournament summary (players left, level, blinds and ante, hands at the level, prize shares) that expands into the full panel with standings and the blind schedule, the hand log, the table, and the action controls. The right two fifths are the chat with coach Dan.

The chat header switches between **Free** (Free Play, the default) and **Training**; the choice is remembered. In Free Play the LLM is called only when you send a message (or click one of the example questions); silent play never calls it. Each send or retry attaches the current public table snapshot and only the messages not yet folded into the session summary (see Dialog compaction). Dan's answer streams in as plain text; his math tool calls appear as compact chips (equity, pot odds, outs, ICM, combos) with their key result. "Dan is thinking…" shows whenever he is working without streaming text (before the first text and between tool steps), Stop cancels an answer, and an error line with Retry shows the server's message (for example when the coach is not configured). Chat history lives in memory only: a page refresh clears it, New SNG does not. All six physical seats remain visible after elimination, including a dead dealer button. Folded bot cards stay hidden unless the bot voluntarily shows its winning hand; showdown cards are revealed by the engine.

Each SNG seats five bots with random neutral names and independently drawn hidden playing styles (one of five archetypes, with small parameter jitter); styles are never shown to the student or Dan, and there are no bot profiles, stats or table talk. Difficulty is easy/medium/hard. All difficulties use a positional push/fold heuristic at effective depths up to 10 BB. Hard decisions facing a raised preflop price or a postflop bet use 1,000 Monte Carlo samples against public modeled ranges, with shared side-pot accounting. Continuation bets, semi-bluffs and style tendencies remain heuristic. Bots use no LLM. The old curriculum, live template coach, stats, replay UI, post-hand review, summary modal, and automatic cash-table rebuy are removed.

Every accepted human action also produces a compact `latestDecisionGrade` in the game store. It is preserved during bot responses and cleared on the next hand or session reset. This groundwork is available to the future trainer; the table does not restore a review or coaching panel.

## Voice input

The **Voice** button next to Send is Push-to-Talk: hold it and release to stop (a press of 300 ms or more), or click once to start and click again to stop; Escape cancels and discards the recording, and recording stops by itself after 2 minutes. While recording it shows a red dot and the elapsed time. The browser records with `MediaRecorder` (Opus in WebM where supported, otherwise the browser's default, e.g. MP4 in Safari) and needs microphone access, so the page must be served over HTTPS or from localhost; otherwise the button is disabled.

The recording goes to `POST /api/stt` (raw audio body, `audio/*` content type, 4 MB limit), which forwards it to Deepgram's pre-recorded API (`nova-3`, Russian, `smart_format`, one `keyterm` per term of a Russian poker vocabulary in `server/voice.ts`). Being pre-recorded, pauses for mental arithmetic never cut the message. The transcript gets a small deterministic normalisation (`три бет` → `3-бет`, `пот оддс` → `пот-оддс`, `олл ин` → `олл-ин`, `кат офф` → `кат-офф`, `о е с д` → `OESD`, `40 процентов` → `40%`, `9 больших блайндов`/`9 бб` → `9 BB`) and is inserted at the caret in the message field. It is never sent automatically: edit it and press Send. Errors (microphone denied or missing, recording failed, voice not configured, recognition failed, nothing recognised) show as one line under the input until the next recording or typing.

## Training Mode

Dan leads the hands and the table waits for him at the moments worth discussing. Each lock belongs to one gate: a hero decision (`<handId>#<number of public actions so far>`) or the review of a finished hand (`<handId>#review`).

- **Hero's turn.** The action buttons lock and the app sends Dan an automatic turn (shown in the chat as a compact event line, e.g. "Your turn · flop — discussing with Dan"). A deterministic preflop filter (`obviousPreflopSpot` in `src/agent/training.ts`) skips obvious junk folds when the hand is not yet substantive: no lock, no request, Fold is available at once.
- **Release.** Dan unlocks with the `release_actions` tool once the discussion is done; the chat shows "Actions unlocked" / "Review done". After a release every legal action is available, not just the one agreed on; Dan sees the real action next time.
- **Review.** When a substantive hand ends (a gate opened, you put chips in voluntarily, or you chatted during the hand) and you were dealt in, **Deal next hand** locks until Dan's review releases it.
- **Stale answers.** The server builds `release_actions` per request with that request's gate; the client unlocks only if the released id equals the gate locked now, so a late answer can never unlock a different decision.
- **Busy chat.** A trigger that fires while Dan is still answering waits and is sent once he finishes, only if its gate is still locked.
- **Recovery.** If a request fails, or you press Stop, while its gate is still locked, the chat shows Retry and **Continue without Dan**, which releases exactly that request's gate. Otherwise the lock holds until Dan releases it: answer him in the chat, or switch to Free Play. Switching to Free Play always unlocks; switching to Training mid-decision starts at the next trigger.

The state machine (`step` in `src/agent/training.ts`) is pure; `src/ui/coachSession.ts` holds the shared `Chat` instance and feeds it table and chat events.

## Long-term memory

Dan remembers the player across sessions in three Markdown files in `MEMORY_DIR` on the server (single local user; the client never touches them). Writes are atomic (temp file + rename) and serialized per file. Dan changes them only through tools, available in both modes; hand ids always come from the request's table snapshot, never from the model.

- `working-state.md` (`write_working_state`, overwrite): at most 80 lines and exactly the sections `## Current Workbench`, `## Conventions`, `## Student Profile`. A dry current state, never a log.
- `knowledge-map.md` (`update_knowledge_map`, operations only, all or none): the fixed topic catalog with status 0–3 (`set_topic`) and up to 8 active bottlenecks (`add`, `overcome`, `relapse`, `remove`). `overcome` records the current hand; the same hand counts once, the hand where the mistake was added or relapsed never counts, the third distinct hand removes the bottleneck, `relapse` resets the counter. The file is re-rendered from a strict line grammar (`server/memory.ts`); only topics dropped from the catalog are skipped, any other line outside the grammar (a hand edit) blocks updates with a server error rather than being lost.
- `highlights.md` (`append_highlight`, append-only): instructive hands, at most one entry per hand, with date, hand id, independence 1–3, spot and takeaway; `read_highlights` returns the latest ten.

The working state and the knowledge map are injected into every chat request (or an explicit "memory is empty" line); highlights are read only on request. `GET /api/memory/status` answers `{ initialized }`, true once `working-state.md` exists.

## Dialog compaction

A long session stays coherent without resending the whole chat. The client holds the history, so it drives folding and the server stays stateless (`src/ui/coachSession.ts`, `server/compaction.ts`; constants in `src/agent/contract.ts`):

- When a turn settles (chat ready after any waiting trigger was sent) and more than 30 messages are unfolded, the client folds all but the last 20 into a summary via `POST /api/compact { summary, messages }` → `{ summary }`. The kept tail always starts with a user-role message (a player message or a training trigger). One fold at a time; a failure keeps the old state and retries at the next settle, and never blocks the chat.
- Chat requests send only the unfolded messages plus `summary`; the server injects it into Dan's instructions as a fenced "Сводка ранней части этой сессии" and caps unfolded messages at 40 as a safety net. The chat panel still shows every message.
- The summary (at most 6000 chars) is written by the same model at low reasoning effort from a labelled transcript ([ИГРОК], [ДЭН], [СОБЫТИЕ] for training triggers, [ТУЛ] with truncated tool results). It merges the previous summary into three sections: the player's understanding and its evolution, the session's course and agreements, and the current moment. A cut-off or oversized summary is rejected (502).
- A page reload starts a new chat without a summary; continuity across sessions comes from the memory files.

## Level diagnosis

A chat phase that measures the player before anything is taught: a Russian port of the learnharness prober, adapted to tournament poker.

### In the app

- Start: the **Diagnose level** button in the chat header (whenever Dan is idle), or, on first launch (`GET /api/memory/status` says `initialized: false` and the chat is empty), **Пройти диагностику** in Dan's greeting; the example questions stay available. Starting sends a `[Диагностика]` message (shown as an event line) and every request until the end carries `phase: "diagnosis"`. The phase is not persisted: a reload ends it.
- Training pauses while it runs: the state machine switches to Free Play internally (any lock is released, no triggers), and the mode toggle is disabled. When `diagnosis_done` succeeds or the player clicks **Stop diagnosis**, the saved mode resumes, with the decision or finished hand on screen counted as handled (no lock appears under the player).
- Question cards render inside Dan's message where the call is. `probe`: question, the spot, options in a stable per-call shuffle lettered A, B, C… (checkbox marks for multi-select), an automatic **Не знаю**, a confidence slider with the stops 0/30/50/70/90/100 (default 50; disabled and not sent on Не знаю), an optional thinking field, Submit. The card grades on the client; only then does it show the verdict, the correct option(s) and the explanation. `ask_user_question`: options in the given order plus **Другое** with free text (or a text answer when there are no options) and optional thinking. `src/ui/questions.ts` holds the pure logic (port of learnharness `question-core.ts`).
- A card is answerable only while its call is the first unanswered question of Dan's latest message, the diagnosis runs and Dan is idle; two questions in one step are answered one after another. If the player types a message instead, the open questions get a `{ dismissed: true }` output first (Dan sees which were skipped). An older or abandoned card (stopped diagnosis, folded history) shows as skipped and never sends. A call rejected by the tool's schema renders nothing (its error text holds the whole input, answer included); Dan retries it.
- Submit writes the compact record into that part of the latest message and, once no question of the message is left, continues Dan's message (`chat.sendMessage()` without a message). Nothing else continues by itself: not ordinary answers, math tools or Training releases. The output is not written with `addToolOutput`, which targets the first message holding the call id, because providers reuse call ids across responses. Retry after an error continues a message that holds question cards instead of regenerating it, so answered cards survive.
- `diagnosis_done` shows the assessment card (strands with topic titles, summary), ends the phase and marks memory as initialized.

### Server

A `/api/chat` request with `phase: "diagnosis"` (no gate allowed: 400) gets Dan's diagnosis prompt instead of the Free Play/Training section and the memory rules, still with the injected memory, so strands already known solid are skipped and a re-diagnosis builds on it. Its tools are the math tools plus:

- `ask_user_question` (ungraded: question, details, options with "Other", multiSelect) and `probe` (graded multiple choice: question, a mini-spot `context`, options `{ label, value }`, multiSelect, `explanation` committed before `correctAnswer`). Both are client-side: no `execute`, the stream ends at the call, and the client returns the player's answer as the tool output — the compact record (`dontKnow`, `optionOrder`, `answers {index, label, letter}`, `correct`, `confidence` in 0/30/50/70/90/100, `thinking`; `other`/`text` for ask; or `{ dismissed: true }` when the player wrote instead of answering; player text is not length-capped, the body limit bounds it). Option values must be distinct and `correctAnswer` must name an option (several only with multiSelect), otherwise the call returns to the model as a tool error. The answer records are validated in every request's history by the tools' output schemas.
- `diagnosis_done` (server): the assessment (strands = knowledge-map topic ids with floor/ceiling/misconceptions/untested, plus a summary), topic statuses for strands with evidence, observed bottlenecks and the full initial working state (its Student Profile keeps one floor → ceiling line per key strand, so the assessment survives folding and restarts; Conventions carry over unchanged). It validates the working state, applies the map ops (all or none; a bottleneck's `seen` is the snapshot hand) and writes `working-state.md`, then returns a fixed acknowledgement. It is refused while a question call is in the same step, and once a successful `diagnosis_done` follows the latest `[Диагностика]` start message in the request (or in this request).

The prompt: measure first (philosophy), clarify the goal and experience first with `ask_user_question`, binary search for floor and ceiling per strand starting near the high end of the self-report, one question at a time, concrete mini-spots over trivia, chosen so the answer follows from the mental model rather than exact counting (needed numbers are given as spot conditions; options are decisions, not EV figures; tools only when the key depends on an uncertain number), distractors that are believable errors of specific wrong models, the reasoning as primary evidence, confidence read against chance, "Не знаю" as a gap, no teaching and no praise during the diagnosis.

## Architecture and checks

- `src/engine/`: deterministic NLHE hands, legal actions, separate BBA accounting, side pots, evaluation, and pure replay. A hand is reproducible from its configuration, seed, and actions.
- `src/game/tournament.ts`: pure tournament lifecycle, physical markers, blind levels, eliminations, and prize shares.
- `src/game/tableController.ts`: paced play, human/bot turns, cancellation, and public snapshots.
- `src/store/` and `src/ui/`: Zustand snapshots and React UI; `ui/CoachChat.tsx` is the chat (`@ai-sdk/react` `useChat` over one module-level `Chat` in `ui/coachSession.ts`, which also wires Training Mode); `ui/voiceInput.ts` is the Push-to-Talk recorder. Private deck and hidden bot cards do not enter the UI store.
- `src/bots/`: sanitized decision views, a shared public opponent-range model and deterministic policies. Views contain the acting player's cards and copied public players/history; they exclude the deal seed, deck and hidden opponent cards.
- `src/equity/`: range expansion, weighted joint Monte Carlo sampling, integer side-pot/odd-chip awards, a worker client with explicit errors, and the shared capped-call decision projection.
- `src/math/`: structural draw completions, pot odds, effective cover, SPR, explicit terminal EV models, exact 1–6-player ICM, settled-outcome prize EV and matched-risk bubble factors.
- `src/analysis/gradeHand.ts`: one deterministic pre-action grading path for live decisions and seed/action replay, with factual, sizing-model and chip-EV-model evidence. The obsolete template advice implementation has been removed.

Tests cover evaluator cross-checks, betting rules, chip conservation, ante and side-pot fixtures, replay, dead-button/HU positions, tournament payouts, completed SNGs, exact range/joint sampling oracles, known blockers, worker failures, ICM invariants, public-information isolation, hard bot behavior, grading uncertainty, live/replay equivalence and controller cancellation/restarts.

- `src/agent/`: the coach contract. `coachSnapshot(view)` maps the sanitized store view to `CoachSnapshot` (public table state only); `coachSnapshotSchema` validates it on the server.
- `server/`: Hono on Node via `tsx`. `app.ts` serves `POST /api/chat`: body-size limit, UI-message and snapshot validation, the session summary plus the unfolded messages (capped), and a Vercel AI SDK `streamText` call to OpenRouter with a multi-step tool loop, streamed back as a UI message stream. `dan.ts` is coach Dan's system prompt (the latest snapshot is appended as JSON). `tools.ts` exposes deterministic math tools over `src/math` and `src/equity`: `equity`, `range_combos`, `pot_odds`, `shove_ev` (chip EV of a bet/raise/shove with fold equity versus folding, heads-up and terminal), `outs`, `icm` (prize shares, a bubble factor, or with `outcomes` the ICM EV of a decision over settled outcome stacks versus the fold baseline); invalid input returns `{ error }` to the model. `release_actions` exists only in a Training request that carries a locked gate (the server checks the gate against the snapshot). `memory.ts` holds the memory files and their rules; the memory tools are built per request in `tools.ts`. `compaction.ts` serializes a chat span and holds the summary prompt for `POST /api/compact`. `voice.ts` is the Deepgram proxy behind `POST /api/stt` with the poker vocabulary and transcript normalisation. `index.ts` serves the app and the built `dist/`.

The stack is TypeScript, React, Vite, Zustand, `phe`, Vitest, fast-check, Hono, the Vercel AI SDK and OpenRouter. Only the coach chat and voice input need credentials.

## Math and grading APIs

- `parseRange('TT+, AQs+, AKo', blockers)` expands unique concrete hands. Pair intervals (`22-66`), same-high-rank intervals (`A2s-A5s`), unsuffixed hands (`AK`) and exact combos (`AsKh`) are supported.
- `monteCarloEquity` accepts uniform unknown opponents, known hands, and string or weighted concrete opponent ranges (`{ cards: ['As', 'Kh'], weight: 2 }`). Weighted duplicate unordered hands are rejected; zero weights are ignored, and each range must retain positive unblocked support. Independent weighted joint draws are rejected as a whole on card collisions; sampling exhaustion is an explicit error, never an ATC substitution. With `pots` and a clockwise `oddChipOrder`, the same samples return expected chip awards and sampling standard error, with integer payouts and odd-chip splitting applied per sample. Participant order is hero, uniform unknowns, ranged opponents, then known hands.
- `decisionEquity(view, { iterations, seed })` projects the capped call, constructs main/side pots and uncalled refunds, and returns conditional call chip EV; with tournament payouts, a terminal call contested by two players with three or more left also returns exact-ICM prize EV of the settled win/tie/loss stacks versus folding. A terminal flag requires betting to be closed after that call; a hero all-in with two still-live opponents does not guarantee closure. Otherwise the model explicitly assumes a checkdown. Public range likelihoods use position, observed action and size, mixed over the possible archetypes (the bot's actual style is not an input) and calibrated to medium bots, so hard and easy bots are mis-modeled; historical actions use only that street's board prefix. Folded-card likelihoods and future betting responses are not modeled.
- `drawCompletionOuts` separates personal straight/flush completion cards, their unique union, category improvements and current next-card leaders against supplied known hands. Its next-card hit probability assumes uniformly unseen cards. These structural completions are neither range-conditioned clean winning outs nor full-runout equity.
- `potOdds`, `effectiveStack`, `spr`, `terminalCallEV` and `headsUpRaiseEV` have explicit chip/exposure semantics. Chips and their totals must be safe integers; probabilities and payouts may be fractional. Zero-pot SPR is explicitly undefined. The raise EV helper requires caller-supplied fold probability and conditional called pot share, excludes uncalled excess, and assumes no future bets or side pots.
- `icmEquities` computes exact independent-chip prize shares. A single zero stack receives the next remaining bottom-place payout. Multiple zero stacks require explicit best-to-worst `eliminationGroups`; tied groups split their occupied payouts. `icmOutcomeEV` weights separately supplied settled outcomes, including ties, while conserving chips exactly. Fractional showdown equity is not treated as a win probability. `bubbleFactor` evaluates matched symmetric chip transfers without a dead pot; equal prizes produce an undefined factor, and numerically unresolved ratios report `precision-limit`.
- `gradeDecision(view, action)` calculates its own shared call model with a deterministic public-identity seed and 1,000 iterations. `gradeHand` and `gradeHandFromSteps` use that same function before every hero action. A 95% bounded-award Hoeffding band covers sampling uncertainty only; it does not quantify range-model error. Terminal conclusions use that ICM prize EV (with its own Hoeffding band) when it exists, otherwise chip EV (with two players left, chip EV sign is the prize EV sign; heads-up blunder severity stays in chips); multiway terminal tournament pots with three or more players left are `uncertain`, and nothing claims GTO. A fold despite a positive modeled call remains uncertain: the grader does not assert fold errors from heuristic opponent ranges. Price facts use net call cost divided by eligible pot awards, excluding inaccessible side pots and refunds; this required award share must not be compared directly with whole-field showdown equity. Nonterminal equity does not establish action EV, raise sizes use only matched exposure, and plausible continuation bets/semi-bluffs remain model judgments. Near-zero bands, unresolved betting, exhausted sampling, and nonterminal preflop calls, raises and folds facing a bet at 25BB effective or less or in hands dealt heads-up (6-max starting-hand priors do not apply there), produce an explicit `uncertain` verdict.

## License and origin

[MIT](LICENSE). Based on [Easternguy/poker-mentor](https://github.com/Easternguy/poker-mentor), with the direction and implementation changes described in [PROJECT.md](PROJECT.md).
