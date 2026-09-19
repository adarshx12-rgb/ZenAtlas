# Model clients and ensemble planning — design

Two dependent pieces of work, specified by the user on 2026-09-19. Piece 2 builds on
piece 1 and cannot land without it.

## Piece 1 — OpenAI-compatible model endpoints

Add support for OpenAI-compatible model endpoints (OpenRouter) alongside the existing
Gemini client. No behaviour changes — this is groundwork.

1. Refactor `src/gemini.ts`. Most of it is provider-agnostic and worth keeping: the
   model fallback chain, the per-model cooldown map, telling per-minute from per-day
   rate limits apart, honouring the API's suggested retry delay, daily budget spending
   via `takeBudget`, and health recording via `providerHealth`. Extract that into an
   abstract base class in `src/model-client.ts` with one abstract method performing a
   single request and returning parsed JSON. `GeminiClient` becomes a subclass
   implementing only Gemini's request/response shape. Behaviour must be identical —
   `tests/watchdog.test.ts` and `tests/planning.test.ts` must pass unchanged.

2. Add `src/openai-compatible.ts`: a subclass calling `POST {base}/chat/completions`
   with the system instruction as a system message, the text as a user message, and
   `response_format` `{type:'json_schema', json_schema:{name, schema, strict:true}}`.
   Images go in the user message as `image_url` parts with base64 data URIs (OpenAI
   vision format) — the judge sends JPEG screenshots and they must survive this path.
   Send OpenRouter's `HTTP-Referer` and `X-Title` headers from config.

   Keep the `fetchJSON` transport with `trustedOrigin` so the SSRF guard applies and
   tests can inject a fake transport. Not every backend enforces `json_schema`, so
   always validate the parsed reply and throw `UpstreamError('malformed_response')` on
   failure.

3. Config in `src/config.ts`, all optional, defaulting so nothing changes when unset:
   `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `OPENROUTER_API_KEY`,
   `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME`. Document all four in `.env.example`.

4. Tests in `tests/openai-compatible.test.ts` using the injectable transport: a valid
   reply parses; non-JSON throws `malformed_response`; JSON failing the zod schema
   throws `malformed_response`; a 429 is classified as `rate_limited` and triggers the
   inherited cooldown.

Do not touch `discovery.ts`, `signals.ts`, `judge.ts`, `planner.ts` or `scene-worker/`.
Keep the existing dense code style.

## Piece 2 — Ensemble planning

Let several models plan searches together, merging their suggestions.

1. Add `EnsemblePlanner` in `src/planner.ts` implementing the existing `Planner`
   interface, built from a primary `Planner` and zero or more assists. `plan()` runs all
   in parallel with `Promise.allSettled`.

   **CRITICAL — cap the union.** Each planner may return up to `PLAN_SEARCHES` queries,
   but the merged result must still respect that limit: every extra query is fanned
   across nine SearXNG engines and multiplies discovery wall-time and engine budget.
   Interleave the lists round-robin (primary first at each position) and pass the result
   through the existing `uniqueSearches()` with the normal limit.

   `kind` and `criteria` come from the primary. If the primary fails but an assist
   succeeded, promote the first successful assist. If all fail, throw, so the existing
   `planWith()` catch in `discovery.ts` falls back to `fallbackPlan` — do not swallow
   that. Implement `followUps()` the same way, capped at `DEEP_FOLLOW_UPS`.

2. Add `makePlanner(db, config)` in `src/planner.ts` and use it to replace the inline
   ternary at `src/discovery.ts:95`. Leave the `deps.planner` injection point exactly as
   it is — tests depend on it.

   Gemini stays primary when `GEMINI_API_KEY` is set. Each model in
   `PLANNER_ASSIST_MODELS` (new comma-separated config, default empty) becomes an assist
   on the OpenAI-compatible client. Empty means today's behaviour.

3. Give each assist its own budget bucket (`planner_calls:<model>`) so one model
   exhausting its budget does not stop the others.

4. Tests in `tests/planning.test.ts`: two planners' queries merge without exceeding
   `PLAN_SEARCHES`; the user's own query still comes first; one planner failing still
   yields the other's plan; all failing falls back to `fallbackPlan` with provider status
   `unavailable`.

## Decisions resolved with the user

These were open in the specs above and are settled. They override any contrary reading
of the specs.

**D1 — OpenRouter model ids come from a constructor parameter.** Model ids such as
`deepseek/deepseek-v4-flash-0731:free` contain `/` and `:`. The existing config regexes
reject both (`JUDGE_MODEL` is `/^[\w.-]{0,100}$/`, `JUDGE_FALLBACK_MODELS` is
`/^[\w.,\s-]*$/`). Rather than widen those or add model config in piece 1,
`OpenAICompatibleClient` takes its model list as a constructor argument:
`new OpenAICompatibleClient(db, config, models, transport)`. Piece 1 therefore adds
exactly the four `OPENROUTER_*` vars specified. Piece 2 supplies the models from
`PLANNER_ASSIST_MODELS`, whose own regex does allow `/` and `:`.

**D2 — the client normalises schemas for strict mode.** OpenAI strict structured output
requires `additionalProperties: false` on every object node. The existing schemas
(`judge.ts` `RESPONSE_SCHEMA`, `planner.ts` `RESPONSE_SCHEMA`) set `required` correctly
but never set `additionalProperties`, and piece 1 forbids touching those files. So
`openai-compatible.ts` walks the schema and adds `additionalProperties: false` to every
object node before sending, keeping `strict: true` as specified.

**D3 — assists race a deadline.** Plain `Promise.allSettled` makes every search wait for
the slowest planner: up to `JUDGE_TIMEOUT_MS` (20s default) added to ordinary searches,
not just deep dives. A live probe of a free OpenRouter model hung for 60s. Assists
therefore race a `PLANNER_ASSIST_TIMEOUT_MS` deadline (new config, default 6000) well
inside the model timeout; an assist that misses it is dropped and the primary's plan is
used as-is. The primary is awaited in full.

**D4 — the watchdog watches assist buckets.** `DAILY_BUDGETS` in `src/dependencies.ts` is
a fixed list queried with `bucket=ANY($1::text[])`, so a `planner_calls:<model>` bucket
would be invisible and a model could silently exhaust its budget. It becomes a function
of config, appending one row per assist model.

**D5 — `planner.ts` gains a client seam.** `GeminiPlanner` constructs
`new GeminiClient(db, config, transport)` in its own constructor, so there is no way to
put an assist on a different client. Piece 1's "do not touch `planner.ts`" therefore
cannot hold for piece 2. The planning logic moves to `ModelPlanner(client, config,
bucket)` and `GeminiPlanner(db, config, transport)` becomes a thin subclass, preserving
the three-argument construction `tests/planning.test.ts:34` depends on.

## Out of scope

`SearchPlan.model` is set by `normalisePlan` and read nowhere in the codebase, so no
decision about what an ensemble reports in that field is needed; it keeps the leading
planner's value.

`signals.ts`, `judge.ts` and `scene-worker/` are not touched by either piece. Routing the
judge through the OpenAI-compatible client is future work.
