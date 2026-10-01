# Query Remake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The planner pictures the video that answers a request before writing searches, and the expansion round remakes searches from that picture plus the real titles found, so the right video gets retrieved.

**Architecture:** One more section in the planner's existing JSON reply (`target`), carried on `SearchPlan` into the trace and into the link-expansion rewriter. The rewriter also returns an optional name, kept only if grounded in the real titles, which reaches the judge. The name-first per-search identify call is removed.

**Tech Stack:** TypeScript (Node 24, tsx), zod, node:test, OpenRouter via `OpenAICompatibleClient`, Brave video search.

**Spec:** `docs/superpowers/specs/2026-10-01-query-remake-design.md`

## Global Constraints

- Branch `name-first` (on top of 8b31e0f / d06cfba). Never commit `.env`; never commit `output/`.
- Lead planner `openai/gpt-6-luna`; live value `PLANNER_MODELS=openai/gpt-6-luna,google/gemma-4-31b-it,mistralai/ministral-14b-2512,inception/mercury-2.5` (set in `.env` only in Task 4, after the checks pass).
- Backend only: `target` and names go to traces and logs, never to searcher-facing text (provider notes included).
- Keep the request's meaning: the picture and the searches never add or drop a detail; no invented names.
- Probes and live checks run with captions off (`YOUTUBE_CAPTIONS=false`) so YouTube does not block this address.
- Tests: `npm test` (node:test, `tests/*.test.ts`); typecheck `npx tsc --noEmit -p .`. Match the file's code style (dense, `//` comments explaining why).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Planner reply with `target` missing, `null`, or wrong-shaped: searches must still be used and the plan must not fail (Task 1 test).
- Assist planner (Gemma) leads when Luna fails: its plan may carry no `target`; the expansion must still run without one (Task 3 test passes `undefined` target).
- Rewriter returns a name that is a whole title, ungrounded, or empty string: dropped, nothing reaches the judge (Task 3 test).
- Rewriter returns markdown or a search already run: cleaned and deduplicated as today (existing `cleanDecision` plus Task 3 test).
- Scoped searches (`input.source`) and `site:` queries: no picture needed and no expansion change; existing tests keep covering them (run full suite each task).

---

### Task 1: The planner pictures the answer

**Files:**
- Modify: `src/planner.ts` (prompt constants, `RESPONSE_SCHEMA`, `reply`, `SearchPlan`, `normalisePlan`)
- Modify: `src/learning.ts:39` (trace `plan` type)
- Modify: `src/discovery.ts` (`traceOf`: `plan: {kind, criteria, model}` → add `target`)
- Test: `tests/planning.test.ts`

**Interfaces:**
- Produces: `export interface SearchTarget` is taken (search target type) — name the new type `AnswerPicture`:
  `export interface AnswerPicture { titles: string[]; channel: string; spoken: string[]; wording: {request: string; creators: string[]}[] }`
  and `SearchPlan.target?: AnswerPicture`. Trace: `plan: {kind: string; criteria: string[]; model: string|null; target?: AnswerPicture}`.

- [ ] **Step 1: Write the failing tests** (append to `tests/planning.test.ts`; `ModelPlanner` and `testConfig` are already imported)

```ts
test('the planner pictures the answer first and keeps the picture on the plan',async()=>{
 const target={titles:['MrBeast Surprises Fan With A PS5'],channel:'MrBeast',spoken:['this is for you'],wording:[{request:'subscriber',creators:['fan','viewer']}]};
 let system='';
 const client:any={models:['m'],async json(_b:string,s:string){system=s;return {model:'m',value:{kind:'videos',target,
   searches:[{query:'MrBeast surprises fan with a PS5',target:'videos'}],criteria:['MrBeast gives a PS5']}};}};
 const plan=await new ModelPlanner(client,{...testConfig,REQUIREMENTS_ENABLED:false}).plan('mr beast giving ps5 to his subscriber');
 assert.match(system,/picture the video/i);
 assert.deepEqual(plan.target,target);
 assert.ok(plan.searches.some(s=>s.query==='MrBeast surprises fan with a PS5'));
});

test('a missing or malformed picture never costs the plan its searches',async()=>{
 for(const bad of [undefined,null,{titles:'one'},{titles:[],channel:3}]){
   const client:any={models:['m'],async json(){return {model:'m',value:{kind:'videos',target:bad,searches:[{query:'cat glass slow motion',target:'videos'}],criteria:[]}};}};
   const plan=await new ModelPlanner(client,{...testConfig,REQUIREMENTS_ENABLED:false}).plan('cat pushing glass of table slow mo');
   assert.equal(plan.target,undefined);
   assert.ok(plan.searches.some(s=>s.query==='cat glass slow motion'));
 }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test --test-name-pattern="pictures the answer|malformed picture" tests/planning.test.ts`
Expected: FAIL (`plan.target` undefined in the first; system prompt lacks "picture the video").

- [ ] **Step 3: Implement** in `src/planner.ts` (edit with a script or Edit tool; the file contains non-ASCII so use exact matches)

Add after the `KIND` constant:

```ts
// Picture the answer first (spec 2026-10-01-query-remake): searches written from how the video would be titled find it
// far more often than the request's own words (Brave-only benchmark: 70% of known-good videos against 41% as typed).
const PICTURE = `Before writing searches, picture the video or page that best answers the request as it would appear online, and return it as target:
- titles: 2 or 3 titles exactly as its uploader would write them;
- channel: the kind of channel or site that publishes it, and its name when you are sure;
- spoken: 2 or 3 short phrases said or shown in it;
- wording: how creators and viewers word each idea of the request (for "subscriber" they may say "fan" or "viewer"); an empty list when the request already uses their words.
When you do not know the real title, write the most likely one and do not invent names. Write your searches from this picture: likely title wording first, then names, then other wordings.`;
const PICTURE_SCHEMA = {type: 'object', required: ['titles', 'channel', 'spoken', 'wording'], properties: {
 titles: {type: 'array', items: {type: 'string'}}, channel: {type: 'string'}, spoken: {type: 'array', items: {type: 'string'}},
 wording: {type: 'array', items: {type: 'object', required: ['request', 'creators'], properties: {request: {type: 'string'}, creators: {type: 'array', items: {type: 'string'}}}}}}};
const picture = z.object({titles: z.array(z.string().trim().max(200)).max(5), channel: z.string().trim().max(120),
 spoken: z.array(z.string().trim().max(200)).max(5),
 wording: z.array(z.object({request: z.string().trim().max(80), creators: z.array(z.string().trim().max(80)).max(6)})).max(8)});
export type AnswerPicture = z.infer<typeof picture>;
```

In both `SYSTEM_INSTRUCTION` and `DEEP_INSTRUCTION`, insert the line `${PICTURE}` directly after the `${KIND}` line.
Add `target: PICTURE_SCHEMA` to `RESPONSE_SCHEMA.properties` and `'target'` to its `required`.
Keep `reply` strict for the other fields but parse the picture separately so a bad one is dropped:

```ts
const reply = z.object({kind: z.enum(['videos', 'websites', 'mixed']), searches, criteria: z.array(z.string()), target: z.unknown().optional()});
```

Change `SearchPlan` to `{ kind: ...; searches: PlannedSearch[]; criteria: string[]; model: string|null; draft?: unknown; target?: AnswerPicture }`.
In `normalisePlan`, after `criteria`:

```ts
 const target = picture.safeParse(raw.target);
 return {kind: raw.kind, searches: uniqueSearches([...own, ...raw.searches], limit, avoid), criteria, model, ...(target.success ? {target: target.data} : {})};
```

In `ModelPlanner.plan`, the draft split must also drop `target`:
`const {kind: _kind, searches: _searches, criteria: _criteria, target: _target, ...draft} = answer.value as Record<string, unknown>;`

`EnsemblePlanner.plan` already spreads `plans[0]`, so the leading plan's `target` survives; no change.

In `src/learning.ts` change the trace plan type to `plan: {kind: string; criteria: string[]; model: string|null; target?: AnswerPicture};` (import type from `./planner.js`).
In `src/discovery.ts` `traceOf`, change `plan: {kind: plan.kind, criteria: plan.criteria, model: plan.model},` to
`plan: {kind: plan.kind, criteria: plan.criteria, model: plan.model, ...(plan.target ? {target: plan.target} : {})},`.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit -p . && node --import tsx --test tests/planning.test.ts`
Expected: PASS, all planning tests.

- [ ] **Step 5: Full suite and commit**

Run: `npm test` — Expected: 0 failures.

```bash
git add src/planner.ts src/learning.ts src/discovery.ts tests/planning.test.ts
git commit -m "Picture the answer before planning searches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Remove the per-search identify call

**Files:**
- Modify: `src/identify.ts` (keep only `grounded`, `nameLike`, `IdentifyMaterial`)
- Modify: `src/discovery.ts` (identify step, `isKnown`, `poolCap`, `identify` dep, trace `identify`)
- Modify: `src/config.ts` (remove `IDENTIFY_*`, `KNOWN_ITEM_CANDIDATES`, `SSJ1_IDENTIFY_MODEL`), `src/tiers.ts`, `src/learning.ts` (trace `identify` field → `named?: string`)
- Modify: `.env.example` (remove the identify block), `docs/superpowers/specs/2026-10-01-query-remake-design.md` (section 3: "`KNOWN_ITEM_CANDIDATES` is removed with the identify call")
- Test: `tests/identify.test.ts`, `tests/tiers.test.ts`, `tests/discovery.test.ts`

**Interfaces:**
- Produces: `export function grounded(name: string, material: IdentifyMaterial[]): boolean`, `export const nameLike: (name: string) => boolean`, `export interface IdentifyMaterial { title: string; description: string|null; creator: string|null }`.
- In `runDiscoveryImpl`: `let names: string[] = [];` declared where `names` was, assigned later by Task 3. Trace gains `named?: string` (first name) instead of `identify`.

- [ ] **Step 1: Rewrite the identify tests to the kept surface** (`tests/identify.test.ts` becomes)

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grounded, nameLike} from '../src/identify.js';

const material=[
 {title:'Free Solo | Official Trailer | National Geographic',description:'Alex Honnold attempts to climb El Capitan without a rope.',creator:'National Geographic'},
 {title:'Alex Honnold climbs El Capitan without ropes',description:null,creator:'Climbing Daily'},
];
test('a name is grounded only when every word of it appears in one result',()=>{
 assert.ok(grounded('Free Solo',material));
 assert.ok(grounded('Alex Honnold',material));
 assert.ok(!grounded('The Dawn Wall',material));
 assert.ok(!grounded('Free Solo Honnold Capitan Nat Geo',material));
 assert.ok(!grounded('the',material));
});
test('a name is a few words, not a whole result title',()=>{
 assert.ok(nameLike('Free Solo'));
 assert.ok(!nameLike('Free Solo | Official Trailer | National Geographic'));
 assert.ok(!nameLike('Free Solo - Alex Honnold Climbing El Capitan'));
 assert.ok(!nameLike('one two three four five six seven'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/identify.test.ts`
Expected: FAIL — `nameLike` is not exported.

- [ ] **Step 3: Implement**
- `src/identify.ts`: delete `Identification`, `IdentifyDeps`, `SYSTEM`, `SCHEMA`, `reply`, the cache, `modelDeps`, `identify`, `knownItem`, `uses`, and the `OpenAICompatibleClient`/`z`/`DB`/`Config` imports. Export `nameLike` (`export const nameLike = ...`). Update the header comment: names are grounded in real result titles before anything uses them (the link-expansion rewriter proposes them).
- `src/discovery.ts`: delete the `identify?:` line from `DiscoveryDeps`; delete the block from `mark('searched');`'s following comment through `mark('identified');` except keep `mark('searched');` and add `let names: string[] = [];`; restore `rounds < config.DEEP_ROUNDS`, `rounds: deep ? config.GAP_ROUNDS : 1`, remove `name: names[0] ?? null` from `exploreGaps` args only if `names` is empty at that point (it is: expansion runs later) — so remove it; delete `poolCap` and use `config.DISCOVERY_CANDIDATES` in `store`; replace `...(identity ? {identify: {...identity, known: isKnown}} : {})` with `...(names[0] ? {named: names[0]} : {})`; fix the import to `import { grounded, nameLike } from './identify.js';`.
- `src/learning.ts`: replace the `identify?:` trace field with `// A name the expansion round grounded in real titles (src/link-expansion.ts).\n named?: string;`.
- `src/config.ts`: delete the `IDENTIFY_*` block, `KNOWN_ITEM_CANDIDATES`, `SSJ1_IDENTIFY_MODEL`. `src/tiers.ts`: delete `IDENTIFY_MODEL: config.SSJ1_IDENTIFY_MODEL`. `tests/tiers.test.ts`: remove `'IDENTIFY_MODEL',` from the expected list.
- `tests/discovery.test.ts`: delete the test `a confidently identified known item is searched by name, checked from a smaller pool, and named to the judge` (Task 3 adds its replacement).
- `.env.example`: delete the 8-line `# Name it first` block. Spec: update section 3 as listed above.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add -A src tests .env.example docs/superpowers/specs/2026-10-01-query-remake-design.md
git commit -m "Drop the per-search identify call; keep its name checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The expansion round remakes searches from the picture and real titles

**Files:**
- Modify: `src/link-expansion.ts` (`LinkRewriter`, prompt, `SCHEMA`, `rewriterFrom`)
- Modify: `src/discovery.ts` (expansion call site; names → judge context and trace)
- Test: `tests/link-expansion.test.ts`, `tests/discovery.test.ts`

**Interfaces:**
- Consumes: `SearchPlan.target?: AnswerPicture` (Task 1); `grounded`, `nameLike` (Task 2).
- Produces:
  `export type LinkRewriter = (query: string, requirements: {id: string; text: string}[], ran: string[], found?: string[], target?: AnswerPicture) => Promise<{searches: string[]; name: string|null}>;`

- [ ] **Step 1: Write the failing tests**

Replace the two rewriter tests in `tests/link-expansion.test.ts` with:

```ts
test('the rewriter keeps new, non-empty, plain searches up to the limit and returns its name', async () => {
 const rewrite = rewriterFrom(async () => ({complete: false, missing: 'x', name: 'MrBeast', searches: ['mrbeast ps5 giveaway fan', 'mr beast buys ps5 to a subscriber', '', '**surprising a viewer** with a ps5', 'third', 'fourth']}), 3);
 assert.deepEqual(await rewrite('q', [{id: 'R1', text: 't'}], ['mr beast buys ps5 to a subscriber']),
   {searches: ['mrbeast ps5 giveaway fan', 'surprising a viewer with a ps5', 'third'], name: 'MrBeast'});
});

test('the rewriter is shown the picture and at most ten titles; an empty name is none', async () => {
 let sent: any;
 const rewrite = rewriterFrom(async text => { sent = JSON.parse(text as string); return {complete: false, missing: 'x', name: '', searches: ['a b c']}; }, 2);
 const target = {titles: ['MrBeast Surprises Fan With A PS5'], channel: 'MrBeast', spoken: [], wording: [{request: 'subscriber', creators: ['fan']}]};
 const out = await rewrite('q', [], [], Array.from({length: 12}, (_, i) => `Title ${i} — Channel`), target);
 assert.equal(sent.titles_found.length, 10);
 assert.deepEqual(sent.picture, target);
 assert.equal(out.name, null);
});
```

In `tests/discovery.test.ts`, in the test `too few strong candidates after screening trigger one rewritten search round before judging`, change the mock to
`const linkRewriter=async(_q:string,_r:any,ran:string[])=>{rewrites.push(ran);return {searches:['giveaway ps5 to a fan'],name:null};};`
and append a new test:

```ts
test('the expansion name reaches the judge only when real titles carry it, and the picture reaches the rewriter',async()=>{
 const db=await database();
 try{
   const weak=[0,1].map(i=>contentInput.parse({url:`https://www.youtube.com/watch?v=weak0000${i}xx`,title:`MrBeast reaction ${i}`}));
   const fan=contentInput.parse({url:'https://www.youtube.com/watch?v=fanfan0000x',title:'MrBeast Surprises Fan With A PS5'});
   const provider:SourceAdapter={name:'remake-fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(q){return {results:q==='MrBeast surprises fan with a PS5'?[fan]:weak,next_cursor:null,status:{provider:'remake-fixture',status:'ok',message:'TEST'}};}};
   const target={titles:['MrBeast Surprises Fan With A PS5'],channel:'MrBeast',spoken:[],wording:[{request:'subscriber',creators:['fan']}]};
   const planner:Planner={async plan(q){return {kind:'videos',searches:[{query:q,target:'videos'}],criteria:[],model:'test',target};}};
   const screener:Screener={async screen(_q,cs){return {screened:cs.length,promising:new Set(),decisions:cs.map(c=>({url:c.item.url,model:'jev',promoted:false,
     choice:'uncertain' as const,confidence:0.5,probabilities:{promising:0.1,uncertain:0.2,mismatch:0.7}}))};}};
   let seen:any,given:any;
   const judge:Judge={async judge(_q,cs,context){seen=context;return {model:'j',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:6,reason:'r',momentKeys:[]}]))};}};
   const run=(name:string)=>runDiscovery(db,{...baseConfig,REQUIREMENTS_ENABLED:true},searchInput.parse({q:'mr beast giving ps5 to his subscriber'}),[provider],
     {planner,judge,screener,linkRewriter:async(_q,_r,_ran,_found,t)=>{given=t;return {searches:['MrBeast surprises fan with a PS5'],name};}},async()=>{});
   const out=await run('MrBeast');
   assert.deepEqual(given,target,'the rewriter sees the picture');
   assert.deepEqual(seen?.identified,['MrBeast'],'a name the titles carry reaches the judge');
   assert.equal((out.trace as any).named,'MrBeast');
   await run('Jimmy Donaldson');
   assert.equal(seen?.identified,undefined,'a name no title carries is dropped');
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test tests/link-expansion.test.ts && node --import tsx --test --test-concurrency=1 --test-name-pattern="expansion name|rewritten search round" tests/discovery.test.ts`
Expected: FAIL (rewriter returns an array; no picture sent; judge context lacks `identified`).

- [ ] **Step 3: Implement**

`src/link-expansion.ts`:

```ts
import type { AnswerPicture } from './planner.js';
// found: the best candidates so far, "title — channel". target: the planner's picture of the answer (src/planner.ts).
export type LinkRewriter = (query: string, requirements: {id: string; text: string}[], ran: string[], found?: string[], target?: AnswerPicture) =>
 Promise<{searches: string[]; name: string|null}>;
const SCHEMA = {type: 'object', properties: {complete: {type: 'boolean'}, missing: {type: 'string'}, name: {type: 'string'},
 searches: {type: 'array', items: {type: 'string'}}}, required: ['complete', 'missing', 'name', 'searches']};
```

Replace the `system` prompt text with:

```ts
const system = (max: number) => `A video search found too little for a request. Write up to ${max} new video searches (YouTube-style titles or
phrases) that would find videos meeting the requirements. picture is how the answer was imagined before searching; titles_found are
the best candidates the search really found. Prefer the words, names and channels titles_found use for this subject over the
request's own words (for "to a subscriber" the titles may say "surprises a fan"). Add no detail the request does not ask for.
Plain search text only, no markup. name: what the titles show the request is about (a video, film, show or creator), written as
in the titles, or an empty string. Each search must differ from the searches already run. Answer JSON
{"complete": false, "missing": string, "name": string, "searches": [string]}.`;
```

`rewriterFrom`:

```ts
export function rewriterFrom(ask: (text: string) => Promise<unknown>, max: number): LinkRewriter {
 return async (query, requirements, ran, found = [], target) => {
   const raw = await ask(JSON.stringify({request: query, requirements, searches_already_run: ran, titles_found: found.slice(0, 10), ...(target ? {picture: target} : {})}));
   const name = raw && typeof raw === 'object' && typeof (raw as {name?: unknown}).name === 'string' ? (raw as {name: string}).name.trim().slice(0, 120) : '';
   return {name: name || null, searches: cleanDecision(raw, ran, max).searches.map(q => q.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean)};
 };
}
```

`src/discovery.ts`, expansion call site (replace the `rewritten` line):

```ts
   const remade = rewriter ? await rewriter(input.q, hardEach(contract).map(r => ({id: r.id, text: r.text})), ran.map(s => s.query), found, plan.target)
     .catch(() => ({searches: [] as string[], name: null})) : {searches: [] as string[], name: null};
   // A name counts only when the titles the search really found carry it (src/identify.ts); it is a lead for the judge.
   const titles = picks.slice(0, 10).map(l => ({title: l.item.title, description: l.item.description ?? null, creator: l.item.creator ?? null}));
   if (remade.name && nameLike(remade.name) && grounded(remade.name, titles)) names = [remade.name];
   const wanted = [...remade.searches, ...creators.slice(0, 1).map(name => creatorSearch(name, terms))];
```

(`found` is the existing `picks.slice(0, 10)` "title — channel" list; `names` already flows to `applySignals` as `identified` and into the trace as `named`.) Add `named: !!names.length` to the `link_expansion` log line.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit -p . && npm test`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/link-expansion.ts src/discovery.ts tests/link-expansion.test.ts tests/discovery.test.ts
git commit -m "Remake expansion searches from the picture and the titles found" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Benchmarks, live check, go live

**Files:**
- Modify: `scripts/query-remake-bench.ts` (planner mode and second-pass mode)
- Modify: `.env` (not committed), `.env.example` (`PLANNER_MODELS` comment)

- [ ] **Step 1: Add bench modes.** `node ... query-remake-bench.ts <runs> <models> [prompt|planner|second]`, default `prompt` (current behaviour).
  - `planner`: `const planner = makePlanner(db, {...config, PLANNER_MODELS: models.join(','), REQUIREMENTS_ENABLED: true})!;` then per case `const plan = await planner.plan(q); searches = plan.searches.filter(s => s.target === 'videos').map(s => s.query).slice(0, 5);` and score `found(searches, good)` as today; record `plan.target?.titles`.
  - `second` (cases `mrbeast_ps5`, `reincarnated` only): first round = `[q, ...plan.searches]` through `search()`; take the first 10 Brave results' titles for those searches (extend `search` to return `{url, title, creator}`), call `rewriterFrom(async text => (await client.json('bench_remake', <the system prompt exported from link-expansion>, text, <SCHEMA exported>)).value, 4)` with `(q, [], ranQueries, titles, plan.target)`, score the remade searches. Export `system` and `SCHEMA` from `src/link-expansion.ts` as `REWRITE_SYSTEM` and `REWRITE_SCHEMA` for this.
- [ ] **Step 2: Bench 1.** Run `node --env-file-if-exists=.env --import tsx scripts/query-remake-bench.ts 3 openai/gpt-6-luna,google/gemma-4-31b-it,mistralai/ministral-14b-2512,inception/mercury-2.5 planner`. Pass: mean recall ≥ 70%.
- [ ] **Step 3: Bench 2.** Run with `second`. Pass: `MrBeast surprises fan with a PS5` (`output/query-remake-truth.json` mrbeast_ps5) retrieved in at least 2 of 3 runs.
- [ ] **Step 4: Live check (3 searches, captions off).** Use `scripts/probe-name-first.ts` with env `YOUTUBE_CAPTIONS=false` and `PLANNER_MODELS=<live value>` on the branch, and the main worktree with `YOUTUBE_CAPTIONS=false` for queries 0, 4, 2 (alternate order). Pass: branch shows ≥ main results on at least 2 of 3 and no search more than 30 s slower.
- [ ] **Step 5: Go live.** Only if steps 2-4 pass and the user agrees: merge `name-first` into `main`, set `PLANNER_MODELS` in `.env`, add the live value as a comment in `.env.example`, `pm2 restart zenatlas-worker zenatlas-api --update-env && pm2 save` with no jobs in flight, commit bench script changes.
