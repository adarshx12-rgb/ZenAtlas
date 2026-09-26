# Judge council — design

## Goal

The judge decides what every tab shows, and the 2026-09-26 evaluation found its single-model verdicts letting through
re-uploads over originals, vendor pages as "independent", and constraint violations. Replace the single LLM judge with a
council of three seats that work together, each with a fallback from another provider (user decision: "Balanced").

## Seats

| Seat | Job | Models (main → fallback) | Budget bucket |
|---|---|---|---|
| Scorer | Scores every candidate (existing batched judge; Jev pre-judge stays in front) | `JUDGE_MODELS`: google/gemini-3.8-flash → qwen/qwen3.8-flash → previous judge chain; Gemini key last | `judge_calls` (`JUDGE_DAILY_BUDGET`) |
| Checker | Independently re-scores the top `COUNCIL_CHECK_TOP` (15) the Scorer rated 3 or more, without seeing the Scorer's verdicts | `COUNCIL_CHECKER_MODELS`: openai/gpt-5.6-luna → qwen/qwen3.7-plus (to be confirmed by measurement) | `council_checker_calls` |
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

## Out of scope

Feeding critic lessons to the Chair; judging images; the zero-results-on-budget-exhaustion fix (tracked separately).
