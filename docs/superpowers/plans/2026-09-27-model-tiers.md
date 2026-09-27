# Model Tiers (SSJ3 / SSJ1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each search run on SSJ3 (today's models) or SSJ1 (same roles, cheaper models), chosen from a LVL dropdown beside Search, then measure SSJ1 against SSJ3.

**Architecture:** `tierConfig(config, tier)` returns the settings object with only the model settings swapped for SSJ1; every role already builds its model client from the config it is handed, so no role code changes. The tier travels with each request (web, docs, mode routing, video discovery job, trace, critic audit) and joins every reuse key.

**Tech Stack:** Node 24 + TypeScript (tsx), Fastify, zod, PostgreSQL, node:test, vanilla ES modules in `public/`, Playwright for browser checks.

**Spec:** `docs/superpowers/specs/2026-09-27-model-tiers-design.md`

## Global Constraints

- Tier values: `ssj3` (default, today's behaviour) and `ssj1`. Anything else is rejected by the input schema; a missing tier is `ssj3`.
- SSJ1 models (defaults): judge `google/gemini-2.5-flash-lite`; council checker `openai/gpt-5.6-luna`; council chair `anthropic/claude-haiku-4.5`; critic and reviewer `anthropic/claude-haiku-4.5`; router and query rewrite `openai/gpt-4.1-nano`. Planner, Jev, direct-Gemini judge, scene analysis, transcripts, embeddings: unchanged in both tiers.
- In SSJ1, each role's SSJ3 models follow the SSJ1 model as backups (judge, checker, chair lists). Critic, reviewer, router and rewrite are single-model settings and get no backup.
- For `ssj3`, `tierConfig` returns the config object unchanged and the discovery `queryKey` is byte-for-byte today's.
- Daily budgets are shared between tiers.
- Run tests with `npm test` (all) or `node --import tsx --test tests/<file>.test.ts`; type-check with `npx tsc --noEmit`.
- The live app runs under PM2 (`zenatlas-api`, `zenatlas-worker`); restart both after server changes: `npx pm2 restart zenatlas-api zenatlas-worker`.
- This branch holds unrelated uncommitted work (`src/requirements.ts`, tests, docs). The "Commit" steps run only if the user asks for commits; otherwise skip them. When committing, stage only the files each task names.

## Review Focus

- A video search started on SSJ1 and one on SSJ3 for the same query at the same time must get separate discovery jobs, not share one (Task 2 test).
- A saved SSJ1 search reopened, paged or deepened later must stay SSJ1 (Task 2 test: `deepen` keeps the tier in the stored filters).
- The critic audit of an SSJ1 search must use the SSJ1 critic even though the audit runs later in another job (Task 3 test).
- A browser with blocked storage (private mode) must still show the LVL control and search on SSJ3 (Task 6 try/catch + browser check).
- Changing LVL while a search is running must not mix results from two tiers into one list (Task 6: a level change reruns through the search controller, which discards the old generation).

---

### Task 1: Tier settings and `tierConfig`

**Files:**
- Modify: `src/config.ts` (add `TIER` and `SSJ1_*` settings next to the query-rewrite settings)
- Create: `src/tiers.ts`
- Test: `tests/tiers.test.ts`

**Interfaces:**
- Produces: `export type Tier = 'ssj3'|'ssj1'`; `export const TIERS: readonly Tier[]`; `export const tierSchema` (zod enum, default `ssj3`); `export function tierConfig(config: Config, tier: Tier): Config`. `Config.TIER: Tier`.

- [ ] **Step 1: Write the failing test** — `tests/tiers.test.ts`:

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {tierConfig, tierSchema} from '../src/tiers.js';

const base={...testConfig,JUDGE_MODELS:'google/gemini-3.5-flash-lite,google/gemini-3.8-flash',
 COUNCIL_CHECKER_MODELS:'openai/gpt-5.6-terra,openai/gpt-5.4-mini',COUNCIL_CHAIR_MODELS:'anthropic/claude-sonnet-5',
 CRITIC_MODEL:'anthropic/claude-sonnet-5',CRITIC_REVIEW_MODEL:'anthropic/claude-sonnet-5',
 MODE_ROUTER_MODEL:'google/gemini-3.5-flash-lite',QUERY_REWRITE_MODEL:'google/gemini-3.5-flash-lite'};

test('ssj3 is the configuration exactly as it is today',()=>{
 assert.equal(tierConfig(base,'ssj3'),base);
 assert.equal(base.TIER,'ssj3');
});

test('ssj1 swaps only the model settings, with the ssj3 models kept as backups',()=>{
 const c=tierConfig(base,'ssj1');
 assert.equal(c.TIER,'ssj1');
 assert.equal(c.JUDGE_MODELS,'google/gemini-2.5-flash-lite,google/gemini-3.5-flash-lite,google/gemini-3.8-flash');
 assert.equal(c.COUNCIL_CHECKER_MODELS,'openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-5.4-mini');
 assert.equal(c.COUNCIL_CHAIR_MODELS,'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5');
 assert.deepEqual([c.CRITIC_MODEL,c.CRITIC_REVIEW_MODEL,c.MODE_ROUTER_MODEL,c.QUERY_REWRITE_MODEL],
   ['anthropic/claude-haiku-4.5','anthropic/claude-haiku-4.5','openai/gpt-4.1-nano','openai/gpt-4.1-nano']);
 const changed=Object.keys(base).filter(k=>(base as any)[k]!==(c as any)[k]).sort();
 assert.deepEqual(changed,['COUNCIL_CHAIR_MODELS','COUNCIL_CHECKER_MODELS','CRITIC_MODEL','CRITIC_REVIEW_MODEL','JUDGE_MODELS',
   'MODE_ROUTER_MODEL','QUERY_REWRITE_MODEL','TIER']);
 assert.equal(c.PLANNER_MODELS,base.PLANNER_MODELS);assert.equal(c.GEMINI_MODEL,base.GEMINI_MODEL);assert.equal(c.JEV_MODEL,base.JEV_MODEL);
});

test('an SSJ1 model already in the ssj3 list is not repeated; a changed SSJ1 setting is used',()=>{
 const c=tierConfig({...base,SSJ1_JUDGE_MODELS:'google/gemini-3.8-flash'},'ssj1');
 assert.equal(c.JUDGE_MODELS,'google/gemini-3.8-flash,google/gemini-3.5-flash-lite');
});

test('the tier input accepts ssj1 and ssj3 only, and defaults to ssj3',()=>{
 assert.equal(tierSchema.parse(undefined),'ssj3');
 assert.equal(tierSchema.parse('ssj1'),'ssj1');
 assert.throws(()=>tierSchema.parse('ssj2'));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test tests/tiers.test.ts`
Expected: FAIL, `Cannot find module '../src/tiers.js'`.

- [ ] **Step 3: Add the settings** — in `src/config.ts`, directly after `QUERY_REWRITE_DAILY_BUDGET: number(3000, 0, 100000),` add:

```ts
  // Model tiers (src/tiers.ts). TIER is set per search by tierConfig, never in .env. SSJ1_* are the lower-cost models
  // SSJ1 puts first; SSJ3's own models follow them as backups (chosen 2026-09-27, see docs/superpowers/specs).
  TIER: z.enum(['ssj3', 'ssj1']).default('ssj3'),
  SSJ1_JUDGE_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('google/gemini-2.5-flash-lite'),
  SSJ1_COUNCIL_CHECKER_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('openai/gpt-5.6-luna'),
  SSJ1_COUNCIL_CHAIR_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('anthropic/claude-haiku-4.5'),
  SSJ1_CRITIC_MODEL: z.string().regex(/^[\w.\/:-]{1,100}$/).default('anthropic/claude-haiku-4.5'),
  SSJ1_CRITIC_REVIEW_MODEL: z.string().regex(/^[\w.\/:-]{1,100}$/).default('anthropic/claude-haiku-4.5'),
  SSJ1_MODE_ROUTER_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('openai/gpt-4.1-nano'),
  SSJ1_QUERY_REWRITE_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('openai/gpt-4.1-nano'),
```

- [ ] **Step 4: Create `src/tiers.ts`**

```ts
import { z } from 'zod';
import type { Config } from './config.js';

// Model tiers. SSJ3 is the full model architecture; SSJ1 runs the same roles (planner, Jev, judge, council, critic,
// router, query rewrite) on lower-cost models. A search carries its tier, and tierConfig gives it the settings to run
// with: every role builds its model client from the config it is handed, so no role knows about tiers. Work stored and
// shared by every search (scene analysis, transcripts, embeddings) always uses the base settings.
export const TIERS = ['ssj3', 'ssj1'] as const;
export type Tier = typeof TIERS[number];
export const tierSchema = z.enum(TIERS).default('ssj3');

const list = (s: string) => s.split(',').map(m => m.trim()).filter(Boolean);
// The SSJ1 models first, then SSJ3's as backups, so an SSJ1 search costs more rather than failing when one is down.
const first = (cheap: string, full: string) => [...new Set([...list(cheap), ...list(full)])].join(',');

export function tierConfig(config: Config, tier: Tier): Config {
 if (tier === 'ssj3') return config;
 return {...config, TIER: 'ssj1',
   JUDGE_MODELS: first(config.SSJ1_JUDGE_MODELS, config.JUDGE_MODELS),
   COUNCIL_CHECKER_MODELS: first(config.SSJ1_COUNCIL_CHECKER_MODELS, config.COUNCIL_CHECKER_MODELS),
   COUNCIL_CHAIR_MODELS: first(config.SSJ1_COUNCIL_CHAIR_MODELS, config.COUNCIL_CHAIR_MODELS),
   CRITIC_MODEL: config.SSJ1_CRITIC_MODEL, CRITIC_REVIEW_MODEL: config.SSJ1_CRITIC_REVIEW_MODEL,
   MODE_ROUTER_MODEL: config.SSJ1_MODE_ROUTER_MODEL, QUERY_REWRITE_MODEL: config.SSJ1_QUERY_REWRITE_MODEL};
}
```

- [ ] **Step 5: Run the test and the type check**

Run: `node --import tsx --test tests/tiers.test.ts && npx tsc --noEmit`
Expected: 4 passing, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/tiers.ts tests/tiers.test.ts
git commit -m "Add SSJ3/SSJ1 model tiers with tierConfig"
```

---

### Task 2: The tier travels with every search request

**Files:**
- Modify: `src/types.ts:3-15` (searchInput gains `tier`)
- Modify: `src/search.ts:19-22` (queryKey)
- Modify: `src/web.ts` (webSearchInput gains `tier`)
- Modify: `src/app.ts` (`/api/web`, `/api/mode` apply `tierConfig`; `SearchService` builds the tier config for `/api/search` in `src/search.ts`)
- Test: `tests/tiers.test.ts` (append), `tests/search.test.ts` (append inside the existing app test)

**Interfaces:**
- Consumes: `tierSchema`, `tierConfig`, `Tier` from Task 1.
- Produces: `SearchInput.tier: Tier`, `WebSearchInput.tier: Tier`; `queryKey(input)` unchanged for `ssj3`, `[...key,'ssj1']` suffix for `ssj1`; `/api/mode?q=&tier=`.

- [ ] **Step 1: Write the failing tests** — append to `tests/tiers.test.ts`:

```ts
import {searchInput} from '../src/types.js';
import {queryKey} from '../src/search.js';
import {webSearchInput} from '../src/web.js';

test('searches carry their tier; ssj3 reuse keys are today\'s and ssj1 keys differ',()=>{
 const today=searchInput.parse({q:'underrated osint tools'});
 assert.equal(today.tier,'ssj3');
 const {tier:_t,...withoutTier}=today;
 assert.equal(queryKey(today),queryKey(withoutTier as any),'ssj3 keeps the key existing jobs were stored under');
 assert.notEqual(queryKey(searchInput.parse({q:'underrated osint tools',tier:'ssj1'})),queryKey(today));
 assert.equal(webSearchInput.parse({q:'x y',tier:'ssj1'}).tier,'ssj1');
 assert.throws(()=>webSearchInput.parse({q:'x y',tier:'max'}));
});
```

Append inside the app test in `tests/search.test.ts`, after the `/api/walled` assertions:

```ts
   assert.equal((await app.inject('/api/mode?q=cat%20videos&tier=ssj9')).statusCode,400,'an unknown tier is refused');
   assert.equal((await app.inject('/api/web?q=a&tier=ssj1')).statusCode,400,'input rules still apply with a tier');
```

- [ ] **Step 2: Run to see them fail**

Run: `node --import tsx --test tests/tiers.test.ts`
Expected: FAIL on `today.tier` (undefined).

- [ ] **Step 3: Add `tier` to the inputs**

`src/types.ts` — inside `searchInput`, after `depth: ...,` add:

```ts
 // The model tier (src/tiers.ts): which models run this search. Stored with the search, so paging and deep dives keep it.
 tier: z.enum(['ssj3', 'ssj1']).default('ssj3'),
```

`src/web.ts` — inside `webSearchInput`, after `exact: ...,` add:

```ts
 tier: tierSchema,
```

and import it: `import { tierSchema } from './tiers.js';`

`src/search.ts` — replace `queryKey`:

```ts
export function queryKey(input: SearchInput) {
 const key = [RANKING_VERSION,input.q,input.language,input.source,input.after,input.evidence];
 const deep = input.depth==='deep' ? [...key,'deep'] : key;
 // SSJ1 searches never share a discovery job with SSJ3 ones; SSJ3 keeps the key its stored jobs already use.
 return createHash('sha256').update(JSON.stringify(input.tier==='ssj1' ? [...deep,'ssj1'] : deep)).digest('hex');
}
```

- [ ] **Step 4: Apply the tier config at the routes** — in `src/app.ts` add `import { tierConfig, tierSchema } from './tiers.js';` and replace the two routes:

```ts
 app.get('/api/web',async req=>{const input=webSearchInput.parse(req.query);return searchWeb(db,tierConfig(config,input.tier),input);});
```

```ts
 app.get('/api/mode',async req=>{
   const {q,tier}=z.object({q:z.string().trim().min(2).max(400),tier:tierSchema}).strict().parse(req.query);
   const tiered=tierConfig(config,tier);
   return chooseMode(db,tiered,q,modeDeps(db,tiered));
 });
```

(import `modeDeps` alongside `chooseMode` from `./mode-router.js`.) `SearchService.start` stores `input` (now with `tier`) as the discovery job payload and the search's filters, so `/api/search`, paging and `deepen` carry the tier with no further change.

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test tests/tiers.test.ts tests/search.test.ts tests/web.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/search.ts src/web.ts src/app.ts tests/tiers.test.ts tests/search.test.ts
git commit -m "Carry the model tier on every search request and discovery key"
```

---

### Task 3: Worker, trace and critic use the search's tier

**Files:**
- Modify: `src/worker.ts:34-41` (discovery job), `src/worker.ts:78-83` (`learnFrom`)
- Modify: `src/learning.ts` (`SearchTrace.tier`, `auditTrace`, `reviewAudits`)
- Test: `tests/learning.test.ts` (append)

**Interfaces:**
- Consumes: `tierConfig`, `Tier`.
- Produces: `SearchTrace.tier?: Tier` (absent on older traces = `ssj3`).

- [ ] **Step 1: Write the failing test** — append to `tests/learning.test.ts` (it already has `database()` fixtures; use the same pattern as its existing audit test):

```ts
test('an SSJ1 search is audited and reviewed by the SSJ1 critic models',async()=>{
 const db=await database();
 const trace={query:'ghost story short film',depth:'quick',plan:{kind:'videos',criteria:[],model:null},searches:[],rounds:0,providers:[],pool:[],tier:'ssj1'};
 const id=await saveTrace(db,null,trace as any);
 const asked:string[]=[];
 const config={...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true,CRITIC_DAILY_BUDGET:10};
 const clientFor=(model:string)=>({models:[model],json:async()=>{asked.push(model);throw new Error('stop after choosing the model');}});
 await auditTrace(db,config,id,{clientFor}).catch(()=>{});
 assert.deepEqual(asked,['anthropic/claude-haiku-4.5']);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx --test tests/learning.test.ts`
Expected: FAIL — `asked` is `['anthropic/claude-sonnet-5']` (or the test deps key is unknown).

- [ ] **Step 3: Implement**

`src/learning.ts`:
- Add `tier?: Tier;` to `SearchTrace` and `import { tierConfig, type Tier } from './tiers.js';`.
- Extend `CriticDeps` with `clientFor?: (model: string) => CriticClient` (tests pick the model without a network client).
- In `auditTrace`, replace `const client = deps.client ?? criticClient(db, config, config.CRITIC_MODEL);` with:

```ts
 // The critic of the search's own tier: an SSJ1 search is audited by SSJ1's critic model.
 const tiered = tierConfig(config, trace.tier ?? 'ssj3');
 const client = deps.client ?? (deps.clientFor ?? (m => criticClient(db, tiered, m)))(tiered.CRITIC_MODEL);
```

  (move the `const trace = row.trace as SearchTrace` line above it.)
- In `reviewAudits`, replace the single `client` with a per-tier client chosen inside the loop:

```ts
 const clients = new Map<string, CriticClient>();
 const reviewerFor = (tier: Tier) => {
   const model = tierConfig(config, tier).CRITIC_REVIEW_MODEL;
   if (!clients.has(model)) clients.set(model, deps.client ?? (deps.clientFor ?? (m => criticClient(db, config, m)))(model));
   return clients.get(model)!;
 };
```

  and inside the loop use `reviewerFor(trace.tier ?? 'ssj3').json(...)` where it called `client.json(...)`.

`src/worker.ts` — in the `discovery` branch:

```ts
     const input=searchInput.parse(job.payload),tiered=tierConfig(config,input.tier);
     const outcome=await runDiscovery(db,tiered,input,adapters,deps??{},(name,ok,code)=>providerHealth(db,name,ok,code),
       update=>progress(db,job,update));
     for(const result of outcome.ingested) await enqueueEnrichment(db,config,result);
     await storePreviews(db,job,outcome.previews);
     await learnFrom(db,config,job,{...outcome.trace,tier:input.tier});
```

(`enqueueEnrichment` keeps the base `config`: stored, shared work stays SSJ3.) Import `tierConfig` from `./tiers.js`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/learning.test.ts tests/pipeline.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/learning.ts tests/learning.test.ts
git commit -m "Run discovery, critic audits and reviews on the search's model tier"
```

---

### Task 4: Caches keyed by model; logs name the tier

**Files:**
- Modify: `src/query-rewrite.ts` (cache key, log line)
- Modify: `src/mode-router.ts` (cache key, log line)
- Modify: `src/web-review.ts:56` (log line)
- Test: `tests/query-rewrite.test.ts`, `tests/mode-router.test.ts` (append)

**Interfaces:**
- Consumes: `Config.TIER`, `tierConfig`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/query-rewrite.test.ts`:

```ts
import {tierConfig} from '../src/tiers.js';
test('each tier keeps its own rewrites, and the log names the tier',async()=>{
 clearRewriteCache();
 let calls=0;const lines:any[]=[];
 const deps={model:async()=>{calls++;return {corrected:'python asyncio tutorial',topic:null,topic_kind:null,searches:['python asyncio guide','asyncio tutorial examples']};},log:(l:any)=>lines.push(l)};
 await rewriteQuery(db,config,'pyhton asyncio tutorial','docs',deps);
 await rewriteQuery(db,tierConfig(config,'ssj1'),'pyhton asyncio tutorial','docs',deps);
 assert.equal(calls,2,'an SSJ3 rewrite is not reused for SSJ1');
 assert.deepEqual(lines.map(l=>l.tier),['ssj3','ssj1']);
});
```

Append to `tests/mode-router.test.ts` (it imports `chooseMode`, `clearModeCache`):

```ts
import {tierConfig} from '../src/tiers.js';
test('each tier keeps its own routing decisions, and the log names the tier',async()=>{
 clearModeCache();
 let calls=0;const lines:any[]=[];
 const deps={jev:async()=>{calls++;return {type:'choice' as const,choice:'web',confidence:0.95};},log:(l:any)=>lines.push(l)};
 const config={...testConfig,MODE_ROUTER_ENABLED:true};
 await chooseMode({} as any,config,'best laptops 2026',deps as any);
 await chooseMode({} as any,tierConfig(config,'ssj1'),'best laptops 2026',deps as any);
 assert.equal(calls,2);
 assert.deepEqual(lines.map(l=>l.tier),['ssj3','ssj1']);
});
```

(If `tests/mode-router.test.ts` does not import `testConfig`, add `import {testConfig} from './helpers.js';`.)

- [ ] **Step 2: Run to see them fail**

Run: `node --import tsx --test tests/query-rewrite.test.ts tests/mode-router.test.ts`
Expected: FAIL (`calls` is 1; `tier` undefined).

- [ ] **Step 3: Implement**

`src/query-rewrite.ts`: key becomes
```ts
 const key = `${config.QUERY_REWRITE_MODEL}:${tab}:${query.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`;
```
and both `log({event: 'query_rewrite', ...})` calls gain `tier: config.TIER,` after `event`.

`src/mode-router.ts`: in `chooseMode`, key becomes
```ts
 const key = `${config.TIER}:${query.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`;
```
and the log line becomes `({event: 'mode_route', tier: config.TIER, ...decision})`.

`src/web-review.ts:56`: `({event: 'web_review', tier: config.TIER, ...webReviewMetrics(out.trace)})` — `config` is in scope in `startWebReview`; if the log runs in a helper without it, pass `config.TIER` down alongside `deps.log`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/query-rewrite.test.ts tests/mode-router.test.ts tests/web-review.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/query-rewrite.ts src/mode-router.ts src/web-review.ts tests/query-rewrite.test.ts tests/mode-router.test.ts
git commit -m "Keep each tier's cached rewrites and routes apart; name the tier in logs"
```

---

### Task 5: Watchdog checks both tiers' OpenRouter models

**Files:**
- Modify: `src/dependencies.ts` (new `tierModels` check, added to `CHECKS`)
- Test: `tests/watchdog.test.ts` (append)

**Interfaces:**
- Consumes: `tierConfig`, `judgeModels` (`src/judge.ts`).
- Produces: `Check` named `tier_models`.

- [ ] **Step 1: Write the failing test** — append to `tests/watchdog.test.ts`:

```ts
test('tier models: a model OpenRouter no longer offers is named, with the tier and setting',async()=>{
 const {CHECKS}=await import('../src/dependencies.js');
 const check=CHECKS.find(c=>c.name==='tier_models')!;
 const offered=['google/gemini-2.5-flash-lite','openai/gpt-5.6-luna','anthropic/claude-haiku-4.5','openai/gpt-4.1-nano',
   'google/gemini-3.5-flash-lite','openai/gpt-5.6-terra','anthropic/claude-sonnet-5'];
 const config={...testConfig,OPENROUTER_API_KEY:'k',JUDGE_MODELS:'google/gemini-3.5-flash-lite',COUNCIL_CHECKER_MODELS:'openai/gpt-5.6-terra',
   COUNCIL_CHAIR_MODELS:'anthropic/claude-sonnet-5',MODE_ROUTER_MODEL:'google/gemini-3.5-flash-lite',QUERY_REWRITE_MODEL:'google/gemini-3.5-flash-lite'};
 const env=(ids:string[])=>({db:{} as any,config,root:'.',launchBrowser:async()=>'',extractor:()=>({}) as any,
   transport:(async()=>({data:ids.map(id=>({id}))})) as any});
 assert.equal((await check.run(env(offered))).status,'ok');
 const gone=await check.run(env(offered.filter(m=>m!=='openai/gpt-5.6-luna')));
 assert.equal(gone.status,'warning');
 assert.match(gone.summary,/SSJ1.*openai\/gpt-5\.6-luna.*SSJ1_COUNCIL_CHECKER_MODELS/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx --test tests/watchdog.test.ts`
Expected: FAIL (`check` undefined).

- [ ] **Step 3: Implement** — in `src/dependencies.ts` add (import `tierConfig`, `TIERS` from `./tiers.js`):

```ts
// The OpenRouter models each tier puts first. A retired one still has backups in SSJ1, so this warns rather than fails.
const TIER_SETTINGS = [['JUDGE_MODELS', 'SSJ1_JUDGE_MODELS'], ['COUNCIL_CHECKER_MODELS', 'SSJ1_COUNCIL_CHECKER_MODELS'],
 ['COUNCIL_CHAIR_MODELS', 'SSJ1_COUNCIL_CHAIR_MODELS'], ['CRITIC_MODEL', 'SSJ1_CRITIC_MODEL'], ['CRITIC_REVIEW_MODEL', 'SSJ1_CRITIC_REVIEW_MODEL'],
 ['MODE_ROUTER_MODEL', 'SSJ1_MODE_ROUTER_MODEL'], ['QUERY_REWRITE_MODEL', 'SSJ1_QUERY_REWRITE_MODEL']] as const;
const tierModels: Check = {name: 'tier_models', label: 'Model tiers (SSJ3 / SSJ1)', category: 'ai', every: () => 60, confirm: 1,
 async run({config, transport}) {
   if (!config.OPENROUTER_API_KEY) return disabled('OPENROUTER_API_KEY is empty; both tiers run without OpenRouter models.');
   try {
     const reply = z.object({data: z.array(z.object({id: z.string()}))}).parse(await transport('https://openrouter.ai/api/v1/models',
       {trustedOrigin: 'https://openrouter.ai', timeoutMs: 15000, redirects: 0, maxBytes: 8 * 1024 * 1024}));
     const offered = new Set(reply.data.map(m => m.id));
     const missing = TIERS.flatMap(tier => TIER_SETTINGS.flatMap(([full, cheap]) => {
       const setting = tier === 'ssj1' ? cheap : full, value = String(config[setting] ?? '');
       const first = value.split(',').map(m => m.trim()).filter(Boolean)[0];
       return first && !offered.has(first) ? [`${tier.toUpperCase()} ${first} (${setting})`] : [];
     }));
     return missing.length
       ? warning('models_retired', `OpenRouter no longer offers ${missing.join('; ')}. Searches fall back to the next model; update the setting.`, {missing})
       : ok('available', 'Every model both tiers put first is offered by OpenRouter.');
   } catch (error) {
     if (!(error instanceof UpstreamError)) throw error;
     return warning('unreachable', `OpenRouter's model list could not be read (${reason(error)}); tier models were not checked.`);
   }
 }};
```

and append `tierModels` to the `CHECKS` array after `gemini`. (Use the file's existing `disabled` helper; if it is named differently, reuse the one `anilist` uses.)

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/watchdog.test.ts && npx tsc --noEmit`
Expected: all pass (the unique-names test still passes).

- [ ] **Step 5: Commit**

```bash
git add src/dependencies.ts tests/watchdog.test.ts
git commit -m "Watch that both model tiers' OpenRouter models are still offered"
```

---

### Task 6: The LVL control

**Files:**
- Create: `public/level.js`
- Modify: `public/index.html:30`, `public/results.html:9` (hidden `tier` input; the control mounts itself)
- Modify: `public/app.js` (mount), `public/results.js` (mount; tier on `/api/web` and `/api/mode`; rerun on change; status suffix)
- Modify: `public/style.css` (LVL styles near `.searchbar`)

**Interfaces:**
- Produces: `export function mountLevel(form, {onChange})` in `public/level.js`; returns `{get(): 'ssj3'|'ssj1'}`. The form's hidden `<input type="hidden" name="tier">` holds `''` for SSJ3 (so URLs stay clean) and `'ssj1'` for SSJ1.

- [ ] **Step 1: Add the hidden input** — in both HTML files, inside `.searchbar`, directly before the Search button:

```html
<input type="hidden" name="tier" value="">
```

- [ ] **Step 2: Create `public/level.js`**

```js
// The LVL control: which model tier runs the search. SSJ3 is the full model architecture; SSJ1 runs the same steps on
// lower-cost models. The choice lives in the form's hidden "tier" field ('' for SSJ3, so URLs stay clean), is kept in
// the URL by the form, and is remembered in this browser when storage is available.
const LEVELS=[{value:'ssj3',label:'SSJ3',note:'Full models: the most accurate results.'},
 {value:'ssj1',label:'SSJ1',note:'Lower-cost models: the same steps, cheaper to run.'}];
const KEY='zenatlas-level';
const load=()=>{try{return localStorage.getItem(KEY);}catch{return null;}};
const save=value=>{try{localStorage.setItem(KEY,value);}catch{}};

export function mountLevel(form,{onChange}={}){
 const field=form.elements.namedItem('tier');
 const fromURL=new URLSearchParams(window.location.search).get('tier');
 const start=fromURL==='ssj1'||fromURL==='ssj3'?fromURL:load()==='ssj1'?'ssj1':'ssj3';
 field.value=start==='ssj1'?'ssj1':'';
 const wrap=document.createElement('div');wrap.className='level';
 const button=document.createElement('button');button.type='button';button.className='level-button';
 button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
 const menu=document.createElement('ul');menu.className='level-menu';menu.setAttribute('role','listbox');menu.hidden=true;
 menu.setAttribute('aria-label','Model level');
 const get=()=>field.value==='ssj1'?'ssj1':'ssj3';
 const options=LEVELS.map(level=>{
  const li=document.createElement('li');li.setAttribute('role','option');li.tabIndex=-1;li.dataset.value=level.value;
  const name=document.createElement('strong');name.textContent=level.label;
  const note=document.createElement('span');note.textContent=level.note;
  li.append(name,note);
  li.addEventListener('click',()=>choose(level.value));
  li.addEventListener('keydown',event=>{
   if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(level.value);}
   else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();
    const all=[...menu.children],next=all[(all.indexOf(li)+(event.key==='ArrowDown'?1:all.length-1))%all.length];next.focus();}
   else if(event.key==='Escape'){event.preventDefault();close(true);}
  });
  menu.append(li);return li;
 });
 const draw=()=>{button.textContent=`LVL · ${get().toUpperCase()}`;
  for(const li of options)li.setAttribute('aria-selected',String(li.dataset.value===get()));};
 const open=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');(options.find(li=>li.dataset.value===get())??options[0]).focus();};
 function close(focus){menu.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus();}
 function choose(value){
  const changed=value!==get();
  field.value=value==='ssj1'?'ssj1':'';save(value);draw();close(true);
  if(changed)onChange?.(value);
 }
 button.addEventListener('click',()=>menu.hidden?open():close(false));
 button.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();open();}});
 document.addEventListener('pointerdown',event=>{if(!wrap.contains(event.target))close(false);});
 wrap.append(button,menu);
 const submit=form.querySelector('.searchbar button[type="submit"]');
 submit.before(wrap);
 draw();
 return {get};
}
```

- [ ] **Step 3: Mount it**

`public/app.js` (home page): add at the top `import {mountLevel} from './level.js';` — `app.js` is loaded with `type="module"`, so imports work — and after the `form` line: `mountLevel(form);`.

`public/results.js`: add `import {mountLevel} from './level.js';` next to the existing import, and after `applyParamsFromURL` is defined add:

```js
// Changing the level reruns the current search on the new models; the running search is discarded by the controller.
const level=mountLevel(form,{onChange:()=>{if(form.elements.namedItem('q').value)form.requestSubmit();}});
const levelTag=()=>level.get()==='ssj1'?' · SSJ1':'';
```

Then:
- In `searchWebPage`, after `const query=new URLSearchParams(...)`: `if(level.get()==='ssj1')query.set('tier','ssj1');`
- In `routeQuery`: `api(\`/api/mode?${new URLSearchParams({q,...(level.get()==='ssj1'?{tier:'ssj1'}:{})})}\`)`.
- Status lines: append `${levelTag()}` to the finished-status strings for videos (the `count?` branch at the `status.textContent=busy?...` statement) and web/docs (the `count?` branch in `searchWebPage`).
- `applyParamsFromURL` already copies `tier` from the URL into the hidden field (it fills any named form field); `mountLevel` runs after it on load, so the URL wins over storage.

The submit handler reruns the same query on the current tab when only the level changed, because `q===lastQuery` and a tab is chosen; the video search sends every form field, so `tier` reaches `/api/search` with no further change.

- [ ] **Step 4: Styles** — in `public/style.css` after the `.searchbar button{...}` rule:

```css
/* LVL: the model level, beside Search. A small dropdown of SSJ3 and SSJ1, each with one line on what it means. */
.level{position:relative;display:flex}
.searchbar .level-button{background:transparent;color:var(--ink);border:1px solid var(--rule);margin-right:6px;padding:0 14px;white-space:nowrap}
.searchbar .level-button:hover{background:var(--wash)}
.level-menu{position:absolute;right:6px;top:calc(100% + 8px);z-index:30;min-width:260px;margin:0;padding:6px;list-style:none;
 background:var(--paper);border:1px solid var(--rule);border-radius:var(--r-md);box-shadow:0 8px 24px rgb(0 0 0 / .12)}
.level-menu li{display:grid;gap:2px;padding:10px 12px;border-radius:var(--r-md);cursor:pointer;outline-offset:-2px}
.level-menu li:hover,.level-menu li:focus{background:var(--wash)}
.level-menu li[aria-selected="true"] strong::after{content:' ✓'}
.level-menu strong{font-size:13px;letter-spacing:.08em}
.level-menu span{font-size:12px;color:var(--ink-2)}
@media (max-width:560px){.searchbar .level-button{padding:0 10px;font-size:9px}.level-menu{min-width:220px}}
```

- [ ] **Step 5: Browser check** (API restarted: `npx pm2 restart zenatlas-api zenatlas-worker`). Write `lvl.tmp.mjs` in the repo root:

```js
import {chromium} from 'playwright';
const b=await chromium.launch();
for(const vp of [{width:1400,height:900},{width:390,height:844}]){
 const p=await b.newPage({viewport:vp});p.on('pageerror',e=>console.log('pageerror',e.message));
 await p.goto('http://127.0.0.1:3000/results.html?q=python+asyncio+tutorial&tab=docs');
 await p.waitForSelector('.web-item',{timeout:120000});
 console.log(vp.width,'button:',await p.locator('.level-button').innerText());
 await p.locator('.level-button').click();
 await p.screenshot({path:`output/playwright/lvl-menu-${vp.width}.png`});
 const reran=p.waitForResponse(r=>r.url().includes('/api/web')&&r.url().includes('tier=ssj1'),{timeout:120000});
 await p.locator('.level-menu li[data-value="ssj1"]').click();
 await reran;
 console.log(vp.width,'url:',p.url().split('?')[1],'| button:',await p.locator('.level-button').innerText());
 await p.reload();await p.waitForSelector('.level-button');
 console.log(vp.width,'after reload:',await p.locator('.level-button').innerText());
 await p.keyboard.press('Tab');await p.locator('.level-button').focus();await p.keyboard.press('ArrowDown');
 await p.keyboard.press('Escape');
 console.log(vp.width,'menu closed by Esc:',await p.locator('.level-menu').isHidden());
 await p.close();
}
const priv=await (await b.newContext({storageState:undefined})).newPage();
await priv.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked');}});});
await priv.goto('http://127.0.0.1:3000/');
console.log('storage blocked:',await priv.locator('.level-button').innerText());
await b.close();
```

Run: `node lvl.tmp.mjs; rm lvl.tmp.mjs`
Expected: button `LVL · SSJ3`; after choosing SSJ1 the URL contains `tier=ssj1`, a `/api/web` call with `tier=ssj1` happens, the button reads `LVL · SSJ1`, stays SSJ1 after reload, Esc closes the menu, and with storage blocked the home page shows `LVL · SSJ3`. Look at both screenshots.

- [ ] **Step 6: Commit**

```bash
git add public/level.js public/app.js public/results.js public/index.html public/results.html public/style.css
git commit -m "Add the LVL control to choose SSJ3 or SSJ1 beside Search"
```

---

### Task 7: Compare SSJ1 with SSJ3 on real queries

**Files:**
- Create: `scripts/compare-tiers.ts`
- Output: `output/tier-comparison-2026-09-27.json`, report in chat

**Interfaces:**
- Consumes: the live API (`/api/web`, `/api/web/review`, `/api/docs/hunt`, `/api/search`), OpenRouter `GET /api/v1/key` (key usage in USD), PM2 log (`council`, `web_review` lines).

- [ ] **Step 1: Write the script** — `scripts/compare-tiers.ts`:

```ts
// Runs the same real queries on SSJ3 and SSJ1 against the running app, one at a time, and records per search: results
// kept after review, latency until the review finished, and the OpenRouter spend for that search (key usage before and
// after; the critic lane is paused by running while nothing else searches). A grader model then scores every kept
// result 0-2 for fit, blind to the tier. Writes output/tier-comparison-<date>.json.
import { writeFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:3000', KEY = process.env.OPENROUTER_API_KEY!;
const GRADER = 'anthropic/claude-sonnet-5';
const QUERIES: {q: string; kind: 'web'|'docs'|'videos'}[] = [
 {q: 'Gen X Soft Club aesthetic', kind: 'web'}, {q: 'free websites to remove video background', kind: 'web'},
 {q: 'rtx 5090 teardown', kind: 'web'}, {q: 'y2k visual design style catalogue', kind: 'docs'},
 {q: 'IPCC AR6 synthesis report 2023', kind: 'docs'}, {q: 'python asyncio tutorial', kind: 'docs'},
 {q: 'underrated osint tools', kind: 'videos'}, {q: 'ghost story short film', kind: 'videos'}];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const usage = async () => (await (await fetch('https://openrouter.ai/api/v1/key', {headers: {Authorization: `Bearer ${KEY}`}})).json()).data.usage as number;
const get = async (path: string, cookie = '') => { const r = await fetch(BASE + path, {headers: cookie ? {cookie} : {}}); return {r, body: await r.json()}; };
type Kept = {url: string; title: string; snippet: string|null};

async function webOrDocs(q: string, kind: 'web'|'docs', tier: string): Promise<Kept[]> {
 const {body} = await get(`/api/web?${new URLSearchParams({q, kind, tier, exact: '1'})}`);
 if (body.review) for (let i = 0; i < 90; i++) { const s = (await get(`/api/web/review?token=${body.review}`)).body;
   if (s.status === 'complete') return (s.results ?? []).map((r: any) => ({url: r.url, title: r.title, snippet: r.snippet})); await sleep(2000); }
 if (body.hunt) for (let i = 0; i < 90; i++) { const s = (await get(`/api/docs/hunt?token=${body.hunt}`)).body;
   if (s.status === 'complete') return s.documents.filter((d: any) => d.state === 'kept').map((d: any) => ({url: d.url, title: d.title, snippet: d.snippet})); await sleep(2000); }
 return body.results.map((r: any) => ({url: r.url, title: r.title, snippet: r.snippet}));
}
async function videos(q: string, tier: string): Promise<Kept[]> {
 const first = await fetch(`${BASE}/api/search?${new URLSearchParams({q, tier, mode: 'refresh', limit: '20'})}`);
 const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]; let s = await first.json();
 for (let i = 0; i < 150 && s.status !== 'complete' && s.status !== 'failed'; i++) { await sleep(3000); s = (await get(`/api/search/${s.search_id}`, cookie)).body; }
 return (s.results ?? []).map((r: any) => ({url: r.url, title: r.title, snippet: r.description ?? null}));
}
async function grade(q: string, items: Kept[]): Promise<number[]> {
 if (!items.length) return [];
 const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {method: 'POST', headers: {Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json'},
   body: JSON.stringify({model: GRADER, temperature: 0, max_tokens: 4000, response_format: {type: 'json_object'}, messages: [
     {role: 'system', content: 'Grade each search result for the request: 2 = clearly what was asked, 1 = related but partial, 0 = off-topic or wrong. Judge from title, address and snippet only. Answer JSON {"grades":[numbers in order]}.'},
     {role: 'user', content: JSON.stringify({request: q, results: items.map((x, i) => ({i, title: x.title, url: x.url, snippet: x.snippet?.slice(0, 300)}))})}]})});
 const g = JSON.parse((await r.json()).choices[0].message.content).grades as number[];
 return items.map((_, i) => Number(g[i] ?? 0));
}
const rows: unknown[] = [];
for (const {q, kind} of QUERIES) for (const tier of ['ssj3', 'ssj1']) {
 const before = await usage(), started = Date.now();
 const kept = kind === 'videos' ? await videos(q, tier) : await webOrDocs(q, kind, tier);
 const ms = Date.now() - started; await sleep(3000); const cost = (await usage()) - before;
 rows.push({q, kind, tier, kept: kept.length, ms, cost_usd: Number(cost.toFixed(5)), items: kept.slice(0, 15)});
 console.log(`${tier} ${kind} "${q}": ${kept.length} kept, ${(ms / 1000).toFixed(1)} s, $${cost.toFixed(4)}`);
}
// Grading is blind to tier: each query's results from both tiers are pooled, de-duplicated and graded together.
for (const {q} of QUERIES) {
 const mine = rows.filter((r: any) => r.q === q) as any[];
 const pool = [...new Map(mine.flatMap(r => r.items).map((x: Kept) => [x.url, x])).values()].sort(() => Math.random() - 0.5);
 const grades = new Map(pool.map((x, i) => [x.url, 0] as [string, number]));
 (await grade(q, pool)).forEach((g, i) => grades.set(pool[i].url, g));
 for (const r of mine) r.grades = r.items.map((x: Kept) => grades.get(x.url));
}
const file = `output/tier-comparison-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(rows, null, 1)); console.log('wrote', file);
```

- [ ] **Step 2: Run it**

Pause the critic lane's spend noise: nothing else should search while it runs. Then:
`node --env-file-if-exists=.env --import tsx scripts/compare-tiers.ts`
Expected: 16 lines (8 queries × 2 tiers) and the output file. Also collect council lines: `grep '"event":"council"' ~/.pm2/logs/zenatlas-api-out.log ~/.pm2/logs/zenatlas-worker-out.log | tail -40` — lines with checker `openai/gpt-5.6-luna` are SSJ1, `openai/gpt-5.6-terra` SSJ3.

- [ ] **Step 3: Compute the report** from the JSON: per tier — mean kept, precision (share of kept top-10 graded 2; also mean grade), nDCG-style "good results in top 5", overlap of kept URLs between tiers (Jaccard per query), median latency, total and per-search cost, council agreement and dispute rate. Score each tier out of 10 on accuracy (precision relative to the better tier), cost (inverse relative cost), speed, and an overall weighted score (accuracy 60 %, cost 25 %, speed 15 %). State the grader model and that one run per query is a small sample.

- [ ] **Step 4: Commit the script** (not the output)

```bash
git add scripts/compare-tiers.ts
git commit -m "Add a script comparing SSJ1 with SSJ3 on real queries"
```
