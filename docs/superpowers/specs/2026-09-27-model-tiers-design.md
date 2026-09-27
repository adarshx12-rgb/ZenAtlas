# Model tiers: SSJ3 and SSJ1

Date: 2026-09-27. Status: approved design, awaiting spec review.

## Goal

Searchers choose how much model spend a search gets. **SSJ3** is today's model architecture, unchanged. **SSJ1** runs the
same architecture and roles (planner, Jev, judge, council, critic, router, query rewrite) on cheaper models. The choice is
per search, seamless to switch and reliable: an SSJ1 search never fails because a cheap model is down, and tiers never
reuse each other's cached answers.

Success: SSJ1 costs clearly less per search while keeping most of SSJ3's accuracy, measured on real queries (section 6).

## 1. Tiers

| Role | SSJ3 (current) | SSJ1 |
|---|---|---|
| Planner (`PLANNER_MODELS`) | gemma-4-31b-it, ministral-14b-2512, mercury-2.5 | same |
| Jev (`JEV_MODEL`) | typesafe/jev-1.13 | same |
| Judge (`JUDGE_MODELS`) | gemini-3.5-flash-lite, gemini-3.8-flash, gpt-4.1-mini, qwen3-vl-30b | `google/gemini-2.5-flash-lite`, then SSJ3's list |
| Council checker (`COUNCIL_CHECKER_MODELS`) | gpt-5.6-terra, mistral-medium-3.1, gpt-5.4-mini | `openai/gpt-5.6-luna`, then SSJ3's list |
| Council chair (`COUNCIL_CHAIR_MODELS`) | claude-sonnet-5, gemini-3.1-pro-preview | `anthropic/claude-haiku-4.5`, then SSJ3's list |
| Critic (`CRITIC_MODEL`), reviewer (`CRITIC_REVIEW_MODEL`) | claude-sonnet-5 | `anthropic/claude-haiku-4.5` |
| Tab router (`MODE_ROUTER_MODEL`), query rewrite (`QUERY_REWRITE_MODEL`) | gemini-3.5-flash-lite | `openai/gpt-4.1-nano` |
| Scene analysis, transcript clean-up, embeddings, Whisper | shared | shared (always SSJ3; stored and reused by every search) |

The council runs in SSJ1 (same checks, same top-N), on the cheaper models above.
SSJ3's models follow each SSJ1 model as backups, so an SSJ1 search degrades to SSJ3 cost rather than failing.
The direct-Gemini last-resort judge (`JUDGE_MODEL`) is the same in both tiers.

Settings: `SSJ1_JUDGE_MODELS`, `SSJ1_COUNCIL_CHECKER_MODELS`, `SSJ1_COUNCIL_CHAIR_MODELS`, `SSJ1_CRITIC_MODEL`,
`SSJ1_CRITIC_REVIEW_MODEL`, `SSJ1_MODE_ROUTER_MODEL`, `SSJ1_QUERY_REWRITE_MODEL`, defaulting to the SSJ1 column.
Daily budgets are shared between tiers, so total spending caps are unchanged.

## 2. Mechanism

`tierConfig(config, tier)` (new `src/tiers.ts`) returns the base config for `ssj3` and, for `ssj1`, a copy with only
the model settings above replaced (SSJ1 model first, SSJ3 list after, duplicates removed). Every role already builds its
model client from the config it is handed (`makeJudge`, `makeCouncil`, `makePlanner`, `criticClient`, `modeDeps`,
`rewriteQuery`), so no role code changes.

The tier travels with the search:
- `tier: 'ssj3'|'ssj1'` (default `ssj3`) on `/api/search`, `/api/web`, `/api/mode` (and the deep-dive endpoint via the stored search).
- Video searches store it in the discovery job payload; the worker builds `tierConfig` before `runDiscovery`.
- The search trace records it; the critic audit uses that tier's critic model; the weekly review groups audits by tier and
  checks each group with that tier's reviewer.
- Web review and document hunt state are created per request with the tier's config.

No mixing: the tier joins every reuse key — the discovery job dedupe key (`queryKey`), the query-rewrite cache and the
mode-router cache. For `ssj3` the keys are exactly today's, so existing cached work stays valid.

## 3. The LVL control

A **LVL** button beside Search. Clicking it opens a small dropdown: **SSJ3** (full models) and **SSJ1** (lower-cost
models), each with a one-line description; the current level is marked. Keyboard: Enter/Space opens, arrows move, Esc
closes; it closes on outside click. The button shows the level chosen (`LVL · SSJ3`).

- Default SSJ3; remembered in the browser (localStorage, wrapped in try/catch) and kept in the URL as `tier=ssj1`.
- Choosing a different level reruns the current search on that level; a search already running keeps its level.
- The results status line names the level that produced the results.

## 4. Reliability

- Unknown or missing `tier` means `ssj3`.
- Backup chains as above; existing per-model cooldowns and health tracking apply unchanged.
- The dependency check (watchdog) also verifies SSJ1 models are still offered by OpenRouter.
- Logs (`mode_route`, `query_rewrite`, `council`, `web_review`) gain a `tier` field.

## 5. Tests

- `tierConfig`: ssj3 returns the config unchanged; ssj1 changes only the listed settings, SSJ3 models follow as backups.
- Tier reaches the discovery job, worker config, trace, critic audit and weekly review.
- Reuse keys differ between tiers; ssj3 keys equal today's.
- Browser: LVL dropdown opens/closes (mouse, keyboard), remembers, updates the URL, reruns; phone width.

## 6. Evaluation (after build)

Run a fixed set of real queries (Web, Docs and Videos tabs) on both tiers against the running app and report for SSJ1 vs
SSJ3: results kept, overlap with SSJ3's kept results, precision graded blind against each request, council agreement,
latency, and cost per search from OpenRouter's reported usage. Score each tier out of 10 on accuracy, cost and speed.
