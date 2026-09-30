# Query remake: picture the answer, then search (step A)

Date: 2026-10-01. Branch: builds on `name-first` (8b31e0f). Step A of the pipeline redesign (A query remake, B Jev picks
scene and transcript candidates, C planner streams candidates to the judges, D final check before display).

## Why

Traces from 39 recent searches (2026-09-19 to 09-30): search providers return plenty (most searches cut candidates at 60),
and no strong match was ever hidden by the filters. The 7 failures were all specific videos or moments, and the wording
of our searches decided whether the right video was retrieved at all: "MrBeast surprises fan with a PS5" was retrieved
only by the search that said "fan"; the three that said "subscriber" never saw it.

Benchmark (scripts/query-remake-bench.ts, 11 everyday requests, 3 runs, Brave video index only): asking a model to first
picture the video that answers the request (titles as its uploader would write them, channel kind, spoken phrases, the
creators' wording for each idea) and search from that picture retrieved 70% of known-good videos, against 41% for the
request as typed. gpt-6-luna 69.9%, gemini-3.8-flash 69.7%, gemma-4-31b-it 70.5%. Luna knew more (Free Solo: 8-9 of 10
against Gemma's 5-7) and was fastest (4.6 s) at $0.0002 a call. No model fixed the MrBeast wording from memory.

## Design

### 1. Before searching: the planner pictures the answer (no extra call)

- `gpt-6-luna` becomes the lead planner. The current planners stay as assists in parallel:
  `PLANNER_MODELS=openai/gpt-6-luna,google/gemma-4-31b-it,mistralai/ministral-14b-2512,inception/mercury-2.5`.
  The requirements-contract draft comes from the lead planner as now. If Luna fails, the first assist that answered
  leads, as now.
- The planner prompt (both quick and deep) gains the picture step before its searches:
  - `target.titles`: 2-3 titles as the uploader would write them;
  - `target.channel`: the kind of channel, and its name when sure;
  - `target.spoken`: 2-3 phrases said or shown;
  - `target.wording`: request word → creators' words.
  Searches are written from the picture: likely title wording first, then names, then other wordings. The rules
  already in place still apply: keep the request's meaning, never add or drop a detail, no invented names.
- `SearchPlan` gains `target` (optional). It is stored in the trace (backend only; searchers never see it) and passed on
  to the second pass.
- The request as typed still runs first and in parallel, so planning never delays the first results.

### 2. After the first round: remake from the real titles (only when weak)

- Trigger unchanged: the link-expansion round, when screening leaves fewer than `LINK_STRONG_MIN` strong candidates.
- The rewriter (planner models, so Luna leads) gets the request, the requirements, `target`, and the top 10 screened
  titles with channels. It is told to reuse the wording the real titles use for this subject, to name the item when
  the titles make it clear, and to add no detail the request does not ask for. Plain text only.
- Any name it returns must pass the name-first grounding check (every word appears in one supplied title, at most 6
  words, no `|` or ` - `). A grounded name goes to the judge as "Likely refers to", as on `name-first`.
- The name-first identify call that ran on every search is removed (`src/identify.ts` keeps `grounded` and the name
  checks). Strong searches make no extra call; weak ones make the one expansion call they already made.

### 3. Unchanged

The screener, Jev, judges, scene analysis, gap exploration and the query fixes and linked-from counting from
`name-first` stay as they are. `KNOWN_ITEM_CANDIDATES` stays off.

## Error handling

- A planner reply without `target`, or with a malformed one, is still used for its searches (target is optional). A
  failed planner falls back as now.
- A rewriter failure means no expansion searches, as now. Ungrounded names are dropped silently and counted in the log.

## Testing

- Unit: the planner schema accepts and stores `target`; the searches still pass `uniqueSearches`; the rewriter input
  carries `target` and titles; ungrounded or title-like names from the rewriter are dropped; no identify call is made.
- Bench 1 (Brave only, cents): rerun scripts/query-remake-bench.ts through the real planner prompt with Luna leading.
  Pass: at least the 70% seen in the prompt benchmark.
- Bench 2 (Brave only, cents): the second pass on MrBeast and the slime anime with real first-round titles. Pass: the
  "MrBeast surprises fan with a PS5" video is retrieved.
- Live check before going live: 2-3 full quick searches on `main` and on the branch, captions off (the IP-block
  lesson of 2026-09-30), comparing results shown, time and cost. Merge only if the branch is not worse.
