# Web tab review — design

## Goal

The Web tab (`/api/web?kind=web`) returns Brave / SearXNG results exactly as the engines rank them: nothing checks
whether a page is what was asked for. The Docs tab already runs a review pipeline over its results (Jev screener, text
reading, Jev pre-judge, LLM judge, removal of non-matches). The user wants the same pipeline for web results.

Agreed behaviour: **instant, then refine.** Raw results appear at once, as today; a background review removes pages that
do not match and orders the rest by relevance, with a reason for each.

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
`description_source: 'search'`), the Jev pre-judge with rejections on wrapping the LLM judge, the ≤ 4 / mismatch filter,
the relevance sort, and the provider messages. `reviewDocuments` becomes a thin caller that supplies the document
criteria, the PDF/viewer/office reader and `REVIEW_POOL = 60`, `TEXT_POOL = 20`. Behaviour of the Docs tab does not
change; the existing `tests/doc-review.test.ts` must pass unmodified.

Provider messages take a noun (`documents` / `pages`) so both tabs read naturally.

### 2. Web review (`src/web-review.ts`)

- `startWebReview(db, config, query, results): string` stores `{status: 'running'|'complete', results, removed, providers}`
  under a random UUID and runs the review in the background. Same limits as hunts: kept 10 minutes, at most 200 stored,
  at most 4 running; a review that cannot start (4 already running) completes immediately with the raw results and a
  provider note.
- Reading: `PageChecker.check` on the first `WEB_REVIEW_TEXT_POOL` (default 12) results in review order, 6 at a time,
  within 15 s total. Pages not read by then are judged on title and snippet (`evidenceCeiling` already caps them).
- Every result on the page is judged (a page holds at most ~40), so `reviewPool` is the page size and nothing is hidden
  for being unreviewed.
- Judge criteria:
  - "A web page that itself answers, explains or provides what the request asks for"
  - "When the request is ambiguous, a page that genuinely fits any reasonable reading matches"
  - "Home pages, search/listing pages and link farms match only when the request asks for that site"
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
- The reason line is rendered by `webItem` for web results only (`!item.doc_type`); Docs rendering is unchanged.

### 5. Configuration

- `WEB_REVIEW_ENABLED` (default `true`), `WEB_REVIEW_TEXT_POOL` (default 12, range 0–20). Added to `src/config.ts` and
  `.env.example`.
- No new budgets: the Jev screener, Jev judge and LLM judge daily budgets are shared with video and Docs.

### 6. Failure handling

| Failure | Result |
|---|---|
| No judge configured / `WEB_REVIEW_ENABLED=false` | No `review` token; raw results as today |
| Screener unavailable or out of budget | Search order used; provider note |
| Page reads slow | Unread pages judged on title + snippet after 15 s |
| Jev unavailable / out of budget | Everything goes to the LLM judge (existing `JevJudge` behaviour) |
| LLM judge unavailable | Review completes with raw results in raw order; notice "Relevance checking is unavailable right now" |
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
- `tests/doc-review.test.ts` passes unchanged after the extraction.
- Manual: run the app, search a web query, confirm the list refines in place and reasons appear (Playwright screenshot
  desktop + phone).

## Out of scope

Screenshots for web candidates; hunting inside web results; caching reviews across identical queries; feeding web
verdicts into the learning loop.
