# Judge cascade: evidence first, one strong opinion only where it is needed

Date: 2026-09-27. Status: approved direction; offline benchmark first, live changes only after it.

## Why replace the council

Measured on 2026-09-27 (tier comparison, `output/tier-comparison-2026-09-27*.json`, council logs):

- The council is 70-85% of an SSJ3 Web/Docs search's model spend (Checker gpt-5.6-terra about $0.06, Chair
  claude-sonnet-5 about $0.06 per search; the Scorer about $0.02).
- It re-scores up to 15 results per search whether or not the Scorer was sure. A single judge's scores already move
  0.5-1.1 points between runs (2026-09-26 seat benchmark, `mean_spread`), so a 2-3 point "dispute" is often noise, and
  31-42% of checks became disputes that each cost a Chair call.
- Scorer, Checker and Chair run one after another: about 30-50 s of model time after pages are read.
- Results only one tier kept were nearly all graded on-target: the Chair mostly decides between good results.
- Accuracy per search moved by less than the grading noise (about 10 points) between SSJ3, SSJ3-lean and SSJ1.

## The cascade

1. **Evidence checks (Jev, rules).** Jev picks, per requirement, a snippet cut verbatim from inspected content. A result
   is settled only when every requirement has such a snippet (verified with `groundedQuote`), rejected only when a
   snippet shows a requirement fails. Jev's confidence routes work; it is never evidence. A random
   `JEV_SETTLED_AUDIT_RATE` (0.1) of settled results still goes on to Stage 2, logged, to keep measuring settle precision.
2. **One cheap judge** (the Scorer, gemini-3.5-flash-lite) scores everything not settled, in one pass, with requirement
   checks and quotes.
3. **Uncertainty flags.** A verdict is escalated when any of:
   - borderline: relevance within `CASCADE_BORDER` (default 4-6) of the keep line (keep is relevance > 4);
   - conflict with evidence: Jev found a snippet-backed mismatch the Scorer kept, or snippet-backed support for every
     requirement the Scorer rejected;
   - unbacked confidence: relevance >= 7 while a requirement check has no grounded quote (possible hallucination or
     injected text; only when Jev or the Scorer actually saw content).
4. **One strong judge** (SSJ3: gpt-5.6-terra; SSJ1: its cheaper seat) re-judges only flagged results, in small parallel
   batches, told why each was flagged. Its verdict is final. No Chair.
5. **Later, not in the first cut:** top-10 listwise re-rank; a verdict cache keyed by URL, content hash and requirement
   text; strong-judge verdicts stored as labels to calibrate or distil a local re-ranker.

Evidence rule throughout: only verbatim snippets and grounded quotes count as evidence. Confidence (Jev's or a model's)
may send a result to a stronger judge; it never decides a result on its own.

## Step 1: offline benchmark (this change)

`scripts/judge-arch-bench.ts` runs both architectures on `evaluation/council-bench.json` with the real classes
(`JevJudge`, `ModelJudge`, `councilReview`):

- **council**: Scorer, then the live council (terra Checker, sonnet-5 Chair, gap 3, sure score 8).
- **cascade**: Jev, then Scorer, then flags, then terra on flagged results only.

Per architecture, over several runs: label accuracy (good >= 5, bad <= 4), pair accuracy, calls and cost per role,
wall time per case, escalation share, and Jev outcome counts. Output: `output/judge-arch-bench/<timestamp>.json`.

Known limit: the bench has 29 labelled candidates in 6 cases, and only 3 cases carry requirements (Jev needs them). The
first run shows direction, not proof; the next step is growing the bench to 30-40 labelled candidates per tab.

## Benchmark result and models (2026-09-27)

SSJ3, 29 labelled candidates x 3 runs: council 98.9% labels / 92.2% pairs / $0.013 a case / 10.6 s median; cascade
flash-lite then terra on 4-7: 100% / 94.1% / $0.008 / 7.9 s (p90 10.3 s). A 4-6 band missed a confident 7 (a talk, not
the documentary); terra-first variants were as accurate but cost more and ran slower.

| Seat | SSJ3 | SSJ1 |
|---|---|---|
| Scorer (`JUDGE_MODELS`) | gemini-3.5-flash-lite | gemini-2.5-flash-lite |
| Strong (`CASCADE_STRONG_MODELS`) | gpt-5.6-terra, mistral-medium-3.1, gpt-5.4-mini | gemini-3.5-flash-lite, claude-haiku-4.5, then SSJ3's |

The cascade replaces the council on all tabs (`JUDGE_ARCHITECTURE=cascade`, default); `council` is kept as a way back.
Live log line: `{"event":"cascade","tier","judged","escalated","answered","reasons","strong","strong_ms"}`.

## Still to do

Run the unit tests (`tests/cascade.test.ts` and the existing suite), grow the bench to 30-40 labelled candidates per tab,
then a live SSJ3 comparison against the council with `scripts/compare-tiers.ts` and the `cascade` log lines.
