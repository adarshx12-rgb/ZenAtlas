# Streaming Judging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Judging stages hand work on as soon as it is ready: Strong runs alongside inspections, and candidates are judged as their own evidence lands.

**Architecture:** Four tasks, each shippable: (1) cascade concurrency, (2) per-candidate readiness and subset preparation as a no-behaviour-change refactor, (3) streaming dispatch with per-batch Strong steps behind `JUDGE_STREAMING`, (4) measurement, review, merge.

**Tech Stack:** TypeScript (Node 24, tsx), node:test, embedded Postgres in tests.

**Spec:** `docs/superpowers/specs/2026-10-01-streaming-judging-design.md`

## Global Constraints

- Worktree branch `stream-judging` from main e5a6879 (already carries per-task timing marks: details, reddit, pages, video_evidence).
- Results appear all at once; the same candidates are judged as today; the council path is unchanged.
- Verdict rules, batch sizes, transcript budgets, the inspection limit (3 per search) and Strong models do not change.
- Every existing test stays green after every task; Task 2 must not change any test outcome.
- Live checks: captions off (`YOUTUBE_CAPTIONS=false`), at most 3 searches per side; OpenRouter balance is low (~$3.6).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A Strong call that fails while inspections are still running: inspections still finish and the failed batch keeps first scores.
- A batch whose judge call throws: its candidates go to the end-of-search retry like skipped ones today.
- No candidate ready for a long time (all comments slow): the pause flush must not spin; the final flush waits for readiness.
- A candidate in two readiness groups (YouTube video that is both commented and a caption target): judged once, after both.
- `JUDGE_STREAMING=false` and the council architecture: identical behaviour to e5a6879.

---

### Task 1: Strong runs alongside inspections

**Files:** Modify `src/cascade.ts` (`cascadeReview`); Test `tests/cascade.test.ts`.

- [ ] Step 1: failing test — with a requirement in context, candidate `a` without a page (needs evidence; inspection takes 300 ms and returns it with a page; the re-judge scores it 5 so it is flagged) and candidate `b` scored 5 (flagged): the Strong judge is first called with `[b]` before the inspection resolves, then with `[a]`; final verdicts are the Strong scores for both; one cascade log line with `inspections: 1`, `escalated: 2`.
- [ ] Step 2: run `node --import tsx --test --test-name-pattern="alongside" tests/cascade.test.ts` — FAIL (Strong called once with both, after the inspection).
- [ ] Step 3: implement — split `current` into non-inspected (flags now, Strong batches start now) and inspected (flags after their re-judge, own Strong batches); `Promise.allSettled` over both groups; records, reasons, `answered`, `model` and the `partial` provider note aggregate across both; log once at the end.
- [ ] Step 4: run cascade, evidence-routing and signals tests — PASS.
- [ ] Step 5: `npm test` green; commit "Run the Strong judge alongside inspections".

### Task 2: Readiness per candidate and preparation per subset (refactor)

**Files:** Modify `src/signals.ts`; Test `tests/signals.test.ts`.

**Interfaces:** Inside `applySignals`: `ready(id): Promise<void>` per result, and `prepare(ids): Promise<JudgeCandidate[]>` building findings, stored transcripts, moments, Reddit matches and judge input for those ids. With streaming off (this task) the flow still awaits all evidence, then `prepare(all pool ids)`.

- [ ] Step 1: failing test — a details-only YouTube video's readiness resolves before a commented video's (fake YouTube client whose comments call waits 200 ms), observed through a test hook `deps.onReady?(id)` called when a candidate becomes ready.
- [ ] Step 2: run — FAIL (no hook).
- [ ] Step 3: implement readiness deferreds in the youtube, page, adapter, captions and Reddit tasks; move the post-evidence preparation into `prepare(ids)`; call it once for the whole pool. No behaviour change.
- [ ] Step 4: run the new test and the whole signals, closest, intent, quote-moments, video-evidence and council suites — PASS unchanged.
- [ ] Step 5: `npm test` green; commit "Track each candidate's evidence and prepare candidates in subsets".

### Task 3: Streaming dispatch with per-batch Strong steps

**Files:** Modify `src/config.ts` (`JUDGE_STREAMING`), `src/signals.ts`, `.env.example`; Test `tests/signals.test.ts`.

- [ ] Step 1: failing tests — (a) with streaming on, a details-only video is judged before a commented video's comments arrive (judge call order vs a 300 ms comments delay); (b) every pool candidate is judged exactly once and the result equals the streaming-off result for the same fakes; (c) the inspection limit (3) holds across batches; (d) a throwing batch's candidates are retried at the end; (e) `JUDGE_STREAMING=false` gives the old call pattern (one judging wave after all evidence).
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement — a dispatcher that collects ready pool candidates, flushes `judgeBatches` when a batch is full or after 300 ms with nothing new, `collect`s each batch and runs `cascadeReview` on it with the remaining inspection budget; after every candidate is dispatched and settled: skipped retry, scene pick, early-scene re-judge plus a Strong step for those videos, ranking. Council path untouched.
- [ ] Step 4: run — PASS; full judging-related suites.
- [ ] Step 5: `npm test` green; commit "Stream candidates to the judges as their evidence lands".

### Task 4: Measure, review, merge

- [ ] Live: 3 searches (Falcon Heavy video, background-removal web, snow leopard moment), captions off, on main and branch: stage marks, total time, results shown.
- [ ] Final whole-branch review (fresh reviewer), one fix pass.
- [ ] Ask the user before merging and restarting.
