# Discovery coverage and relevance

Discovery collects answers from fast and slow sources before selecting its candidate pool. No provider gets display slots by answering first. The worker renews its fenced job lease during network waits and AI checks.

After deduplication, up to `DISCOVERY_CANDIDATES` (60 by default, configurable to 250) are checked, about five judge calls. This is a cost bound, distinct from the number displayed. Leads that match at least half of the search that found them fill the pool first; looser leads and semantic guesses only fill what remains. When exceeded, the response reports a partial candidate-pool check. Quoted phrases and exclusions remain enforced. Semantic candidates without literal query words can reach the judge; when no judge is configured, lexical matching remains the fallback. Duplicate URLs keep the metadata that best matches the original query, independent of response order.

The final display limit applies **after** relevance checks. Results sort by descending judged relevance, then supporting evidence and deterministic keyword order for ties. Arrival time, obscurity and popularity confer no ranking bonus. Unjudged results follow judged matches; skipped judgements and failed batches are reported. Relevance scores of 0–4 are removed. When every result is rejected, up to five scoring 3–4 are shown as `Closest match`; scores of 0–2 never are. Scores describe estimated relevance from available evidence, not independently verified factual accuracy or inspection of unseen footage.

A deep dive rechecks its previous quick finds together with new finds. Its better matches can move to the top. Catalogue items matching discoveries receive their checked details; remaining catalogue items follow the checked results. The browser displays one combined list, not separate quick/deep groups. `ranked` contains the full visible snapshot in display order; `results` remains paginated. Completion can change positions, so consumers should refresh their first page or use `ranked` when the job finishes. Catalogue-only pagination remains stable.

## Specialist coverage

Deep discovery supplements AI plans with up to `SPECIALIST_SEARCHES` (3) topic-specific web searches. Film/animation routes include filmmaker showcases; research routes include university and lecture collections; computing routes include conference recordings; historical routes include institutional archives. Unknown topics stay with the AI and existing engines. An explicit `site:` scope is not broadened by these routes.

`ARCHIVE_DISCOVERY=true` adds direct [Internet Archive advanced search](https://archive.org/advancedsearch.php), restricted by default to `ARCHIVE_COLLECTIONS=prelinger,ephemera`. The collection and title/description/subject constraints avoid the noise observed in unrestricted archive search. Configure reviewed collection identifiers to expand that scope. This is native catalogue search, not Wayback crawling.

The [Library of Congress film API](https://www.loc.gov/apis/json-and-yaml/requests/endpoints/) is implemented but defaults to `LIBRARY_OF_CONGRESS_DISCOVERY=false`: the live API check on 21 September 2026 rejected access. Enable it only after checking availability from your deployment. It requests online video entries and returns individual item pages.

Both adapters request at most `DEEP_PAGES` pages per job, 30 records per page, with `PROVIDER_TIMEOUT_MS` deadlines and a separate per-provider `ARCHIVE_DAILY_BUDGET` (200). They need no API keys. Provider failures preserve other results. Search time limits stop additional requests; already launched requests settle before ranking, within their individual timeouts. Deadline exhaustion is reported as partial coverage, not complete discovery.

Follow-up planning receives names and descriptions from search results, plus page text and up to eight named public references from a bounded sample of promising pages. Those checks reuse the `PAGE_CHECKS` budget and cache; final judging reuses their evidence. Links supply leads for targeted searches, not permission for unrestricted crawling. Video pages outside YouTube can now supply page evidence too.

Discovery grants no source approval, media access, transcript retention or reuse rights. Native catalogue records retain unknown availability and rights unless the existing source policy and metadata establish otherwise. Year-only historical dates remain unknown rather than becoming invented timestamps.

## Verification

Run `npm run build` and `npm test` for the deterministic suite. The regressions cover delayed specialist responses, reversed arrival order, semantic matches, quick/deep reranking, rejected results, missing verdicts, archive parsing, source failures, budgets and safe references.

Run `node --import tsx scripts/check-specialists.ts moon` for a read-only live API check. It does not read credentials or write catalogue data and returns a failing exit code if either API is unavailable. Live results and access vary; automated fixture tests cannot establish relevance quality for every real query.
