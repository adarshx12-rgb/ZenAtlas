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
