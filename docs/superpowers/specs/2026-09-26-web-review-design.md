# Web tab review — design

## Goal

The Web tab (`/api/web?kind=web`) returns Brave / SearXNG results exactly as the engines rank them: nothing checks
whether a page is what was asked for. The Docs tab already runs a review pipeline over its results (Jev screener, text
reading, Jev pre-judge, LLM judge, removal of non-matches). The user wants the same pipeline for web results.

Agreed behaviour: **instant, then refine.** Raw results appear at once, as today; a background review removes pages that
do not match and orders the rest by relevance, with a reason for each.

Clarified pipeline (user, 2026-09-26): Jev analyses each discovered website's content and checks whether it satisfies the
query and whether its information is accurate; pages that pass go on to the next test (the LLM judge).

## Current state

- `src/web.ts` `searchWeb`: Brave first, SearXNG when Brave is missing, fails or finds fewer than `BRAVE_MIN_RESULTS`;
  unauthorized hosts dropped. For `kind=web` it returns there. For `kind=docs` it verifies the links and starts a hunt.
- `src/doc-review.ts` `reviewDocuments`: screener order when more than `TEXT_POOL` (20) documents → read text of the
  first 20 within 15 s (PDFs and viewer pages via `PageChecker`, office files via the preview converter) → Jev pre-judge
  (`makeJevJudge` with `JEV_JUDGE_REJECT: true`) wrapping the LLM judge (`makeJudge`) → remove relevance ≤ 4 or any intent
  mismatch → sort by relevance, attach `judgement {relevance, reason}`.
- `src/doc-hunt.ts` keeps hunt state in memory (10 min, at most 200 kept, 4 running) and serves `/api/docs/hunt`; it also
  calls `searchWeb` internally to find websites to explore.
- `public/results.js` polls the hunt token (`followHunt`), then removes rejected rows and reorders kept ones in place.
  `webItem` does not render `judgement` today.

## Design

### 1. Shared review core (`src/doc-review.ts` → `src/review.ts`)

Extract the steps after text reading into one function used by both tabs:

```ts
reviewResults(db, config, query, items, {
  criteria: string[],                 // judge context criteria
  requirement: string,                // R1 text
  read: (items) => Promise<Map<url, PageEvidence>>,  // tab-specific text reading, already time-boxed
  inspected: (item, page) => JudgeCandidate['inspected'],
  textPool: number, reviewPool: number,
  deps: {judge?, screener?},
}) => {results: Reviewed[], removed, providers}
```

It owns: screener ordering (when `items.length > textPool`), building `JudgeCandidate`s (`kind: 'website'`,
`description_source: 'search'`), calling the judge the caller supplies (Docs: Jev pre-judge in its current settle mode;
Web: Jev in gate mode, section 2; both wrapping the LLM judge), the ≤ 4 / mismatch filter,
the relevance sort, and the provider messages. `reviewDocuments` becomes a thin caller that supplies the document
criteria, the PDF/viewer/office reader and `REVIEW_POOL = 60`, `TEXT_POOL = 20`. Behaviour of the Docs tab does not
change; the existing `tests/doc-review.test.ts` must pass unmodified.

Provider messages take a noun (`documents` / `pages`) so both tabs read naturally.

### 2. Web review (`src/web-review.ts`)

- `startWebReview(db, config, query, results): string` stores `{status: 'running'|'complete', results, removed, providers}`
  under a random UUID and runs the review in the background. Same limits as hunts: kept 10 minutes, at most 200 stored,
  at most 4 running; a review that cannot start (4 already running) completes immediately with the raw results and a
  provider note.
The web review is a sequence of tests; a page must pass each to reach the next:

1. **Read.** `PageChecker.check` on every discovered result (a page of results holds ~20, at most ~40), in screener
   order, 6 at a time, within `WEB_REVIEW_READ_MS` (default 15 s), without opening a browser (`renders: 0`). A page that
   cannot be read (failed load, bot block, robots.txt, or too slow) goes to step 3 on its title and snippet, since Jev has
   no content to analyse. It is not removed: `PageChecker` reports bot blocks and dead links alike as `unavailable`, and
   many good sites block automated reads.
2. **Jev analyses the page** (`JevJudge` in *gate* mode, below). From the page's own text it answers:
   - *Satisfies the query?* — the existing relevance score and the R1 requirement check, quoting a snippet.
   - *Accurate information?* — a new `noul` question: "The page gives specific, credible, internally consistent
     information on the request, with no sign of spam, machine-generated filler, clickbait, or claims that are outdated
     for a time-sensitive request." Jev cannot verify facts against the world; this judges the page's own signals of
     reliability, which is what can be checked without a second source.

   A page fails when Jev confidently says it misses the query (existing rule: score ≤ 1.5 or an R1 mismatch at
   `JEV_JUDGE_CONFIDENCE`) or its accuracy probability is below `WEB_JEV_ACCURACY_MIN` (default 0.3). Failed pages are
   removed with reason "Jev: misses the request" / "Jev: unreliable information".
3. **LLM judge.** *Every* page that passed Jev goes to the LLM judge. Unlike video and Docs, Jev never settles a web page
   on its own. Jev's findings travel with the candidate (`jev: {relevance, accuracy}` on the `JudgeCandidate`) and the
   criteria include "The page's information is accurate and trustworthy: prefer primary, specific, current sources", so
   the judge checks accuracy too. The existing ≤ 4 / mismatch filter removes what it rejects.
4. Survivors are sorted by the judge's relevance; ties keep search order.

**Gate mode.** `JevJudge` gains constructor options `{settle: boolean, accuracy: boolean}`. Video and Docs keep the
defaults (`settle: true, accuracy: false`), so their behaviour does not change. Web uses `settle: false, accuracy: true,
reject: true`: a confident match is forwarded instead of settled, and the accuracy question is asked in the same Jev call
(no extra call or budget). The `JevRecord` gains `accuracy?: number` so the learning loop can later tune the threshold.

**Shadow settling.** In gate mode, a page Jev *would* have settled (the existing confident, fully backed rule) is
recorded as outcome `would_settle` and still forwarded. Measured on 2026-09-26, video traces show Jev settling only 2 of
100 candidates, so settling saves little; the shadow record lets us measure how often the LLM judge agrees before turning
it on. The review logs one line per completed web review (`jev_would_settle`, `jev_rejected`, `settle_agreement` = share
of would-settle pages the LLM judge scored ≥ 7), and `WEB_JEV_SETTLE` (default `false`) switches web to settle mode once
the agreement is high.

- Every result on the page is judged, so `reviewPool` is the page size and nothing is hidden for being unreviewed.
- Judge criteria:
  - "A web page that itself answers, explains or provides what the request asks for"
  - "When the request is ambiguous, a page that genuinely fits any reasonable reading matches"
  - "Home pages, search/listing pages and link farms match only when the request asks for that site"
  - "The page's information is accurate and trustworthy: prefer primary, specific, current sources"
- Requirement R1: `The page itself is what the request asks for: "<query>" (its subject and intent as stated)`, evidence:
  "The page text, title or snippet shows its subject."
- `inspected`: `{format: null, published: page meta date ?? search date, publisher: null, access: accessKind(url)}`.
- Screenshots are not sent to the judge in this version (cost); `JudgeCandidate.page.screenshot` stays unset.

### 3. API

- `searchWeb` input gains nothing public. `Deps` gains `review?: (query, results) => string | null`; the options object
  gains `review: boolean` (default true) so `doc-hunt.ts`'s internal call passes `false`.
- For `kind=web`, when `WEB_REVIEW_ENABLED`, a judge is configured, and there is at least one result, the response carries
  `review: <token>`. Otherwise `review` is absent and the page behaves exactly as today.
- New route `GET /api/web/review?token=<uuid>` → `{status, results: WebResult[] (with judgement when complete), removed,
  providers}`; 404 `review_expired` when unknown, mirroring `/api/docs/hunt`.
- `WebResult` gains optional `judgement?: {relevance: number; reason: string}`.

### 4. Page (`public/results.js`)

- `searchWebPage`: when `data.review` is present, status reads `N results · checking relevance…` and `followReview(token,
  page, data.review)` starts.
- `followReview` polls every 1.2 s (at most 50 polls). On `complete`: rows of that page not in the kept list are
  removed, kept rows are reordered in place (the same logic as `followHunt`, factored into a shared helper), each kept
  row gets a "Why this matches (r/10): reason" line, non-ok providers become notices, and the status reads
  `N results · M removed as not matching`. If every result was removed: "No page matched the request. Try another query."
- Only the reviewed page's rows are touched, so rows loaded from later pages meanwhile are unaffected. A new search
  cancels polling through the existing `controller` generation check. Poll failure or expiry leaves the raw list and
  just clears "checking relevance…".
- The reason line is inserted by `followReview` under the title of each kept row; Docs rendering is unchanged.
- Pages the LLM judge could not score (a failed batch) stay after the ranked ones, without a reason.

### 5. Configuration

- `WEB_REVIEW_ENABLED` (default `true`), `WEB_REVIEW_READ_MS` (default 15000, range 2000–30000) and
  `WEB_JEV_ACCURACY_MIN` (default 0.3, range 0–1; 0 turns the accuracy gate off while still recording it). Added to
  `src/config.ts` and `.env.example`.
- No new budgets: the Jev screener, Jev judge and LLM judge daily budgets are shared with video and Docs.

### 6. Failure handling

| Failure | Result |
|---|---|
| No judge configured / `WEB_REVIEW_ENABLED=false` | No `review` token; raw results as today |
| Screener unavailable or out of budget | Search order used; provider note |
| Page reads slow | Unread pages skip Jev and go to the LLM judge on title + snippet after `WEB_REVIEW_READ_MS` |
| Page cannot be read | Judged by the LLM on title + snippet (not removed) |
| Jev unavailable / out of budget | Every read page goes to the LLM judge, which still checks relevance and accuracy |
| LLM judge unavailable | Jev's removals still apply; pages that passed Jev stay, in search order, without reasons; notice "Relevance checking is unavailable right now" |
| Too many reviews running | Completes at once with raw results; notice |
| Token expired / poll fails | Page keeps the raw list |

### 7. Documentation

Add a short `docs/WEB_SEARCH.md` describing the review, and list `/api/web/review` in `docs/API.md`.

## Testing

- `tests/review.test.ts` (shared core, fake judge/screener/reader): filter at ≤ 4 and on mismatch, relevance sort with
  stable ties, screener reorder only above `textPool`, judge failure returns raw order with a provider note.
- `tests/web-review.test.ts`: token lifecycle (running → complete → expiry), concurrency cap, read time-box (a reader that
  never resolves still lets the review finish), web criteria and R1 passed to the judge.
- `tests/web.test.ts`: `review` token present for `kind=web` with results; absent when disabled, when no results, for
  `kind=docs`, and when called with `review: false`.
- `tests/jev-judge.test.ts`: gate mode never settles (a confident, fully backed match is forwarded to the inner judge);
  low accuracy (< `WEB_JEV_ACCURACY_MIN`) rejects with "unreliable information"; accuracy question absent in default
  mode so video/Docs requests are byte-for-byte unchanged; `accuracy` recorded on the `JevRecord`.
- In gate mode, when the inner judge fails, forwarded pages come back without verdicts and the web review keeps them
  (not treated as rejected).
- `tests/doc-review.test.ts` passes unchanged after the extraction.
- Manual: run the app, search a web query, confirm the list refines in place and reasons appear (Playwright screenshot
  desktop + phone).

## Out of scope

Screenshots for web candidates; hunting inside web results; caching reviews across identical queries; feeding web
verdicts into the learning loop.
