# Deep web discovery

## Scope and rollout

Branch `deep-web`, based on `cited-answers`. Add discovery of public specialist databases and site search to Web and Docs, with no UI changes, Tor, paid APIs, deployment, or live searches during implementation. `DEEP_SOURCES=0` is the default and preserves existing behavior. Enable with `1` after migration and offline integration tests.

## Retrieval

`src/deep-sources.ts` provides a registry with name, fields, tabs, and asynchronous search returning SourceRow arrays. Select by the existing route.field, at most three eligible connectors, five unique rows each. Missing credentials silently remove an entry before selection. Connector requests use `deep:<name>` daily budget buckets (default 200 each). A shared 4,000 ms deadline includes budget checks and all subrequests; independent connectors and site searches start alongside Brave and SearXNG. Partial successes survive failures.

Connectors: Europe PMC; ClinicalTrials.gov v2; OpenAlex; DOAJ; CourtListener; SEC EDGAR full-text; GovInfo; Federal Register; CKAN portals for data.gov, data.gov.uk, open.canada.ca and data.europa.eu; Library of Congress including Chronicling America; Europeana; Open Library; Hugging Face Hub; Stack Exchange; GDELT DOC. Multi-endpoint connectors merge results fairly within their five-row allowance. Credentials are environment settings, never included in returned rows. SEC requires an identifying User-Agent. APIs that now require a free key must be skipped when it is absent. Endpoint availability and free access must be confirmed by the operator before rollout; no paid fallback.

Deep rows and routed Brave rows share a 16-row allocation in the existing review pool (10 with the flag off), interleaved to avoid source starvation. Scores are unchanged; results go through existing filtering, verification and judging. Docs file URLs enter document verification; record pages become hunt sites, following DOAJ. Provenance survives document hunting so final verdicts can credit the originating site search.

## Site search

`src/site-search.ts` tries at most two routed domains without an eligible connector. Discover an HTML OpenSearch link and a same-site GET text/html URL template, then cache the outcome in `site_search(domain, template, status, checked_at, hits, good)`. Positive and absent descriptors are cached for seven days. Rejected templates remain disabled until an operator replaces them. Hand-added same-site GET templates for RBI, SEBI, eGazette and Elephind use this same table; no guessed endpoints ship as enabled templates.

Validate all URLs with the existing public URL and DNS protections; do not trust discovered origins. Respect robots.txt before fetching homepages, descriptors and search pages. Parse and deduplicate same-domain result links, excluding the search page, navigation links and unsafe URLs; retain five. Unsupported descriptors, denied crawling, timeouts and failures preserve Brave site: fallback. Connector-covered domains retain existing Brave site: discovery but do not also crawl site search.

## Reliability and learning

A process-local circuit breaker disables a connector or domain after three consecutive failures for 30 minutes. Success resets its failure streak. Missing keys, exhausted budgets, absent descriptors and robots denials do not count as upstream failures. State is bounded and restart resets it. Every network operation has a deadline; late completion cannot publish rows or change circuit state.

Existing relevance >=8 verdicts credit field_sources. Site-search hits count judged rows attributable to a template, including poor verdicts; good counts verdicts >=8. This makes good/hits a judged precision rate, independent of unjudged candidates. At more than 20 judged hits and good/hits <0.10, clear the template and set status=rejected. Attribution includes the template version to prevent late verdicts from penalizing a replacement. Cache writes and learning failures never fail a search. Tables use constraints, parameterized queries and explicit runtime grants.

Probe at most five top candidates, within a separate shared 4,000 ms rescue deadline. Only HTTP 404/410 or a distinguishable DNS failure triggers the Wayback availability API. Validate an available successful snapshot belongs to the requested original URL and to web.archive.org before replacing the result URL. Preserve original provenance and document metadata; snapshots still receive normal verification/review. No rescue for 403, 429, general network failure or robots denial. Archive calls have their own daily bucket and breaker.

## Validation and evaluation

Fixture-only tests cover all connector parsers, request construction, selection/caps, key skipping, malformed/empty responses, timeout and partial success, circuits and budgets; descriptor parsing/cache/robots/fallback/learning; Wayback rescue and non-rescuable failures; Web/Docs integration and flag-off behavior. Fixtures are reduced checked-in API-format examples, with provenance notes; no tests require network credentials.

Add an opt-in evaluation script that runs both flag values against Web/Docs queries indexed by evaluation/field-labels.json and evaluation/field-queries.json. Report model-judged good results/query, judged precision, human-label precision and label coverage separately, plus time to first nonempty result and completion time. Do not claim unlabeled discoveries are wrong or treat this as exhaustive recall. Use isolated evaluation databases/state for each variant, alternate run order, preserve per-query output, and never start/restart PM2. The evaluation is not run during implementation.

The request also says both to run npm test and to leave all tests until integration. Follow its final instruction: author tests but do not execute them; run the non-network TypeScript check. Record this limitation in the final handoff.

## Implementation notes and operator handoff

- Apply `migrations/019_site_search.sql` with the normal migration workflow before enabling `DEEP_SOURCES=1`. It includes explicit `search_app` grants. No migration was applied to a running database during implementation.
- Optional free credentials: `COURTLISTENER_API_KEY`, `DATA_GOV_API_KEY` (GovInfo), `EUROPEANA_API_KEY`, and `OPENALEX_API_KEY`. Set `SEC_USER_AGENT` to your app/organisation and contact email. Each missing credential skips its connector silently. OpenAlex uses an account's free daily allowance; do not add prepaid usage for this feature. There is no paid fallback.
- Existing field routing must be enabled and configured (`FIELD_ROUTING_ENABLED`, `FIELD_ROUTING_SITES`, `QUERY_REWRITE_MODEL`, and its existing model credentials). `DEEP_SOURCES` does not change routing models or introduce a paid discovery provider.
- API documentation confirmed that Chronicling America now uses LOC's collection endpoint, and the current EU catalogue provides SPARQL. The CKAN connector therefore queries three CKAN portals plus the EU SPARQL catalogue. No legacy Chronicling America or guessed EU CKAN endpoint is used.
- Source circuits are per process and restart resets them. Budgets and template learning live in Postgres. Site budget units cover a search attempt (robots/home/descriptor/results); connector budget units cover HTTP requests, including each multi-portal subrequest.
- Site requests do not follow redirects automatically. This avoids fetching a redirect destination before checking its robots rules; a redirecting site falls back to Brave. Add a verified template on the destination host under the routed domain where appropriate. Only same-domain HTML GET OpenSearch templates are supported; POST/JS-only search is left to Brave.
- Hand-add verified templates with `node --env-file-if-exists=.env --import tsx scripts/site-search-template.ts <domain> '<verified URL containing {searchTerms}>'`. Supported operator domains are RBI, SEBI, both eGazette domains and Elephind. This resets previous template quality counters and clears rejection. No endpoints for these sites were guessed or enabled.
- No UI assets changed. The existing provider status format reports deep-source results. Record pages seed the Docs hunt; its nested web lookup disables deep retrieval to avoid spending a second three-connector/two-site allowance for the same request.
- Fixture files in `tests/fixtures/deep-sources/` are reduced documentation-derived contracts, **not freshly recorded live responses**. Tests never call the services. Obtaining real response recordings remains an operator integration task under the no-live-search constraint; authenticated contracts and current endpoint behavior are unverified.

### Evaluation command (not executed)

```powershell
node --env-file-if-exists=.env --import tsx scripts/deep-sources-eval.ts --run
```

This is explicitly opt-in and makes live searches when the operator runs it. It never connects to the production database or manages PM2. It uses the intersection of Web/Docs query IDs and `evaluation/field-labels.json`. Optional `DEEP_EVAL_IDS` narrows IDs and `DEEP_EVAL_TIER` chooses the existing tier. Optional `DEEP_EVAL_SEED` points at a JSON object with `field_sources` and `site_search` arrays exported by the operator; both variants get identical initial learning. Without a seed they start with no learned domains/templates. All variants disable cited-answer generation so completion measures retrieval and review.

Each query gets fresh caches, circuit state and an isolated in-memory migrated database. This also resets provider budgets between cases; run it at a volume appropriate to your free provider quotas. Results go to a new `output/deep-sources-eval/<timestamp>/` directory. Reported precision is macro-averaged among returned judged rows. Human precision excludes unlabelled results, and label coverage is shown separately. First-result timing measures the first nonempty API response, including initial unjudged candidates; empty queries have null timing. Completion waits for review/hunt and records failures, which are excluded from paired comparisons. It does not estimate exhaustive recall.

References: [LOC migration](https://www.loc.gov/apis/additional-apis/chronicling-america-api/), [EU catalogue API](https://data.europa.eu/en/about/sparql), [OpenAlex free allowance](https://help.openalex.org/access/pricing/), [GovInfo API keys](https://www.govinfo.gov/features/api), [SEC User-Agent guidance](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).
