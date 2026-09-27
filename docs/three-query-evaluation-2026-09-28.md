# Live engine evaluation — 28 September 2026 (IST)

Ran the three requested queries through the running engine at `http://127.0.0.1:3000`, using SSJ3 and normal provider budgets. Video requests used `mode=refresh`; both began in `discovering` state and were polled to completion. The web request was polled through its background review. These were actual provider-backed searches, not fixture tests or a replay of the September 26–27 reports.

[Raw capture](../output/three-query-probe-2026-09-27T22-37-56-312Z.json) · [Runner](../scripts/probe-three-queries.ts)

## Deployment and budget context

Migration `014_scene_verification.sql` is **not applied** in the running database. API and Node worker heartbeats report startup at `2026-09-27T11:48:49Z` and `11:48:50Z`. Neither video response includes the new scene-verification revision/status contract. This evaluates the running deployment, not the recently implemented local scene workflow.

The daily `scene_analysis_requests` counter was **60**, matching the configured limit of **60**; automatic job admission was only 9. The scene-worker log records a newly queued job, `3e23acc5-8b7a-40c9-a203-9c12281f0612`, deferred with `budget_exhausted` at `2026-09-27T22:38:54Z`. Queue admission therefore remains possible when actual model execution has no budget. Merely increasing worker concurrency will not resolve this state.

No budgets were reset, migrations applied or services restarted during the evaluation. Existing retained transcripts and scenes were available, so this is not a cold-cache latency measurement.

| Query | Time to captured final response | Returned results | Evaluation |
| --- | ---: | ---: | --- |
| Falcon Heavy simultaneous side-booster landing | 55.7 s | 4 | **Fail:** wrong mission ranked first; requested original footage remains visually unverified |
| Hindi UPI explainer, under ten minutes, excluding big news channels | 108.4 s | 2 | **Partial:** useful Hindi results within duration, but exclusion omitted from the requirement contract |
| Cooked rice refrigerator safety | 55.2 s | 26 | **Fail:** secondary/commercial pages dominate; relevant primary authorities remain below rank 17 |

## Falcon Heavy: coverage plus event identity

The first result is [Galaxy Central's “SpaceX Lands All 3 Falcon Heavy Boosters for the First Time”](https://www.youtube.com/watch?v=sf4qRY3h_eo), scored **9/10**. Its judgement explicitly describes April 11, 2019 and its event requirement is marked supported by the excerpt `April 11th 2019`. The second result, [CNN's all-three-boosters report](https://www.youtube.com/watch?v=HVqWEoyiaBA), scored **8/10**, likewise describes the April 2019 mission.

The requested demonstration/test flight was February 6, 2018, as documented by [SpaceX](https://new.spacex.com/mission). This is an event-identity failure, not merely a missing scene analysis. The first result already has retained scene observations, including a dual landing at 450–490 seconds, but they belong to the wrong mission. Its first displayed scene starts at six seconds and describes liftoff, showing a second problem: generic chronological moments are not the requested moment.

The official [SpaceX “Falcon Heavy Test Flight” replay](https://www.youtube.com/watch?v=wbSwFU6tY1c) was discovered but placed among closest matches at **5/10**. It has three transcript passages and **zero analysed scenes**. A viewer points to **29:45**, but that is only a locator, not a verified timestamp. The engine correctly names synchronous touchdown as unconfirmed on this candidate, while inconsistently marking that same requirement supported by comments on other results. Its overall interpretation nevertheless reports no unmet requirements.

**Required fixes and acceptance conditions:**

- Planner: resolve the named mission to a stable event identity and date, distinguishing the 2018 demonstration from later Falcon Heavy launches. A date referring to another mission must contradict the event requirement.
- Screener/pre-judge: preserve the official replay as an inspection candidate; do not let an already-analysed but wrong mission displace it.
- Scene worker: inspect a transcript/comment-located interval around the potential landing and return original-video timestamps and observations of both boosters. Comments and narration are locating evidence only.
- Judge: require visual evidence for simultaneity and separate evidence for mission identity. A valid quote can still be semantically incompatible with the request.
- UI/ranking: lead with the supported landing interval, not an unrelated launch scene. Pending or exhausted-budget inspection cannot count as verified.

This query alone does not establish performance without dialogue: the live run used transcripts and comments. A dedicated visual-only variant must withhold dialogue evidence from the final visual decision. The phrase “without dialogue” in the test description should not become an unintended requirement that the returned video be silent.

## UPI: useful results, incomplete constraint enforcement

The first result, [Infomax Computer Academy](https://www.youtube.com/watch?v=kSX7to1oJro), is **5:15**, has `language=hi`, scores **9/10**, and includes Hindi transcript evidence about how the transaction works. This is a promising match supported by the captured evidence.

The second result, [Humsafar Tech](https://www.youtube.com/watch?v=td8DEynyoK4), is **5:48**, has `language=hi`, and scores **8/10**. Its evidence chiefly explains UPI IDs and money reaching bank accounts; the capture supports a narrower account/identifier explanation more strongly than a detailed transaction-mechanics explainer.

No obvious large news channel appears in the two returned results. However, the requirement contract lists only duration, Hindi and how UPI works. **“Not from big news channels” is missing entirely**, although it appears loosely in the intent sentence and verdict reasons. The earlier saved run waived this exclusion; this run drops it. Neither behavior establishes reliable filtering.

Discovery found **79 candidates**, screened all 79 and checked 60, so inadequate breadth is not demonstrated by this run. A 1:58 Kotak Neo explainer remains in closest matches at 5/10 despite all three recorded requirements being supported; its stored language is `en` while the judge cites Hindi transcript text. That inconsistency warrants inspection of language provenance and the final decision trace; the capture alone does not establish the exact cause of demotion.

**Required fixes and acceptance conditions:** preserve every explicit exclusion as a hard requirement; verify channel identity/classification with retained evidence; enforce duration strictly below 600 seconds; reconcile platform language metadata with actual speech evidence; distinguish transaction mechanics from merely defining a UPI ID. Unknown channel classification should remain visible as uncertainty.

“Not a big news channel” does not itself prove a creator is lesser-known. Evaluate creator diversity separately instead of inferring audience size from an unfamiliar name.

The engine also queued scene analysis for this query. A transcript-supported conceptual explanation should not automatically consume scarce scene budget unless an unresolved visual requirement actually needs it.

## Rice: authority retrieval is insufficient without authority-aware ranking

The top results were Food & Wine, Red Beans & Eric, New York Times, Better Homes and Gardens, and Reencle, all scored **9/10**. The top ten contain no direct government food-safety guidance. These pages should not be labelled AI-generated merely because they are secondary or commercial; authorship was not established by this test.

The refill planner explicitly noticed the missing authoritative food-safety guidance, ran two searches and retained three further pages. Nevertheless:

- FDA refrigerator/freezer storage chart ranked **18**, score **5**.
- FDA safe-storage guidance ranked **19**, score **5**.
- USDA's “How long will cooked food stay safe in the refrigerator?” ranked **20**, score **5**.

The judge's reasons largely reward direct lexical answers about rice while demoting broader official guidance as insufficiently rice-specific. There is a legitimate relevance distinction here: an official but unrelated page should not win automatically. The missing behavior is to retrieve and inspect a relevant primary passage, then rank source authority and evidential support alongside topical relevance.

Direct rice-specific authority does exist: the [Food Standards Agency's rice guidance](https://www.gov.uk/government/publications/home-food-fact-checker/home-food-fact-checker#rice) addresses storage, cooling and reheating explicitly. [USDA's shelf-stable food table](https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/shelf-stable-food) also includes cooked rice/pasta storage guidance; search indexing surfaced the table, but direct retrieval returned HTTP 403 during this audit. The engine should expose such retrieval limitations rather than invent inspected support.

**Required fixes and acceptance conditions:** identify food-safety intent in planning; reserve primary-source discovery; follow and verify claimed authority citations; extract the relevant passage/table; rank relevant primary evidence above unsubstantiated secondary claims. Keep jurisdiction and storage conditions attached to recommendations because authorities can give different guidance. A blog saying “USDA-backed” must not inherit USDA's authority without verification.

## Priority

1. Activate the already implemented scene workflow and address the exhausted provider-attempt budget before benchmarking its latency. Do not treat migration alone as a quality fix.
2. Enforce event identity and visual evidence types across planner, pre-judge and final judge; prioritise scene work only where it can resolve a missing visual condition.
3. Preserve and audit explicit exclusions end to end. The local contract/unknown-state changes are relevant but require a deployed rerun.
4. Add explicit source-quality evaluation for high-stakes web requests, with targeted primary-source extraction and quality-aware ordering.

A larger judge alone does not address these failures. The evidence supplied, the requirement types and the deterministic decision/ranking rules need to agree. This evaluation changed the capture tooling and documentation only; it did not implement the additional quality fixes above.
