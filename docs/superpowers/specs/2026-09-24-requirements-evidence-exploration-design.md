# Shared requirements, evidence inspection and gap-directed exploration — design

Agreed with the user on 2026-09-24. **Not implemented yet**; an implementation plan follows this spec.

This spec **supersedes** `2026-09-24-jev-exploration-prejudge-design.md`. Its video exploration, shared evidence
cache, Jev pre-judge and screener fix are folded in here (§3, §4), adjusted to the requirements contract.

## Scope: only what the engine lacks

The user asked for requirements, evidence inspection, gap-directed exploration, aligned judging and evaluation, and
then said to skip whatever overlaps existing features. Kept as-is, **not rebuilt**:

- Unknown ≠ false for missing evidence, and the supported / unknown / mismatch statuses with exact quotes
  (`src/judge.ts`).
- The v5 display filter: a mismatch caps at 4 and is dropped; unverified caps at 5 and appears only under
  *Closest matches*.
- Bounded Jev exploration (rounds, visits, deadline, robots and public-address checks, budgets, dedupe, no invented
  destinations), deep follow-up rounds, and the critic's `site:` probes.
- Per-result judge reasons, `search_traces`, and the human-review evaluation files (`evaluation/*.review.json`,
  `scripts/evaluate-real.ts`).

New work is limited to:

- (a) a typed requirements contract;
- (b) evidence linked to requirement IDs, with deterministic inspectors for format, date, authority and
  completeness, plus PDF inspection;
- (c) exploration that targets unmet requirements, and stops when they are covered;
- (d) the contract passed through screening, Jev, judging, ranking and presentation, including result-set coverage;
- (e) evaluation additions.

## Background: what went wrong on the regression queries

From `output/jev-evaluation-2026-09-23.md` and the 2026-09-22 critic audits:

- **Roswell "real article":** 14 of 35 Jev promotions were YouTube videos. The planner labelled the query `mixed`,
  so the judge's format check never enforced "article".
- **Art of Seduction "pdf":** a 38-page StoryShots summary on Scribd scored 98 % promising. Only the final judge,
  reading the page, rejected it.
- **WhatsApp "official … past 3 years":** Jev never saw dates or domains, and nothing checked whether the results
  covered all three years.

The common cause is that every stage re-reads the raw query: the planner, the screener, Jev, the judge. Criteria
are five free-text strings that only the judge sees.

## 1. The requirements contract (`src/requirements.ts`)

### Shape (zod-validated; `version: 'req-v1'`)

```ts
interface RequirementsContract {
  version: 'req-v1';
  query: string;                  // original, untouched
  search_date: string;            // ISO date the search ran; relative dates resolve against it
  intent: string;                 // one sentence
  deliverable: {formats: Format[]; completeness: 'full'|'any'};  // Format: 'article'|'video'|'pdf'|'website'|'image'|'any'
  requirements: Requirement[];
  entities: {name: string; kind: 'organisation'|'person'|'work'|'event'|'product'|'place'|'other'}[];
  exclusions: string[];           // from "-term" and "not/without X" in the query only
  ambiguities: string[];
  assumptions: string[];
  source: 'model'|'rules';        // 'rules' when the planner failed and only deterministic parsing ran
}
interface Requirement {
  id: string;                     // R1, R2, … stable within the search
  text: string;
  kind: 'subject'|'format'|'date'|'authority'|'completeness'|'property';
  hardness: 'hard'|'preferred';
  scope: 'each'|'set';            // every result must meet it, or the result set as a whole must cover it
  evidence: string;               // what would establish it, e.g. "publication date on the page within the range"
  date_range?: {from: string; to: string};           // resolved, inclusive
  formats?: Format[];
  authority?: {entity: string; domains: string[]};   // domains are hypotheses until inspected (see §2)
  set_items?: string[];           // for scope 'set': what must be covered, e.g. ["2023","2024","2025"]
  legal_limit?: boolean;          // see "Legal limit" below
}
```

### How it is built

1. **Same model call.** The planner produces it in the call it already makes. `requirements` replaces `criteria`
   in its schema, and the prompt says: never invent constraints; copy them only from the query; mark a preference
   as hard only when the query states it ("real article", "official", "pdf").
2. **Deterministic normalisation (`normaliseContract`) always runs after the model and overrides it for:**
   - **Dates.** "past/last N years|months", "last year", "this year", "since YYYY", "in YYYY", "YYYY–YYYY" are
     resolved against `search_date`. The model's own date arithmetic is discarded. "Past 3 years" on 2026-09-24
     becomes `{from: 2023-09-24, to: 2026-09-24}`, with a set requirement for years 2023, 2024, 2025, 2026.
   - **Formats.** Explicit words ("article", "pdf", "video", "clip", "footage", "website", "site", "image") become
     hard `format` requirements. Formats are never added without an explicit word.
   - **Syntax.** Quoted phrases become hard `subject` requirements; `-term` becomes an exclusion.
3. **Rules-only fallback.** When the planner fails or times out, step 2 alone builds the contract (`source: 'rules'`).
4. **Backward compatibility.** `plan.criteria` is still produced (the hard `each` requirement texts), so the
   existing trace, critic and stored searches keep working.

### Clarification

Search is asynchronous and non-interactive, so the engine **never blocks to ask**. It records `ambiguities` and
`assumptions`, and the UI shows "Interpreted as: …" with the assumptions. A clarification loop is out of scope.

### Legal limit (legal-sources-only rule)

When the deliverable is `completeness: 'full'` of a commercial work the planner identifies (a book, film or paid
media, the same test as the planner's existing piracy rule), that requirement gets `legal_limit: true`:

- It can only be satisfied by a source with an active source-policy rule or a recognised public-domain or
  publisher host.
- Otherwise it is reported as **"not available from legal sources"**, never as "unknown", and exploration does not
  chase it.
- Other requirements are still searched: publisher pages, previews, library listings, reviews labelled as such.

## 2. Evidence record (`src/evidence.ts`)

```ts
interface Finding {
  url: string; requirement_id: string;
  status: 'supported'|'contradicted'|'unknown';
  excerpt: string|null;           // exact text from the source
  location: {field: 'title'|'url'|'description'|'page'|'pdf'|'comments'|'transcripts'|'metadata'; page?: number; key?: string};
  method: 'page_fetch'|'browser_render'|'pdf_parse'|'video_api'|'captions'|'comments'|'search_snippet'|'jev'|'judge';
  access: 'ok'|'robots_disallowed'|'unavailable'|'not_permitted'|'not_fetched';
  provisional: boolean;           // true for search_snippet, jev and any model-predicted value
  confidence?: number;            // model confidence, kept separate from evidence strength
}
```

- **One record per search**, built up by every stage. It lives in the shared evidence cache (keyed by canonical
  URL) and is stored in the trace.
- **Failures are unknown:** a failed fetch, robots refusal or missing field yields `unknown` with the access status
  recorded, never `contradicted`.
- **Provisional findings** (snippets, Jev, model guesses) can steer priority and exploration. **They never make a
  result verified, and never exclude one.**

### Deterministic inspectors (no model; run on content actually fetched)

- **Format.**
  - PDF: response content type `application/pdf`.
  - Video: a known video host or watch URL, or `og:type` video.
  - Article: schema.org `Article` / `NewsArticle` / `BlogPosting` JSON-LD, `og:type=article`, or an
    `article:published_time` meta tag.
  - Detection is judged against the hard formats. A video against an article-only requirement is `contradicted`
    (excerpt: the host or `og:type`).
- **Date.**
  - Sources: JSON-LD `datePublished` / `dateModified`, `article:published_time`, `<time datetime>` inside the main
    content, video `publishedAt` from the YouTube API, PDF `CreationDate`.
  - Inside `date_range` is `supported`; clearly outside is `contradicted`; no date found is `unknown`.
  - For historical-event requirements the page date is not the event date, so those stay with the judge (§4).
- **Authority (official).**
  - `supported` requires both of these, from fetched content:
    - the page's host is one of the requirement's `domains` (or a subdomain);
    - the page itself names the entity, in `og:site_name`, the JSON-LD `publisher.name`, or the title.
  - YouTube's existing official-channel allowlist also counts as `supported`.
  - Host match alone is `supported` but `provisional`, because the domain list came from a model.
  - Anything else is `unknown`.
- **Completeness (full work vs summary / excerpt / listing).** Runs on PDF text and metadata, or page text:
  - Summary markers ("summary", "key takeaways", "book review", "StoryShots", "Blinkist", "notes on", "excerpt",
    "sample chapter", "preview") in the title or first page are `contradicted`, with that text as the excerpt.
  - A listing page with no document body is `unknown`.
  - A page count consistent with a full work and no summary markers is `supported` for PDFs.

### PDF inspection (inside the existing page checker)

- `PageChecker.check` accepts `application/pdf` (at most 15 MB).
- The bytes go to the existing Python text helper (`PAGE_TEXT_PYTHON`, the same process and venv as trafilatura),
  extended with `pypdf`. It returns page count, document metadata (title, author, creation date) and the text of
  the first 3 pages.
- `PageEvidence` gains `format`, `published`, `page_count` and `pdf_meta`.
- Without the helper, or on a parse failure, the result is `access: 'not_fetched'` / `unavailable`, and the
  findings are unknown.
- Robots and public-address rules apply unchanged.

## 3. Exploration aimed at missing requirements

### Coverage

After initial retrieval and the first inspection (deterministic inspectors plus the Jev pre-judge over the
admitted pool):

- **`each` requirements:** hard requirement R is *covered* when at least `GAP_TARGET_RESULTS` (3) candidates
  support it with **non-provisional** findings and have no contradicted hard requirement.
- **`set` requirements:** each `set_items` entry must be supported by at least one non-provisional finding.

The unmet items are the **gaps**. A `legal_limit` requirement is never a gap.

### Loop (bounded)

Each round (at most `GAP_ROUNDS`, default 2, and never past the deep-search deadline):

1. **Targeted searches:** at most `GAP_SEARCHES` (4) per round, built **deterministically** from each gap's
   requirement fields. No model writes them, so they are fast and cannot invent sources:
   - entity + subject + missing year for a date gap;
   - `site:` a hypothesised official domain for an authority gap (discovery only, never evidence);
   - the subject + "article" / `filetype:pdf` for a format gap.

   The searches go through the Brave-first provider path.
2. **Jev picks links and candidates.** Jev gets the contract, current coverage, the gap list, and each candidate's
   context: URL, domain, known format and date, snippet, and the referring page. One choice question per
   candidate: which gap it would most likely close, or `none`. It visits the best `GAP_VISITS` (shares
   `JEV_EXPLORATION_VISITS`, default 12, per search) that are not already visited.
3. **Visits:**
   - Web pages and PDFs go through the page checker.
   - Videos go through the video visitor (YouTube details, relevance-ordered top comments, links in description
     and comments; captions only through `PublicVideoEvidence` where policy permits; YouTube transcripts are never
     scraped).
   - Inspectors produce findings.
   - Outbound links from visited pages join the frontier for the next round.
4. **Recording:** each action (search or visit) records `targets: [requirement or set item]`, the result, and the
   new non-provisional findings.

### Stopping, first one wins

- All gaps are covered.
- A round adds no new non-provisional supported finding for any gap (no marginal gain).
- Round, visit, search, time or budget caps are reached.

### Other rules

- **Model-suggested sources** (hypothesised official domains, planner `site:` queries) are only ever search
  targets. They count as evidence only after being fetched and inspected.
- **Existing Jev exploration** is replaced by this loop. Its protections and trace carry over, with the
  dedupe/cycle set shared across rounds.
- **Quick searches** run 1 round with at most 6 visits. Deep searches use the full caps.

## 4. Contract through every stage

- **Planner:** produces the contract (§1). Follow-up rounds get it as context.
- **Screener (Jev):** state gains the contract's hard requirements and formats, plus URL, domain and known date for
  each lead (the 2026-09-23 evaluation's first recommendation). It still only reorders admission.
- **Screener reliability fix (from the superseded spec):** keep successful batches, 8 s timeout, one retry after a
  connection reset.
- **Admission:** a candidate with a **non-provisional** contradicted hard `each` requirement (for example a watch
  page when only an article is acceptable) is not admitted. Provisional contradictions only lower its priority.
- **Jev pre-judge (from the superseded spec, adjusted):**
  - One call per candidate; questions per requirement ID instead of the fixed four dimensions.
  - Options: snippet `sN`, `unknown`, `mismatch`.
  - Snippets come **only from inspected content** (page text, PDF text, API data, captions, comments), never from
    search snippets.
  - Jev may settle a match only when every hard `each` requirement is backed by such a snippet, and no
    deterministic finding contradicts it.
  - Would-reject verdicts stay in shadow (`JEV_JUDGE_REJECT=false`) and are forwarded to the LLM judge.
  - Jev confidence is stored as `confidence` on its findings, never as evidence strength.
- **LLM judge:**
  - The prompt gets the contract.
  - Its output replaces the four `intent_checks` with `requirement_checks: {id, status, field, quote}` for every
    hard `each` requirement. The same quote-grounding rule applies (`groundedIntent` generalised to requirements).
  - Deterministic non-provisional findings are passed in and **override** the judge on the same requirement.
    Inspected evidence beats prediction.
- **Decision rule (per candidate, hard `each` requirements):**

  | Evidence | Outcome |
  |---|---|
  | Any hard requirement contradicted by non-provisional evidence | Excluded, with the reason shown ("Video, but an article was requested") |
  | All hard requirements supported by non-provisional or grounded-quote evidence | **Verified**; ranked by relevance, then coverage of preferred requirements |
  | Otherwise (some hard requirements unknown) | Not verified. Kept under *Closest matches*, listing what is unconfirmed; eligible for gap exploration |

  Relevance (0–10, evidence ceilings unchanged), `coverage` (supported hard / total hard) and `model_confidence`
  are stored as **three separate fields**.
- **Ranking:** `RANKING_VERSION` becomes `relevance-v6-requirements`. Verified results come first by relevance; ties
  break on preferred coverage, then evidence strength (inspected over metadata).
- **Presentation (`public/results.js`, API):**
  - **Search header:** "Interpreted as" (intent plus hard requirements), assumptions, and **unmet requirements**
    (set gaps such as "No official source found for 2023", and legal limits).
  - **Each result:** the existing "Why this matches" reason, plus requirement chips (supported ✓ / unconfirmed ?),
    each with its excerpt on hover.
  - **Material uncertainties** appear under the result, e.g. "Date not found on page".
  - **API:** `result.requirements[]` (`{id, status, excerpt, method}`), plus `search.contract` and `search.unmet`.

## 5. Trace, settings, failure handling

### Trace (no migration; `search_traces` JSON)

- `trace.contract`
- `trace.pool[i].findings` and `.jev`
- `trace.gaps`: per round, the gaps, actions with targets, visits and new findings, and the stop reason

### Metrics

- `requirement_satisfaction`: the share of hard requirements covered by the shown set.
- `unknown_rate`: unknown findings / all findings on shown results.
- `coverage_gain_per_visit`: newly covered gap items / gap visits.
- `gap_visits`, `gap_searches`.
- `jev_settled`, `jev_forwarded`, `jev_would_reject`, `jev_reject_agreement`.
- `latency_ms` by stage.
- `model_calls` by model, plus `brave_calls`, with an estimated cost from configured unit prices.

### Settings

| Setting | Default | Notes |
|---|---|---|
| `REQUIREMENTS_ENABLED` | `true` | `false` reproduces current behaviour (baseline for evaluation) |
| `GAP_EXPLORATION` | `true` | `false` is the ablation |
| `GAP_ROUNDS` / `GAP_SEARCHES` / `GAP_TARGET_RESULTS` | 2 / 4 / 3 | |
| `JEV_EXPLORATION_VISITS` | 12 | Replaces `JEV_EXPLORATION_PAGES` (old name read for one release) |
| `JEV_JUDGE_ENABLED` / `JEV_JUDGE_REJECT` / `JEV_JUDGE_CONFIDENCE` | `true` / `false` / 0.8 | |
| `JEV_JUDGE_CONCURRENCY` / `JEV_JUDGE_TIMEOUT_MS` / `JEV_JUDGE_DAILY_BUDGET` | 12 / 6000 / 3000 | |
| `JEV_SCREEN_TIMEOUT_MS` | 8000 | |
| `PDF_MAX_BYTES` | 15 MB | |

### Failure handling

Every new step degrades to current behaviour and never drops a result because of its own failure:

- Planner failure → rules-only contract.
- Inspector failure → unknown.
- Jev failure → forward to the LLM judge, or skip the link.
- PDF helper missing → `not_fetched`.

Budget exhaustion is reported in provider status and health.

## 6. Tests (TDD, offline; recorded fixtures, no live calls)

- **Contract:**
  - "past 3 years" resolves against the search date and produces set items;
  - explicit formats become hard; nothing is invented from a bare topic;
  - the rules-only fallback works;
  - the contract reaches the screener, Jev, judge and trace (propagation).
- **Inspectors:**
  - JSON-LD article vs a YouTube watch page vs a PDF;
  - date inside, outside and missing;
  - official status needs both host and page naming; a host match alone is provisional;
  - summary markers in a PDF contradict "full book".
- **Regression behaviours:**
  - "robert greene art of seduction pdf": a summary PDF (fixture modelled on the StoryShots document) cannot be
    verified, and "full copy" is reported as not available from legal sources;
  - "rosswell ufo incident real article": videos cannot satisfy the article-only requirement;
  - "official whatsapp chat ui interface from over past 3 years": official status and dates require evidence; a
    result without a found date is unconfirmed, not verified; the set gap for an uncovered year is reported.
- **Conflicting evidence:** the judge says supported, the inspector says contradicted → contradicted wins. Two
  pages disagree → each result keeps its own findings.
- **Inaccessible pages:** robots refusal, 403, timeout → unknown, never excluded.
- **Scope:** a `set` requirement is not demanded of each result; an `each` requirement is.
- **Bounded exploration and stopping:** caps on rounds, visits and searches hold; the loop stops when gaps are
  covered, when a round adds nothing, and at the deadline; no URL is visited twice; exploration never visits
  model-suggested domains directly without discovery.
- **Failures:** planner down, Jev down, PDF helper missing, budget exhausted.

## 7. Evaluation

- **`evaluation/requirements-queries.json`:** the three regression queries plus a **harder multi-source task** that
  tests result-set coverage: *"timeline of the James Webb Space Telescope deployment with official NASA, ESA and
  CSA sources"*. Its set requirements are an official source from each agency, dated December 2021 – July 2022.
- **`scripts/evaluate-requirements.ts`** runs each query once through three configurations, with a hard cap of
  **12 live searches total** (4 queries × 3) and existing daily budgets:
  - **baseline:** `REQUIREMENTS_ENABLED=false`;
  - **new:** everything on;
  - **ablation:** `GAP_EXPLORATION=false`.
- **Recorded per run:** shown results with findings, requirement satisfaction, unknown rate, coverage gain per
  visit, latency by stage, model and Brave calls, and estimated cost.
- **Ground truth stays separate:**
  - the script writes `…review.json` templates for a human reviewer to grade (0 / 1 / 2 per URL, with reasons);
  - verified-result precision is computed **only from human grades**; where none exist, the report says
    "not human-graded";
  - any assistant review is labelled as such;
  - model agreement is reported as agreement, never as accuracy.
- **Report:** `output/requirements-evaluation-2026-09-24.md`, covering improvements, regressions and limitations.

## Out of scope

- The deep-search timing work (parked).
- An interactive clarification loop.
- Scraping YouTube transcripts.
- A Sonnet 5 judge trial.
- Niche-first routing (`2026-09-22-niche-first-search-design.md`, independent).
