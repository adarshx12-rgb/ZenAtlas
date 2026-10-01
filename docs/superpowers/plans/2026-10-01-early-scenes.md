# Early Scene Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For requests only watching can settle, start scene analysis on the screener's most promising videos right after the early caption fetch, instead of after judging.

**Architecture:** The planner adds a `watch` flag to its plan. `applySignals` picks up to `SCENE_SEARCH_LIMIT` confident-promising YouTube videos (pure function `earlyScenePicks`), requests their scene analysis in the background once captions are in, and the post-judge pick only fills the slots left. Early requests join the existing scene-review plan.

**Tech Stack:** TypeScript (Node 24, tsx), zod, node:test, embedded Postgres in tests.

**Spec:** `docs/superpowers/specs/2026-10-01-early-scenes-design.md`

## Global Constraints

- Work in a worktree on branch `early-scenes` from main 08ad03a; never commit `.env` or `output/`.
- The `watch` flag never reaches the judge, and `evidence_kind` is not changed for video requirements (the judge would hide unwatched videos).
- Judging never waits for early scene requests.
- At most `SCENE_SEARCH_LIMIT` scene requests per search in total (early plus post-judge).
- Live checks use Supadata captions (budget 150/day); keep them to 2 searches per side.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Planner reply without `watch`, or with a non-boolean: treated as false, plan unaffected (Task 1 test).
- Screener unavailable (no `screens`): no early picks, post-judge pick as today (Task 2 test).
- Early request fails or throws: judging and the post-judge pick continue (Task 3 test).
- An early pick the judge later rejects: its job still counts against the limit; no duplicate request for it (Task 3 test).
- Non-live searches (probes, `sceneLive` false) and `SCENE_EARLY=false`: unchanged behaviour (Task 3 test).

---

### Task 1: The planner flags requests that need watching

**Files:** Modify `src/planner.ts`, `src/learning.ts`, `src/discovery.ts` (traceOf); Test `tests/planning.test.ts`.

**Interfaces:** Produces `SearchPlan.watch?: boolean`; trace `plan.watch?: boolean`.

- [ ] Step 1: failing test — a planner reply with `watch: true` gives `plan.watch === true` and the system prompt mentions "only watching"; replies with `watch` missing, `'yes'` or `null` give `plan.watch` undefined and keep their searches.
- [ ] Step 2: run `node --import tsx --test --test-name-pattern="watching" tests/planning.test.ts` — FAIL.
- [ ] Step 3: implement. Add after `${PICTURE}` in both instructions:
  ``Also return watch: true when the request asks for something only watching the video can confirm (an action, a moment, a scene, what is shown or heard), false when titles, descriptions or transcripts can settle it.``
  (as a `WATCH` constant). `RESPONSE_SCHEMA`: `watch: {type: 'boolean'}`, required. `reply`: `watch: z.unknown().optional()`. `normalisePlan`: `...(typeof raw.watch === 'boolean' ? {watch: raw.watch} : {})`. `SearchPlan`: `watch?: boolean`. Draft split also drops `watch`. Trace plan type and `traceOf` carry `watch` when set.
- [ ] Step 4: `npx tsc --noEmit -p . && node --import tsx --test tests/planning.test.ts` — PASS.
- [ ] Step 5: `npm test` green; commit "Flag requests only watching can settle".

### Task 2: Early picks and the early request option

**Files:** Create `src/scene-early.ts`; Modify `src/retained-evidence.ts` (`requestSceneAnalysis` option `early`); Test `tests/scene-early.test.ts`, `tests/scene-verification.test.ts`.

**Interfaces:** Produces
`export function earlyScenePicks(results: Result[], screens: Map<string, ScreenSignal>|undefined, link: (r: Result) => LinkScore, limit: number, minConfidence: number): Result[]`
and `requestSceneAnalysis(..., {early?: boolean, ...})` which skips the judge-relevance minimum when `early` is true.

- [ ] Step 1: failing tests — (a) `earlyScenePicks` keeps only YouTube results whose screen is `promising` at or above `minConfidence`, orders by `link().value` descending, respects `limit`, and returns `[]` when `screens` is undefined; (b) in `tests/scene-verification.test.ts`, `requestSceneAnalysis` with a result that has no `judgement` creates nothing by default but attaches the existing job when `{early: true, interactive: true, ...}`.
- [ ] Step 2: run both — FAIL (module missing; early option ignored).
- [ ] Step 3: implement `src/scene-early.ts` (pure, comment citing the spec) and in `requestSceneAnalysis` change the filter to `results.filter(r => options.early || (r.judgement?.relevance ?? 0) >= (options.minRelevance ?? 3))`; add `early?: boolean` to the options type.
- [ ] Step 4: run both — PASS.
- [ ] Step 5: `npm test` green; commit "Pick scene candidates from the screener".

### Task 3: Start early, share the slots, review together

**Files:** Modify `src/config.ts` (`SCENE_EARLY`), `src/signals.ts`, `src/discovery.ts` (context `watch`), `.env.example`; Test `tests/signals.test.ts`.

**Interfaces:** Consumes Task 1 `plan.watch`, Task 2 `earlyScenePicks` and `early` option. Produces `SignalContext.watch?: boolean`, `SignalDeps.requestScenes?: typeof requestSceneAnalysis` (injection seam, like `deps.captions`).

- [ ] Step 1: failing tests in `tests/signals.test.ts` using `applySignals` with `deps.sceneLive: true`, a recording `requestScenes`, a judge, `config {...testConfig, SCENE_AUTO_QUEUE: true, SCENE_SEARCH_LIMIT: 2, GEMINI_API_KEY: 'x'}`, YouTube results and `screens`:
  1. `watch: true`: `requestScenes` is first called with `{early: true}` for the promising video(s), before the judge's first call resolves; with one early pick, the post-judge call asks for at most 1 more and never the early one; `out.sceneReview.entries` includes the early pick.
  2. `watch: false`, or `SCENE_EARLY: false`, or no `sceneLive`: no `early` call; the post-judge call is as today.
  3. An early `requestScenes` that throws: judging completes and the post-judge pick still runs.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement:
  - config `SCENE_EARLY: z.enum(['true','false']).default('true').transform(v => v === 'true')` with a one-line comment; `.env.example` `SCENE_EARLY=true` beside `SCENE_AUTO_QUEUE`.
  - discovery: add `...(plan.watch ? {watch: true} : {})` to the `applySignals` context.
  - signals: after `linkCaptionsTask`, compute `early` picks (`deps.sceneLive && config.SCENE_EARLY && config.SCENE_AUTO_QUEUE && config.SCENE_SEARCH_LIMIT && context?.watch`); start the caption task once as `captionsDone`; `earlyScenes = early.length ? captionsDone.catch(() => null).then(() => requestScenes(db, config, early.map(withDuration), query, {early: true, interactive: true, deadline: earlyDeadline, requirements: sceneRequirements})).catch(() => []) : Promise.resolve([])`; log `{event: 'scene_early', picked, ms}`; use `captionsDone.finally(() => mark('captions'))` in the existing `Promise.all`.
  - post-judge block: `const earlyRequests = await earlyScenes`; exclude their ids from the post-judge candidates; ask for `SCENE_SEARCH_LIMIT - earlyRequests.length` more only if > 0; `sceneRequests = [...earlyRequests, ...late]`; `sceneCandidates` = judged candidates of both; `sceneDeadline` = the early deadline when there were early requests.
  - `sceneRequirements` is the same filtered requirement list the post-judge call already passes (`judgeRequirements(contract)` minus format/date/duration/authority/completeness).
- [ ] Step 4: run — PASS; `npx tsc --noEmit -p .`.
- [ ] Step 5: `npm test` green; commit "Start scene analysis right after screening for watch requests".

### Task 4: Checks, then go live

- [ ] Bench the `watch` flag: the real planner (Luna lead) on the 11 requests of `scripts/query-remake-bench.ts` (planner mode prints `plan.watch`); expected true for cat glass, falcon heavy landing, interstellar docking, snow leopard; false for tie tutorial, UPI explainer, slime anime, Steve Jobs speech. Record mismatches.
- [ ] Live check: 2 moment searches (cat glass slow motion; falcon heavy boosters landing together) through the live worker path on main and on the branch (captions on, Supadata), measuring search start → scene verdict (`scene_early` log, scene job timestamps).
- [ ] Final whole-branch review (fresh reviewer), one fix pass, then ask the user before merge and restart.
