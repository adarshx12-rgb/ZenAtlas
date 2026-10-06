# Cited Web answers

The first page of Web search now adds a short answer after relevance review. Results remain usable while it reads,
drafts and checks the answer. Source buttons show the fetched passages supporting a claim. The panel also offers
copying with citations and stopping the answer. Real provider notices remain separate from answer failures.

The implementation reuses the current routing, fetches, extraction and relevance checks. Specialist sources can be
selected for evidence even when the Web list holds them below the top five. Up to three routed results are considered
first; ordinary search sources fill the rest. The original request, rather than only its spelling-corrected version,
goes to the writer and verifier. A small deterministic intent plan distinguishes comparisons, finding resources,
factual lookups and explanations; explicit years and freshness requests are preserved. Jurisdiction and other
qualifications stay in the original request. No additional router model call is required.

## Evidence and checking

`PageChecker` can retain up to 24,000 characters of fetched text in addition to the existing 800-character relevance
excerpt. This is enabled for answer-producing Web reviews. PDFs found by Web search can contribute extracted text,
but no PDF page or video timestamp is claimed by this version. Search snippets and judge explanations are not evidence.

The collector selects at most `ANSWER_SOURCES` readable, judged-relevant sources, at most two per hostname and three
passages per source (up to 900 characters each). Query terms prioritize passages throughout the retained text.
Exact normalized text copies are collapsed; near-duplicate reporting and shared ownership are not fully detected.
Each source records its fetched URL, title, known publication date, retrieval time and content hash. Passages retain
their character offsets in the retained extracted text. Short published excerpts are shown, never an entire article.

The writer returns atomic plain-text claims with passage IDs. Server validation rejects unknown citations. A different
model checks whether each whole claim follows from its cited passages, including names, numbers, dates and scope.
Missing, duplicate, partial, contradicted or unsupported verdicts remove the claim. Only cited passages are exposed.
A partial answer explicitly says claims were omitted. A failure of either model never publishes an unchecked draft.
These checks reduce errors but are not proof that a source is true or that model verification is infallible.

Successful citation sources are learned under `answer_<field>` in the existing `field_sources` table, separately from
relevance. Two successes make a source eligible for routing. Only sources found on the open web count: a routed site
is read first, so crediting it would let it keep itself routed. A writer's unsupported claim does not penalize its source.
Existing read/write permissions apply; no migration is required. Routing decisions keep the existing one-hour cache.

## Models and lifecycle

The `.env.example` `ANSWER_*` settings configure the feature, writer/verifier fallback lists, source cap, per-role daily
budgets and a 45-second total generation deadline. SSJ1 has separate model choices; SSJ3 uses the base choices.
The actual writer model is excluded from the verifier list. At most one request per fallback model is attempted;
there are no delayed rate-limit retries. Stopping or timing out prevents further model stages and discards late output.
An already-sent upstream HTTP request can finish within its bounded network timeout.

`GET /api/web/review?token=...` exposes an optional `answer` while the review's `status` can already be `complete`.
Answer statuses are `reading`, `drafting`, `checking`, `ready`, `insufficient`, `unavailable`, or `cancelled`.
`DELETE /api/web/review?token=...` stops the answer and requires the normal write header/origin checks. Review tokens
are bound to the search session; another session receives 404. A new query/tab cancels the previous pending answer.
Four Web reviews and, separately, four answers can run concurrently; a review's slot is freed before its answer starts. Snapshots expire after ten minutes and do not survive an API restart.
Unpublished evidence is never included in the polling response; it is not persisted in the catalogue.

Cost logs use `answer_writer` and `answer_verifier`; the `cited_answer` event records model names, counts and duration
under the search trace, without logging query text. No shared answer cache is introduced.

## Scope

This release provides cited summaries for Web search, including readable PDF sources found there. Dedicated Docs,
Videos and Images summaries, page/timestamp navigation, conversational follow-ups, a dispute resolver, and automatic
answer-specific retrieval retries are subsequent work. Existing retrieval/refill still searches for missing results.

Run `node --import tsx --test tests/answer.test.ts tests/web-review.test.ts tests/web.test.ts tests/field-routing.test.ts
tests/openai-compatible.test.ts tests/evidence.test.ts tests/tiers.test.ts` and `npm run build` for the focused checks.
