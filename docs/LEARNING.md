# Learning loop

The engine keeps evidence about how well each search went, so later changes can be tested against it instead of guessed. This is step 1 of three. It records and grades; it does not yet change planning, sources or ranking.

## What is recorded

**Search traces** (`search_traces`). Every finished discovery job stores the request, the plan (kind, criteria, planner model), each search that ran with its round (0 = planned, 1+ = follow-up leads), provider statuses, and every admitted candidate: the round that first found it, the judge's relevance and reason (rejected candidates included), its evidence basis, and where it was shown. Deterministic metrics are computed alongside:

| Metric | Meaning |
|---|---|
| `verified`, `possible`, `closest` | Shown results that passed quote verification, fill-ins marked *Possible match*, and *Closest match* fallbacks |
| `rejected`, `near_misses` | Judged candidates not shown; those that scored 3–4 |
| `last_round_share` | Share of shown results first found in the final follow-up round. High means the search stopped too early; `null` when no follow-up round ran |
| `duplicate_groups` | Shown results that look like one series (for example "Part 17", "Part 18") |
| `basis` | Shown results judged on metadata, viewer claims or direct evidence |

**Searcher feedback** (`result_feedback`). Every result card has *Useful* / *Not useful*; after *Not useful*, optional reasons (off-topic, low quality, wrong format, duplicate). Opening a result is recorded, and *Missing something?* under the results takes a free-text note. Unlike `POST /api/feedback`, this works for every result, retained in the catalogue or not. Votes on retained records still feed the bounded personal ranking.

## The critic

With `CRITIC_ENABLED=true` and an OpenRouter key, each trace is queued for an audit by `CRITIC_MODEL` (default `anthropic/claude-sonnet-5`). Audits run in the worker's separate critic lane, so a slow model call never delays a search. The critic answers five questions, each with a confidence from 0 to 1:

1. **Best results**: a 0–1 score, plus candidates to promote, demote or remove.
2. **Missing sources**: up to `CRITIC_PROBES` domains the search never reached. Each is *tested*: the engine searches `<probe query> site:<domain>` on SearXNG and asks the critic whether the new results fit the request. A claim is `confirmed` at 2+ relevant results, `weak` at 1, `refuted` at 0, and `no_results` when the probe found nothing new.
3. **Search depth**: too shallow, enough or too deep, informed by `last_round_share`.
4. **Quality**: a 0–1 score with issues (duplicates, clickbait, metadata-only, off-tone, unavailable).
5. **Lessons**: up to 3 reusable lessons for this kind of request, each tagged planner, sources, judge or depth.

Claims naming URLs the search never had are discarded, as are invalid domains. Critic prompts forbid piracy sources, and a confirmed missing source is still only evidence: sources are approved only through the admin review (see `data/source-rules.json`).

**Weekly check.** Once a week the worker queues a review. `CRITIC_REVIEW_MODEL` (default `anthropic/claude-sonnet-5`) takes up to 10 random unreviewed audits from that week. It marks each finding supported, unsupported or unclear against the trace, the probe results and the searcher's feedback, and stores an agreement rate.

**Cost.** Each audit makes at most two model calls: the audit, plus one to verify probe results. The weekly check makes up to 10. `CRITIC_DAILY_BUDGET` (default 40) caps the calls per day, separately from `JUDGE_DAILY_BUDGET`. When the budget is spent, audits are recorded as `skipped`. At Sonnet 5's OpenRouter price ($2 / $10 per million input / output tokens), an audit of a 60-candidate search costs a few cents. The batch variant `anthropic/claude-sonnet-5:batch` is half price, but OpenRouter does not document its latency; test it before setting it as `CRITIC_MODEL`.

## Where to see it

The admin page's **Search audits** panel shows the last 7 days (averages, depth verdicts, probe outcomes, reviewer agreement, your feedback) and each audit with its findings. `npm run admin -- audits [limit]` prints the same report. Traces, audits and feedback are deleted after `TRACE_RETENTION_DAYS` (90).

## Next steps

- **Step 2: learn from confirmed evidence.** Per-topic source yield rates (what fraction of each site's results were relevant) feed admission and planner hints. Lessons are retrieved by embedding similarity for similar requests. Search depth follows `last_round_share`.
- **Step 3: gate every change.** Strategy choices (planner model, judge model, rounds, engine sets) run as a Thompson-sampling bandit per topic on a share of deep searches. A change becomes the default only when replay on held-out graded queries shows at least the minimum margin of improvement with at least 90% probability, and no query regresses by more than that margin. Finding confidences are calibrated against how often past findings were confirmed by probes, the reviewer and searcher feedback.

Global learning from many users needs accounts and anti-Sybil controls first (see API.md); today's data is the single operator's.
