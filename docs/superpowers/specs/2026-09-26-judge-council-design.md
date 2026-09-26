# Judge council — design

## Goal

The judge decides what every tab shows, and the 2026-09-26 evaluation found its single-model verdicts letting through
re-uploads over originals, vendor pages as "independent", and constraint violations. Replace the single LLM judge with a
council of three seats that work together, each with a fallback from another provider (user decision: "Balanced").

## Seats

| Seat | Job | Models (main → fallback) | Budget bucket |
|---|---|---|---|
| Scorer | Scores every candidate (existing batched judge; Jev pre-judge stays in front) | `JUDGE_MODELS`: google/gemini-3.5-flash-lite → google/gemini-3.8-flash → openai/gpt-4.1-mini → qwen/qwen3-vl-30b; Gemini key last | `judge_calls` (`JUDGE_DAILY_BUDGET`) |
| Checker | Independently re-scores the top `COUNCIL_CHECK_TOP` (15) the Scorer rated 3 or more, without seeing the Scorer's verdicts | `COUNCIL_CHECKER_MODELS`: openai/gpt-5.6-terra → mistralai/mistral-medium-3.1 → openai/gpt-5.4-mini (confirmed by the seat benchmarks; 35 s limit) | `council_checker_calls` |
| Chair | Decides only disputed candidates, seeing both verdicts and the evidence | `COUNCIL_CHAIR_MODELS`: anthropic/claude-sonnet-5 → google/gemini-3.1-pro-preview | `council_chair_calls` |

All seats use the same judge prompt and schema (`ModelJudge`), so verdicts share one scale and one set of evidence rules.
The Checker's model list never contains a Scorer model (filtered at construction), so the second opinion is always a
different model.

## Coordination

1. Scorer verdicts for all candidates (unchanged path: batches, Jev pre-judge, retries).
2. Checker verdicts for the top 15 (one call).
3. A candidate is **disputed** when the two relevance scores differ by `COUNCIL_DISAGREEMENT` (2) or more, when one
   finds an intent mismatch and the other does not, or when they disagree on a requirement (supported vs mismatch).
4. Agreed candidates: the Scorer's verdict with relevance = floor of the two scores' mean.
5. Disputed candidates go to the Chair in one call; each carries `council: {first, second}` (relevance and reason of
   both judges). The Chair's verdict is final. If the Chair is unavailable, the lower of the two scores is kept
   ("judges disagreed; the more cautious score was kept").
6. Checker unavailable → Scorer verdicts stand, with a provider note. Scorer unavailable → existing behaviour.

Applied in `src/signals.ts` (videos and mixed) and `src/review.ts` (Docs and Web). Each council run logs one line:
`{"event":"council","checked":n,"disputed":n,"chaired":n,"agreement":0..1,"checker":model,"chair":model}` (never the query).

## Settings

`COUNCIL_ENABLED` (true), `COUNCIL_CHECKER_MODELS`, `COUNCIL_CHAIR_MODELS`, `COUNCIL_CHECK_TOP` (15, 5–30),
`COUNCIL_DISAGREEMENT` (2, 1–5), `COUNCIL_CHECKER_DAILY_BUDGET` (1500), `COUNCIL_CHAIR_DAILY_BUDGET` (400).

## Seat selection by measurement

A replay harness (`scripts/council-bench.ts`) judges fixed candidate sets built from the evaluation's real results, with
labelled right and wrong answers (official vs re-upload, canonical vs mirror, authority vs vendor page, constraint
violations). It runs each Checker candidate (gpt-5.6-luna, gpt-5.4-mini, qwen3.7-plus, grok-4.7) 3 times and reports
label accuracy, stability across runs, latency, failures and token cost. The seats are confirmed from these numbers.

## Seat benchmark results (2026-09-26, 6 cases, 3 runs each; `output/council-bench/`)

| Model | Labels | Pairs | Spread | Median | Failures at 20 s | $/call |
|---|---|---|---|---|---|---|
| gemini-3.5-flash-lite | 96.6% | 88.2% | 0.69 | 5.0 s | 0 | 0.0046 |
| gemini-3.8-flash | 94.3% | 88.2% | 0.28 | 14.5 s | 1 | 0.0089 |
| gpt-5.6-luna (60 s limit) | 93.1% | 94.1% | 0.38 | 16.2 s | 4 at 20 s | 0.0020 |
| gpt-5.4-mini | 94.3% | 90.2% | 1.41 | 4.2 s | 0 | 0.0048 |
| qwen3.7-plus (60 s limit) | 95.4% | 94.1% | 1.10 | 39.8 s | all at 20 s | 0.0038 |
| gpt-4.1-mini | 79.3% | 70.6% | 0.92 | 6.3 s | 0 (15 missing verdicts) | 0.0018 |
| grok-4.7 (60 s limit) | 34.5% | 35.3% | – | 50.6 s | 11 of 18 even at 60 s | 0.0217 |
| qwen3.8-flash | – | – | – | – | all at 20 s | – |

Decisions: the Scorer stays on gemini-3.5-flash-lite (as accurate as 3.8-flash at a third of the time). Live, luna took
19-26 s per search as Checker, so a second benchmark (35 s limit, same cases) compared alternatives:

| Model | Labels | Pairs | Spread | Median | p90 | Failures | $/search (3 calls) |
|---|---|---|---|---|---|---|---|
| gpt-5.6-terra | 98.9% | 94.1% | 0.52 | 6.8 s | 12.3 s | 0 | 0.043 |
| mistral-medium-3.1 | 98.9% | 86.3% | 0.52 | 7.2 s | 9.9 s | 0 | 0.009 |
| claude-haiku-4.5 | 97.7% | 90.2% | 1.14 | 11.7 s | 28.9 s | 0 | 0.026 |
| gpt-5.4-mini | 90.8% | 90.2% | 1.21 | 3.8 s | 4.5 s | 0 | 0.015 |
| gpt-5.6-luna | 87.4% | 88.2% | 0.34 | 13.9 s | 28.5 s | 1 | 0.006 |
| gpt-5.6-sol | 87.4% | 88.2% | 0.14 | 15.5 s | 32.1 s | 1 | 0.052 |
| llama-4-maverick | 66.7% | 60.8% | 0.79 | 11.5 s | 15.0 s | 5 | 0.004 |
| deepseek-v4.1-flash | 33.3% | 27.5% | 1.70 | 27.5 s | 34.9 s | 12 | 0.008 |

The Checker is gpt-5.6-terra (most accurate, best ordering, steady, ~7 s), then mistral-medium-3.1 (another provider)
and gpt-5.4-mini. With 29 labelled items, differences under ~5 points are noise (luna measured 93% and 87% on two runs).
grok-4.7, qwen3.8-flash, llama-4-maverick and deepseek-v4.1-flash are unfit for any seat.

## Out of scope

Feeding critic lessons to the Chair; judging images; the zero-results-on-budget-exhaustion fix (tracked separately).
