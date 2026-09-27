Cascade architecture review — 27 September 2026

Recommendation: retain Jev and the cheap-scorer/strong-judge cascade, but route missing evidence to inspection before escalating reasoning. Give every tab the same atomic requirements and typed evidence contract. The local evidence supports this direction; it does not establish a superior replacement model or a measured improvement from the proposed changes.

Scope: inspected current source, model configuration keys, the September 23 Jev report, September 24 requirements comparison, September 26 task and four-tab probes, September 27 tier/architecture benchmarks, and both September 27 SSJ3 suites. No production settings or application code were changed. The latest suite is `output/ssj3-suite-2026-09-27T11-12-22-204Z.json`. Model names below describe local configuration and recorded runs, not an independent current-provider availability audit.

**What runs today**

The discovery/video pipeline combines ensemble planning, a normalized requirements contract, retrieval and gap exploration, Jev screening, evidence collection, Jev pre-judging, the ordinary judge, and selective strong judging. Jev screening changes admission order without deleting candidates, preserving every fourth pick from the original order. Keep this exploration lane.

The configured planners are `google/gemma-4-31b-it`, `mistralai/ministral-14b-2512`, and `inception/mercury-2.5`. They run concurrently; the leading successful plan supplies intent and requirements, while search queries are interleaved. This is query diversity, not consensus over the requirements. Assists that miss their deadline can continue spending because the work is not cancelled.

The configured scorer starts with `google/gemini-3.5-flash-lite`, with Gemini 3.8 Flash, GPT-4.1 mini, and Qwen3 VL fallbacks. The default strong seat starts with `openai/gpt-5.6-terra`, followed by Mistral Medium 3.1 and GPT-5.4 mini. The default Jev seat is `typesafe/jev-1.13`. Production escalation covers scores 4–7, evidence conflicts, confident scores lacking support, unsupported Jev rejections, and a 10% sample of settled results. The strong verdict replaces the first verdict; failed rechecks retain the first score.

The tabs do not share the whole pipeline:

| Tab | Actual integration |
|---|---|
| Videos/discovery | Full planning and per-requirement evidence decisions; captions/scenes may arrive after the initial search. |
| Web | Shared review helper; one broad R1; Jev rejects enabled, settling disabled by default; cheap judge, cascade, then optional refill. |
| Docs | Shared review helper; one broad R1; Jev rejects and settling enabled; document hunting and extraction. |
| Images | First 24 thumbnails; generic website judge and cascade; no shared requirements, Jev screener, or Jev pre-judge in image review. |

Source anchors: `src/planner.ts:135`, `src/screener.ts:24`, `src/jev-judge.ts:60`, `src/cascade.ts:35`, `src/review.ts:33`, `src/web-review.ts:35`, `src/doc-review.ts:125`, `src/image-review.ts:25`.

**What the results establish**

Latest SSJ3 suite, three distinct queries per tab, including refill review passes:

| Tab | Mean wall time | Mean logged model cost | Candidates escalated | Strong seat share of logged cost |
|---|---:|---:|---:|---:|
| Videos | 80.5 s | $0.278 | 76/151, 50.3% | 58.2% |
| Docs | 66.8 s | $0.123 | 43/89, 48.3% | 55.2% |
| Web | 58.6 s | $0.176 | 93/127, 73.2% | 83.6% |
| Images | 32.9 s | $0.093 | 52/72, 72.2% | 71.8% |

These are small-sample operational measurements, not accuracy estimates. Costs come from the suite's model_cost logs and exclude unlogged Jev decisions, search APIs, scene/transcription work, and other infrastructure. Log attribution is by time window rather than search ID, so overlapping/background calls can affect attribution.

The best cheap-first offline variant recorded 100% binary labels, 94.1% pair preferences, $0.00826/case and 7.9 s median. The three-run council comparison recorded 98.9%, 92.2%, $0.01298 and 10.6 s. That is approximately 36% lower case cost and 26% lower median latency across those recorded configurations, not an end-to-end saving guarantee. The expensive Terra-first/Gemini-Pro variant obtained 100% labels and pairs but cost $0.02694/case and took 15.7 s median. Earlier cascade variants had only 93.1–96.6% label accuracy: routing policy matters.

The benchmark has 29 unique candidates across six cases, repeated three times, and only three cases with explicit requirements. It has no image case or visual inputs. Thresholds were tuned on these cases, so this is development performance, not held-out evidence. The benchmark also implements its own cascade rather than calling production cascadeReview: unsupported Jev rejections go to the cheap scorer in the benchmark but directly to Strong in production; audit handling and unbacked-score thresholds differ. Web production disables settling, unlike the cascade benchmark. Compare `scripts/judge-arch-bench.ts:57` with `src/cascade.ts:35`.

The older tier comparison used the council and an automated Sonnet grader. SSJ3, SSJ3-lean, and SSJ1 had mean grades of approximately 1.67, 1.70, and 1.68 out of 2 on different returned lists, with mean logged costs $0.143, $0.093, and $0.027. It supports testing cheaper routing; it does not prove SSJ1 has equal recall or equally handles every modality.

**Result quality by tab**

Videos: the latest Jobs query puts an official Archive clip first and now includes inspected scenes and transcript passages, an improvement over September 26's mostly metadata/comment matches. However, some returned transcript timestamps look inconsistent with their text and deserve a separate alignment test. The Falcon Heavy results include an item whose own reason identifies the Arabsat-6A launch while marking the requested test-flight requirement supported. That is a specific event-identity inconsistency, not something a broad topical score resolves. UPI returns a promising 5:15 Hindi academy explainer, but the exclusion of large news channels is marked waived, not proven. Earlier empty cat/slow-motion and MKBHD results establish failed verification, not proof that no relevant video exists.

Docs: MapReduce finds the Google Research original, but mirrors also get 9–10, indicating duplication and canonical ranking need work. RTI returns Hindi text and government copies, alongside a Scribd copy scored 10; completeness and source identity deserve independent checks. GDPR results identify Article 17, but secondary discussions dominate the first ranks. This review assesses retrieval behavior, not independent legal correctness.

Web: the repo-rate search finds the official RBI data portal, which is positive, but also scores an April-dated claim as current in a September run. That does not prove the numeric rate is wrong; it shows insufficient evidence of freshness. The rice search assigns 10 to secondary pages that claim authority; the saved traces do not independently substantiate those claims. The database-comparison query returns mostly score-5 pages whose own reasons say firsthand operation, write-heavy relevance, or non-vendor status is unverified. Those should remain explicitly labeled possible leads rather than established matches.

Images: the bicycle search retains two score-5 images, both with unverified requested details. Everest retrieves useful license metadata but only 4/24 thumbnails are seen and 24/24 candidates are escalated. Another opinion on the same missing image cannot establish its contents. The population query ranks several graphics 9–10, yet the exported `ai:false` is produced using `!!r.ai_generated`; false therefore includes missing provenance. It does not establish that an image was made without AI. Repeated pages also appear multiple times.

Historical warning: the September 23 Jev report records 40% video promotions for an article request and a summary promoted as a full-book candidate at high confidence. The September 24 requirements comparison explicitly says human_judged=false; the new variant showed zero results while classifying all 60 candidates uncertain and none excluded. Treating unknown as rejection creates empty-result regressions. Current code has improved some of those paths, so these are historical lessons, not claims that every old defect persists.

**Specific implementation gaps**

1. A Jev rejection is not actually backed by an identified contradiction snippet. Its response offers the categorical choice `mismatch`, then creates checks with empty quotes. cascade.flagsFor trusts that label and confidence and bypasses review. The test named “rejections stand only on a mismatch snippet” also passes without a snippet. Require a contradiction evidence ID before final rejection.
2. Quote grounding tests substring presence, not whether a quote entails the requested claim. A page title can be an exact quote yet fail to prove a full document, event identity, non-vendor status, or historical coverage. Jev settles can also bypass the ordinary judge's intent checks. Evidence needs claim-specific eligibility and provenance.
3. Images are represented as websites. The judge's grounding enum has no visual observation field; a screenshot observation cannot pass textual substring validation unless its assertion also appears in text. This can cap correct visual judgments at 5 while letting a convenient title appear better grounded. Only JPEG thumbnails are accepted; other valid formats are silently unseen. The saved logs do not reveal how many individual failures were caused by each fetch/format issue.
4. Web and Docs collapse the request into one R1 and truncate it at 150 characters there. Their screener call also omits the available ScreenContract. Images have no requirement array. These are structural reasons that Jev, planner, and judge can disagree about the task.
5. All score-5 uncertainty is not equivalent. Missing pixels, an unavailable PDF, unresolved event identity, or two reasonable readings of inspected evidence need different next actions. A single numeric band causes excessive strong calls.
6. Jev snippets are capped at 40 and selected in source order, with page text before transcripts and scenes. Long pages can crowd out more relevant modality evidence. Use requirement-aware selection and source quotas, preserving timestamps/page numbers.
7. Canonical preference largely depends on prompts and URL heuristics. The model's instruction to cap mirrors is not a general deterministic ceiling. Rank works separately from their copies; group duplicates and show alternatives.

**Proposed architecture**

Planner → shared atomic contract → retrieval → Jev screener → evidence collectors → Jev pre-judge → route by evidence state → cheap judge or targeted inspection or strong judge → deterministic requirement checks → list ranking and coverage feedback.

The contract should preserve original-query spans and separate subject, relationship/event, format, language, duration, completeness, date, authority, reuse terms, and provenance. Distinguish per-result requirements from set coverage. Do not add requirements merely because an assistant planner suggested them.

Each evidence record should reference the candidate, content hash, source field, excerpt or observation, page/time/region, inspection time, and the requirement it supports or contradicts. A vision observation should identify the actual inspected image/frame and region, without pretending it is a text quote. Metadata and comments retain their weaker provenance.

Use Jev's structured decisions to choose among:

| State | Next action |
|---|---|
| Clear support with eligible evidence for every hard requirement | Accept provisionally; stratified audit of settled cases. |
| Explicit contradiction with evidence reference | Exclude; also audit a sample of rejections. |
| Missing evidence | Fetch the targeted image, passage, date, transcript window, or scene; otherwise retain as uncertain. |
| Sufficient evidence but difficult interpretation | Cheap scorer; Strong only for meaningful unresolved conflicts or risk. |

Jev can select among supplied evidence IDs with Choice questions and route the next action; it need not generate prose or inspect images itself. The documented typed-decision interface supports this role: [OpenRouter Jev documentation](https://openrouter.ai/docs/guides/community/jev).

Keep the recorded Flash-Lite scorer and Terra strong seat as the baseline initially. Give the strong judge the exact unresolved requirement IDs and evidence references, without anchoring it on the previous numeric score. Allow direct strong routing for demonstrated hard classes only after calibration. Do not simply narrow the current 4–7 band: the small benchmark already found a missed wrong-format result at 7.

Use one primary planner for ordinary cases, with the ensemble available for ambiguous or failed searches. This is secondary priority: planner spend in the live suite is small. Feed requirement gaps back into one bounded refill round, extending existing exploration/refill code rather than building an unbounded agent loop. Stop on satisfied coverage, no evidence gain, or budget exhaustion.

After hard constraints, rank the top results by relevance, evidence coverage, canonical source, request-specific freshness, diversity, and deduplication. Distinguish verified matches, possible leads with named gaps, and contradictions. An unchecked exclusion can remain a lead; it must not become a factual assertion that the exclusion was satisfied.

This design borrows selective model use from [FrugalGPT](https://arxiv.org/abs/2305.05176) and [RouteLLM](https://arxiv.org/abs/2406.18665), and evidence-quality-triggered retrieval from [Corrective RAG](https://arxiv.org/abs/2401.15884). These papers motivate components; none validates their gains on this engine. An off-the-shelf conversational router is not a trained verifier for this engine's multimodal requirements.

**Implementation and evaluation order**

First fix contradiction grounding, visual evidence representation and thumbnail handling, and the shared contract across all tabs. Next make the benchmark call the production cascade, add search IDs/model versions/evidence versions to traces, and account for Jev/search/scene costs. Then compare evidence-directed routing with the existing cascade on frozen candidate pools before another live end-to-end run. Finally add canonical grouping, targeted list ranking, and planner gating.

Build a held-out suite with at least 30–40 queries per tab and several labeled candidates per query, including negative examples and unavailable evidence. Preserve raw evidence, actual image inputs, each stage's verdict, and canonical identity. Human-check labels and disputed cases; strong-model verdicts can propose labels but should not be treated as ground truth. Split by query/work so copies and repeated runs do not leak into the test set.

Measure hard-constraint precision@5, relevant-candidate recall before admission, false rejection rate, verified-result coverage, timestamp/event correctness, canonical rank, duplication, visual-inspection coverage, licensing/provenance evidence coverage, escalation yield, total cost, and p50/p95 end-to-end latency. Audit strong outputs as well as both Jev acceptance and rejection. Calibrate per modality and requirement class; do not infer accuracy from Jev confidence or the final score.

Separate cold retrieval, warmed evidence, and cached-response runs. The earlier sub-second repeats reused cached searches; the later suite also benefited from scenes/transcripts acquired in earlier runs. Neither is a clean independent stability or architecture comparison.

Verification performed for this review: `node --import tsx --test tests/cascade.test.ts tests/jev-judge.test.ts tests/screener.test.ts tests/requirements-judge.test.ts` — 22 passed, 0 failed. These are rule/contract tests, not a new live model evaluation.
