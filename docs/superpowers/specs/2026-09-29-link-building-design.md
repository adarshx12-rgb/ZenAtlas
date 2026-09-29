# Query–video link building

Date: 2026-09-29. Branch: `link-building` (from `judge-cascade` at 6c48213).

## Problem

A video search only succeeds when it can link the request to a video with evidence: title, description, comments,
transcripts and scenes. "mr beast buys ps5 to a subscriber" (SSJ3, quick, 2026-09-28) showed nothing although the pool held
45 videos, including the one Google ranks first. The trace shows why:

- `basis` for the pool was `metadata: 0, viewer_claims: 0, direct_evidence: 0`: nothing was judged on more than titles.
- Captions were fetched for 4 of 45 videos, the top 4 in Brave's order, and only because the query happened to trigger
  them. Captions are fetched during a search only for moment-style queries (`MOMENT_QUERY`) or live scene checks.
- Comments are fetched for the first 25 videos in Brave's order and picked by keyword overlap with the query.
- Transcript passages reach the judge through Postgres `ts_rank_cd` over the whole query, whose AND semantics make most
  windows score zero, so ties fall back to the first windows. On 1,642 Sonnet-labelled chunk–requirement pairs this
  keyword ranking scored AUC 0.43, below random (spike, `output/transcript-support-labels-2026-09-29.json`).
- 27 candidates had nothing quotable (`needs_evidence`), so the cascade capped them without a second look.
- No second round ran: gap exploration only runs for non-subject requirements (format, date, duration), and both of
  this query's requirements were subjects.
- The named creator's channel was never searched; every candidate came from four keyword rephrasings on Brave.

## Goal

Video search finds the video when the evidence exists, by strengthening each video's link to the request step by step
and spending the expensive evidence on the videos most likely to settle it, within the moderate budget: about +30 s and
+$0.03 per quick video search, more on deep ones.

Out of scope: Web and Docs tabs (they have their own review), scene analysis, model changes to the judge or cascade.

## Decisions (with the user, 2026-09-29)

- Approach A: gather evidence first, judge once.
- Moderate budget.
- Captions come first from Supadata, whose plan the user is raising (`SUPADATA_DAILY_BUDGET` / `SUPADATA_PER_MINUTE` set
  to the new plan); direct YouTube (6 a minute) stays the fallback.
- Transcripts reach the judge in full up to a cap, not as selected passages. Laya (a local 421M encoder) was tested
  for passage selection: fine-tuned, it beat keywords (held-out AUC 0.74 vs 0.43) but ran at ~1.5 chunk checks a second
  on the GTX 1650, so it was dropped and deleted.
- Expansion runs before judging, not after a failed judge pass, to stay inside the budget.
- A named creator's channel is searched only when the request names one and the first round is weak: a Brave `site:`
  query first, then a capped upload-list scan only if Brave also finds too little.

## Design

### 1. Link potential (`src/link-potential.ts`, pure)

A number in [0, 1] per candidate, from evidence already gathered, with no extra model calls:

- Base: the screener's P(promising) + 0.5·P(uncertain). Candidates the screener did not decide: 0.3.
- +0.2 when the video's channel is a creator the contract names (a `person` or `organisation` entity whose name matches
  the channel title after case and space folding).
- +0.15 when one of the video's fetched comments shares at least two requirement terms (4+ letter words from a hard
  requirement's text or evidence).
- Capped at 0.1 when the screener said mismatch with confidence ≥ 0.8.
- Clamped to [0, 1]. Each candidate's value and parts are logged in the search trace (`link` on each pool entry).

The screener already returns `decisions` (choice, confidence, probabilities per URL); discovery passes them into
`applySignals` through the signal context instead of only reordering the picks.

### 2. Evidence order and caption allocation (`src/signals.ts`, `src/captions.ts`)

- Comments are fetched for the `SIGNAL_VIDEOS` eligible videos with the highest link potential, not the first in
  Brave's order. The potential is then recomputed with the comment boost.
- Caption allocation replaces the `captionsNowTask` gate and its top-4 rule, for every video search:
  - candidates in potential order, skipping those below `LINK_MIN_POTENTIAL` (0.25);
  - a stored transcript is used as is;
  - otherwise fetched through the existing `fetchAndStore` (Supadata first, then YouTube, with their pauses and
    budgets), up to `LINK_CAPTIONS` (10) per search, at most 4 at a time, within `LINK_CAPTIONS_MS` (20 s);
  - fetches still running at the deadline finish in the background for later searches, and the existing background
    queue takes the rest.
- `CAPTIONS_NOW` / `CAPTIONS_NOW_MS` and the `MOMENT_QUERY` gate are retired in favour of these settings.
- When every caption route is paused, the search says so ("Captions unavailable right now; videos were judged on titles,
  descriptions and comments") and judges on what it has.

### 3. Full transcripts to the judge (`src/retained-evidence.ts`)

- For a video with stored captions, the judge receives its transcript in order as consecutive passages of about 2,400
  characters (each with start and end seconds, cut at caption-line boundaries), up to `LINK_TRANSCRIPT_CHARS` (24,000).
- A longer transcript keeps the passages that share the most requirement terms (4+ letter words from the hard
  requirements' text and evidence, falling back to the query's words), up to the cap, in time order.
- Passages are verbatim caption text, so the judge's quotes still map to timestamps through `quoteMoments`, and Jev's
  snippets are cut from the same passages as before.
- Judge batches are split so that no batch carries more than `LINK_BATCH_CHARS` (60,000) of transcript text, keeping each
  call inside `JUDGE_TIMEOUT_MS`; batch size otherwise follows the existing rule.

### 4. Expansion before judging (`src/link-expansion.ts`, called from `src/discovery.ts`)

After screening, for a video search with a contract, when fewer than `LINK_STRONG_MIN` (2) candidates have a base
potential of at least 0.5 and the search deadline leaves room:

1. **Requirement rewrite round (every such query).** One planner call (the refill planner's models, its own budget) gets
   the request, the hard requirements and the searches already run, and writes up to `LINK_EXPANSION_SEARCHES` (4) video
   searches in the words videos use for the unmet parts ("to a subscriber" → "giveaway to a fan", "surprising a viewer").
   They run through the existing search runner, and the new leads are screened and join the picks.
2. **Named creator (only when the contract names a person or organisation).** A Brave search
   `site:youtube.com "<name>" <requirement terms>` joins the same round.
3. **Upload-list scan (only if still fewer than `LINK_STRONG_MIN` strong candidates after 1–2 and a creator is named).**
   `channels.list?forHandle=@<name without spaces>` (1 unit); if a channel is found whose title matches the name, its
   uploads playlist is read 50 at a time up to `LINK_UPLOAD_SCAN` (1,000) uploads (about 20 units, within
   `YOUTUBE_DAILY_UNITS`). The screener screens the titles against the requirements and the promising ones join the
   picks as leads.

Expansion runs at most once per search, is logged (`event: link_expansion` with trigger counts, searches, leads added,
units used), and reports a provider line ("Looked again for videos that match: …").

### 5. Unchanged

Jev, the judge, the cascade, requirement decisions, scene verification and the closest-matches view are unchanged,
apart from what the judge is given to read.

## Error handling

- Planner, Brave or YouTube failures during expansion leave the first round's candidates as they were; a partial
  provider status says so.
- Caption routes follow the existing pause and budget rules; no new retry logic.
- A missing screener result (screener down) gives every candidate the default potential, so the order falls back to the
  current one.

## Testing and measurement

Unit tests (node:test, fakes as in the existing tests):

- link potential: base, creator boost, comment boost, mismatch cap, clamping;
- caption allocation: potential order, threshold, stored transcripts skipped, the cap, the deadline;
- full-transcript passages: order, line-boundary cuts, the cap, requirement-term selection for long transcripts;
- judge batching by transcript size;
- expansion trigger, the rewrite call's cleaning, the creator `site:` query, the upload scan's unit cap and name match.

Measurement after restart:

- Coverage: on the 158 labelled pairs, the share of supporting chunks that reach the judge (current windows vs full
  transcripts under the cap).
- Live probes (SSJ3 quick): "mr beast buys ps5 to a subscriber" and three other video queries that returned nothing or
  weak results in the traces; compare `basis` counts, shown results, time and cost with their earlier traces.
