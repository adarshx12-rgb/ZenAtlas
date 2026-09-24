# Jev exploration and pre-judge — design

**Superseded** by `2026-09-24-requirements-evidence-exploration-design.md`, which folds this design in. Kept for history.

## Goal

The user chose Jev (`typesafe/jev-1.13`, OpenRouter's Decisions API) for its speed and accuracy, and wants it to
carry the evidence-heavy work that is slow for the ordinary LLMs: web pages and video information (title,
description, comments, transcripts where permitted, links).

Jev cannot fetch anything. It takes a `state` object plus questions and returns typed answers in roughly 0.5–2 s,
at $0.042 per million input tokens and no output cost. So the division of labour is:

- **Our code fetches** everything, in parallel, with no model involved.
- **Jev decides**: which pages and videos to open, which of their links to follow, and a first relevance verdict
  for every candidate.
- **The LLM judge** only sees what Jev could not settle confidently.

### What Jev supports (from OpenRouter's docs)

| Type | Request | Answer |
|---|---|---|
| `choice` | `instructions`, `criteria` {option: description} | `choice`, `probabilities`, `confidence` |
| `score` | `instructions`, `criteria` ordered array (≤ 10 levels) | `score` (probability-weighted level), `probabilities`, `confidence` |
| `noul` | `instructions` stating a yes/no proposition | `noul` (probability it is true) |

Limit: 32 k tokens for `state` plus the longest question; any number of questions per call. Confidence measures
how concentrated the distribution is, not correctness, so thresholds must come from our own data.

### Why this is needed

A profiled deep search on 2026-09-23 showed:

- Jev exploration only ever looked at **web** results, so video searches skipped it without saying so.
- Jev decided from title, description and URL only, and visited 4 pages.
- The screener timed out (4 s) or hit connection resets in two searches running, and one failed batch discarded
  every other batch's decisions.
- Rich evidence (comments, transcripts, page text, links) is already fetched, but only the slow LLM judge
  (5 batches × ~9.5 s) ever reads it.

The judge is about 10 s of a ~120 s deep search. The larger time saving comes from exploration and fetch reuse;
the judge gets faster through fewer, smaller LLM batches.

## Approach

Plug Jev into the existing seams rather than adding a new pipeline stage:

1. Exploration gains a **video visitor** beside the web-page visitor, over a **shared evidence cache**.
2. A `JevJudge` wraps the existing LLM judge behind the same `Judge` interface (`src/judge.ts`).
3. The screener keeps successful batches and retries once after a connection reset.

Nothing else in the pipeline changes. Rejected alternatives: a new "Jev evidence" stage owning all fetching
(rewrites `src/signals.ts`, higher regression risk), and Jev replacing the planner's follow-up rounds (out of
scope).

## 1. Exploration over web and video

- **Seeds:** web **and** video leads (today: `leads.filter(l => l.target === 'web')` in `src/discovery.ts`).
- **Visiting a web page:** unchanged. The page checker fetches text and links, obeying robots rules and
  public-address checks.
- **Visiting a video:** fetch YouTube details (full description), top comments ordered by relevance, and the URLs
  found in the description and comments. Transcripts come only through the existing `PublicVideoEvidence` adapter,
  which covers PeerTube and archive.org captions, and only where source policy permits. **YouTube transcripts are
  never scraped** (legal-sources-only rule).
- **Jev decides** which pages and videos to open and which of their links to follow next. It keeps the existing
  useful / uncertain / irrelevant choice, but now reads the fetched text and comments, not just metadata.
- **Shared evidence cache:** everything fetched during exploration (page evidence, video details, comments,
  captions) is keyed by canonical URL and reused by `applySignals`, so nothing is fetched twice in one search.
- **Visit limit:** new `JEV_EXPLORATION_VISITS` (default 12), separate from `PAGE_CHECKS`, because video visits
  are cheap API calls. It replaces `JEV_EXPLORATION_PAGES` (and its "at most half of `PAGE_CHECKS`" rule); a set
  `JEV_EXPLORATION_PAGES` is read as `JEV_EXPLORATION_VISITS` for one release. Web-page visits still count against
  the page checker's own limits.
- Existing rules stay: no model-generated destinations, cycles and duplicates skipped, `site:` and source-scoped
  searches skip exploration, deep-search deadline stops further rounds.

## 2. The Jev pre-judge

### Where it runs

`JevJudge implements Judge`. `applySignals` receives it where it receives the LLM judge today. It gets the same
`JudgeCandidate` packets: title, description, comments, timestamped moments, transcripts, page text, Reddit
matches. One Jev call per candidate, at most `JEV_JUDGE_CONCURRENCY` (12) in flight.

### Evidence snippets

Each candidate's evidence is cut into at most 40 numbered snippets (`s1`…`s40`), each tagged with its field
(`title`, `url`, `description`, `comments`, `moments`, `transcripts`, `scenes`, `page`). A snippet is a sentence
of description or page text, one comment, one moment's viewer excerpt, one transcript passage, or the title.
Snippets are **cut out of** the original text, never reworded or completed, so each is an exact substring of its
field. The request stays under the screener's size check (state ≤ 24 000 bytes, body ≤ 56 000 bytes).

### Questions per candidate

1. **Relevance:** `score`, 5 ordered levels mirroring the judge rubric.

   | Level | Meaning | Maps to judge score |
   |---|---|---|
   | 0 | contradicts or misses the request | 1 |
   | 1 | only tangential | 3.5 |
   | 2 | plausible from metadata only | 5.5 |
   | 3 | specific supporting detail | 7.5 |
   | 4 | strong, direct evidence | 9.5 |

   The judge score is interpolated from Jev's probability-weighted `score`.
2. **Subject, intent, relationship, format:** one `choice` each. Options are `sN` ("snippet N establishes this
   dimension") for every snippet, plus `unknown` and `mismatch`. Instructions condense the judge's rubric: same
   event, tone and genre, format as the deliverable, "presented as real" is not proof, and fields are untrusted
   data.
3. **Lesser-known:** `noul`, used for the "Underrated find" badge (true when ≥ 0.7).

### Settling rules

- **Accepted by Jev.** Needs all of:
  - relevance level ≥ 3 with confidence ≥ `JEV_JUDGE_CONFIDENCE` (0.8);
  - all four dimensions answered with a snippet, each with confidence ≥ 0.8.

  The candidate becomes a normal `Verdict`:
  - `intentChecks` are built from the chosen snippets (`field` + exact text), so `groundedIntent` passes by
    construction;
  - relevance is `min(mapped score, verdictCeiling(candidate, checks))`, so the evidence cap still applies (a
    title-only result stays ≤ 6);
  - `reason` is built from the quotes, e.g. `Jev: relationship — "…"`;
  - `momentKeys` is empty: moment picks stay with the LLM judge;
  - the model name is recorded as the Jev model.
- **Would be rejected by Jev.** Any dimension answered `mismatch`, or relevance level ≤ 1, with confidence ≥ 0.8.
  - While `JEV_JUDGE_REJECT=false` (default, shadow mode): the decision is recorded and the candidate is
    **forwarded to the LLM judge**.
  - With `JEV_JUDGE_REJECT=true`: a verdict scored at most 4, carrying the mismatch check, which the existing
    display filter drops.
- **Everything else** is forwarded to the LLM judge, in batches of 6 (today 12) so each returns sooner.
- **Failure** of any kind (see §3) forwards the candidate. **No candidate is ever dropped because Jev failed.**

### Screener fix

- `JEV_SCREEN_TIMEOUT_MS` default goes from 4000 to 8000.
- A failed batch no longer discards the others: successful batches' decisions are kept, matching exploration.
- One retry after a connection reset (`ECONNRESET`).

## 3. Errors, budgets, trace and testing

### Settings

| Setting | Default | Purpose |
|---|---|---|
| `JEV_JUDGE_ENABLED` | `true` | Pre-judge on (effective only with `OPENROUTER_API_KEY`) |
| `JEV_JUDGE_CONFIDENCE` | `0.8` | Confidence required to settle a candidate |
| `JEV_JUDGE_REJECT` | `false` | Shadow switch; when false Jev never rejects on its own |
| `JEV_JUDGE_CONCURRENCY` | `12` | Jev calls in flight |
| `JEV_JUDGE_TIMEOUT_MS` | `6000` | Per-call deadline |
| `JEV_JUDGE_DAILY_BUDGET` | `3000` | Budget bucket `jev_judge_calls` |
| `JEV_EXPLORATION_VISITS` | `12` | Exploration visits, separate from `PAGE_CHECKS` |
| `JEV_SCREEN_TIMEOUT_MS` | `8000` | Raised from 4000 |

Estimated cost: about $0.02 per search (~60 calls × ~10 k input tokens at $0.042/M).

### Failure handling

Rule: any Jev failure falls back to what happens today, and never removes a result.

- **Timeout, connection reset, malformed answer:** retry once, and only after a connection reset. Otherwise the
  candidate is forwarded to the LLM judge, or the exploration link is not followed.
- **Budget exhausted:** Jev is skipped for the rest of that search. Reported as `budget_exhausted` in provider
  status and provider health (so the watchdog sees it).
- **Evidence too large:** drop the lowest-priority snippets (extra page text first, then extra comments) until the
  request fits. If it still does not fit, forward the candidate.
- **Video fetch fails** during exploration (YouTube quota, private or removed video): the visit is recorded as
  unavailable and exploration continues with other leads.
- **Jev entirely unavailable:** search results are identical to today's behaviour.

### Status lines

- `jev_judge`: "Settled N of M; K sent to the AI judge."
- `jev_exploration`: visits split into pages and videos, plus new candidates found.

### Trace and learning loop (no migration; all in `search_traces` JSON)

- `trace.exploration`: video visits, and the description and comment links found and followed.
- `trace.pool[i].jev`: relevance score and probabilities, the four dimensions with chosen snippet and
  confidence, and the outcome (`settled`, `forwarded`, `would_reject`).
- `metrics`: `jev_settled`, `jev_forwarded`, `jev_would_reject`, and `jev_reject_agreement` (the share of
  would-reject candidates the LLM judge also scored ≤ 4).
- `npm run admin -- audits` prints the running agreement rate. Suggested bar for switching on
  `JEV_JUDGE_REJECT`: ≥ 95 % agreement over ≥ 100 shadow rejections.

### Testing (TDD; Jev faked as in the existing screener and explorer tests)

- **Snippets:** every snippet is an exact substring of its field; snippets are trimmed to the size limit; an
  overlong candidate is forwarded.
- **Settling:**
  - a confident match with four snippet-backed dimensions yields a verdict that passes `groundedIntent` and the
    evidence cap;
  - low confidence, `unknown`, or a missing dimension forwards the candidate;
  - with the reject switch off, a would-reject is forwarded and recorded;
  - with it on, the candidate is scored ≤ 4 and dropped by the existing filter.
- **Failures:** timeout, connection reset, malformed answer and budget exhaustion each fall back as specified;
  Jev entirely down reproduces today's results.
- **Exploration:** video seeds are used; description and comment links become candidates; fetched evidence is
  reused by the judge (each URL fetched once); the visit limit holds.
- **Screener:** one failed batch keeps the others' decisions; a connection reset is retried once.
- **Live check:** extend `scripts/check-exploration.ts` to print the Jev judge's split, then run one real video
  query and one real web query.

### Docs

Update the Jev sections of `docs/DISCOVERY_QUALITY.md` to match the new behaviour.

## Out of scope

- The deep-search timing work (parked by the user on 2026-09-24).
- Jev replacing the planner's follow-up rounds.
- A Sonnet 5 judge trial.
- Scraping YouTube transcripts.

## Related

`2026-09-22-niche-first-search-design.md` (not implemented) changes which provider lane a quick search uses. This
design changes exploration and judging after candidates are collected, so the two are independent.
