# Streaming judging (step C)

Date: 2026-10-01. Builds on main e5a6879. Step C of the pipeline redesign: stages hand work on as soon as it is ready
instead of waiting for the slowest item of the previous stage. User decisions: results still appear all at once (no
progressive display); streaming stays within judging (the same candidates as today; retrieval is not overlapped); the
Strong judge runs alongside inspections.

## Measurements (seconds after evidence gathering starts)

| | Falcon Heavy (video) | Background removal (web) | Snow leopard (video) |
|---|---|---|---|
| Reddit | 0.9 | 0.4 | 0.4 |
| YouTube details | 11.1 | - | 0.4 |
| Page checks | 6.8 | 3.3 | 8.4 |
| Comments (top videos) | 14.6 | - | 10.0 |
| First-pass judge done | 23.5 | 13.0 | 19.8 |
| Strong stage done | 51.8 | 13.0 | 19.8 |

The details call itself takes 0.2-0.3 s (the 11.1 s was one slow response). Most YouTube candidates need neither comments
nor page checks, yet wait for the slowest of them. Inside the Strong stage, up to 3 inspections (8 s limit plus a
re-judge) run before any Strong call starts. Median over 25 probes: Strong stage ~35 s when it runs, total ~90 s.

## Design

1. **Strong alongside inspections** (src/cascade.ts). Flagged verdicts that need no inspection go to the Strong judge
   immediately; inspections run at the same time; a re-judged inspected candidate that is then flagged gets its own
   Strong call. Same verdict rules, same limits, one log line per review.
2. **Readiness per candidate** (src/signals.ts). Each candidate's evidence has its own completion: YouTube videos after
   the details call, plus their own comments when they are among the commented ones, plus the early captions when they
   are caption targets; web pages after their own page check; other video sites after their own evidence check; every
   candidate after Reddit. Candidates with nothing to wait for are ready after Reddit.
3. **Preparation per subset.** Requirement findings, stored transcripts, viewer moments, Reddit matches and the judge input
   are built for whichever candidates are ready, instead of once for all.
4. **Streaming dispatch.** Ready candidates are flushed to the first-pass judge in batches (the existing batch size and
   transcript budget) when a batch is full or nothing new has become ready for a short pause (300 ms); each batch's
   verdicts go straight into its own Strong step (design 1), sharing the per-search inspection limit.
5. **End of search, unchanged in order.** After every batch: the retry of skipped candidates, the post-judge scene pick,
   the early-scene re-judge (with a small Strong step for those videos only), ranking. The council architecture
   (JUDGE_ARCHITECTURE=council) keeps today's non-streaming path.
6. **Switch.** `JUDGE_STREAMING` (default true); false restores the current all-at-once flow.

## Not in scope

Progressive display, overlapping retrieval with judging, changing Strong batching or models, a Strong deadline.

## Testing

Unit: Strong starts before inspections finish and verdicts match the sequential result; readiness resolves per candidate
(a details-only video is ready before a commented one); preparation for a subset equals the same candidates prepared with
all; batches flush when full and after the pause; the inspection limit is shared across batches; every existing judging,
cascade, scene and signals test stays green with streaming on, and with `JUDGE_STREAMING=false`. Live: 3 searches (video,
web, moment) on main and branch with captions off, comparing stage marks and total time; branch not worse on results.
