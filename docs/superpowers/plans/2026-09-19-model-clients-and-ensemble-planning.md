# Model Clients and Ensemble Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the search planner run several models at once — Gemini plus any number of OpenRouter models — and merge their suggested queries without increasing the number of searches discovery actually runs.

**Architecture:** The provider-agnostic half of `GeminiClient` (fallback chain, cooldowns, budgets, health) moves into an abstract `ModelClient`; `GeminiClient` and a new `OpenAICompatibleClient` become thin subclasses that only know their own wire format. On top of that, `GeminiPlanner`'s logic moves into a `ModelPlanner` that works with any client, and an `EnsemblePlanner` composes a primary planner with assists, interleaving their query lists and capping the union at the existing limit.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), zod for parsing, node:test + node:assert/strict, tsx as the runner, embedded Postgres for tests.

**Spec:** `docs/superpowers/specs/2026-09-19-model-clients-and-ensemble-planning-design.md`

## Global Constraints

- **Keep the existing dense code style.** One-space indentation in `src/`, packed one-line bodies where the file already does that, comments that explain *why* rather than *what*. Match the file you are editing.
- **`tests/watchdog.test.ts` and `tests/planning.test.ts` must pass unchanged** through Tasks 1–4. Task 4 and Task 5 add new cases to `planning.test.ts` but must not alter existing ones.
- **Baseline is green:** `node --import tsx --test --test-concurrency=1 tests/watchdog.test.ts tests/planning.test.ts` → 20 pass, 0 fail. Tests use an embedded database; Docker is not required.
- **Do not touch** `src/signals.ts`, `src/judge.ts`, or `scene-worker/`.
- **`deps.planner` injection in `src/discovery.ts` stays exactly as it is** — `deps.planner ?? <fallback>`. Tests depend on it.
- **Every new import uses the `.js` specifier** (`./model-client.js`), matching the rest of `src/`.
- **Verification after every task:** `npm run build` (tsc --noEmit) and `npm test` must both pass before committing.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

### Task 1: Extract the provider-agnostic model client

Pure refactor. No behaviour change, no new tests — the existing suite is the gate.

**Files:**
- Create: `src/model-client.ts`
- Modify: `src/gemini.ts` (whole file, currently 100 lines)

**Interfaces:**
- Consumes: `fetchJSON`, `UpstreamError` from `./http.js`; `takeBudget` from `./budgets.js`; `providerHealth` from `./health.js`.
- Produces:
  - `export interface InlineImage { label: string; mimeType: 'image/jpeg'; data: Buffer }`
  - `export abstract class ModelClient` with `constructor(protected db: DB, protected config: Config, protected transport = fetchJSON)`, public `abstract get models(): string[]`, `protected abstract get provider(): string`, `protected abstract ask(model: string, system: string, text: string, schema: object, images: InlineImage[]): Promise<unknown>`, and public `json(bucket: string, system: string, text: string, schema: object, images?: InlineImage[]): Promise<{model: string; value: unknown}>`.
  - `src/gemini.ts` keeps exporting `ORIGIN`, `GeminiClient` and (re-exported) `InlineImage`, with `new GeminiClient(db, config, transport)` unchanged.

- [ ] **Step 1: Create `src/model-client.ts`**

Move lines 17–37 and the shared methods of `src/gemini.ts` verbatim, with the two changes noted in comments below.

```ts
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { providerHealth } from './health.js';

// Overload, rate limiting and timeouts are usually specific to one model, so the next configured model is tried. So is a
// model the provider no longer offers (404), which would otherwise switch AI off for every search despite working fallbacks.
const retryable = (error: unknown) => error instanceof UpstreamError &&
 (['rate_limited', 'timeout'].includes(error.code) || error.code === 'upstream_failure' && ((error.status ?? 0) >= 500 || error.status === 404));
// An overloaded model often stays overloaded for minutes and can take the whole timeout to fail, so it is tried last for a while.
// Most rate limits are per minute, so a rate-limited model is set aside for one minute; one whose daily quota is spent,
// or that no longer exists, is only tried again an hour later.
const cooldown = (error: unknown) => !(error instanceof UpstreamError) ? 5 * 60_000
 : error.status === 404 || error.code === 'rate_limited' && /PerDay/i.test(error.detail ?? '') ? 60 * 60_000
 : error.code === 'rate_limited' ? 60_000 : 5 * 60_000;
// Failures that say the model cannot be used right now (as opposed to an answer this app could not use), for the watchdog.
const unavailable = (error: unknown) => error instanceof UpstreamError && ['rate_limited', 'timeout', 'upstream_failure', 'network_error'].includes(error.code);
const failureCode = (error: UpstreamError) =>
 `${error.code === 'rate_limited' && /PerDay/i.test(error.detail ?? '') ? 'rate_limited_daily' : error.code}${error.status && error.code !== 'rate_limited' ? `_${error.status}` : ''}${error.detail ? ` ${error.detail}` : ''}`;
// Keyed by provider and model, so two providers offering the same model name never share a cooldown.
const coolingUntil = new Map<string,number>();
const perMinuteLimit = (error: unknown) => error instanceof UpstreamError && error.code === 'rate_limited' && !/PerDay/i.test(error.detail ?? '');
// The wait the API suggested, kept between 1 and 30 seconds; 10 seconds when it suggested none.
const retryDelayMs = (error: unknown) => {
 const seconds = Number(/retry=(\d+(?:\.\d+)?)s/.exec((error as UpstreamError).detail ?? '')?.[1] ?? 10);
 return Math.min(30_000, Math.max(1000, seconds*1000));
};
export interface InlineImage { label: string; mimeType: 'image/jpeg'; data: Buffer }

// The provider-independent half of a model client: which models to try in what order, when to set one aside, what to
// spend, and what to record. A subclass supplies only one provider's request and response shape.
export abstract class ModelClient {
 constructor(protected db: DB, protected config: Config, protected transport = fetchJSON) {}
 // Names this provider's health rows and cooldown keys, for example 'gemini'.
 protected abstract get provider(): string;
 abstract get models(): string[];
 protected abstract ask(model: string, system: string, text: string, schema: object, images: InlineImage[]): Promise<unknown>;
 private key(model: string) { return `${this.provider}:${model}`; }
 // Returns the parsed JSON reply and the model that produced it. Each attempt spends one unit of the named daily budget.
 // Each image follows the text, introduced by its label.
 async json(bucket: string, system: string, text: string, schema: object, images: InlineImage[] = []): Promise<{model: string; value: unknown}> {
   const now = Date.now();
   const cooling = (m: string) => (coolingUntil.get(this.key(m)) ?? 0) > now;
   const failures = new Map<string,unknown>();
   try {
     return await this.attempt([...this.models.filter(m => !cooling(m)), ...this.models.filter(cooling)], failures, bucket, system, text, schema, images);
   } catch (error) {
     // A per-minute limit clears within the minute, so the models held back only by one are tried once more after a wait.
     const waiting = [...failures].filter(([, e]) => perMinuteLimit(e));
     if (!waiting.length) throw error;
     await new Promise(resolve => setTimeout(resolve, Math.min(...waiting.map(([, e]) => retryDelayMs(e)))));
     return this.attempt(waiting.map(([m]) => m), new Map(), bucket, system, text, schema, images);
   }
 }
 private async attempt(models: string[], failures: Map<string,unknown>, bucket: string, system: string, text: string, schema: object, images: InlineImage[]) {
   for (const [i, model] of models.entries()) {
     if (!await takeBudget(this.db, bucket, this.config.JUDGE_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
     try {
       const value = await this.ask(model, system, text, schema, images);
       coolingUntil.delete(this.key(model));
       await this.record(model, null);
       return {model, value};
     } catch (error) {
       failures.set(model, error);
       await this.record(model, error);
       if (retryable(error)) coolingUntil.set(this.key(model), Date.now() + cooldown(error));
       if (i === models.length - 1 || !retryable(error)) throw error;
     }
   }
   throw new UpstreamError('model_unavailable');
 }
 // Each model's run of failed calls, shown by the watchdog. A reply this app could not use still shows the model is up.
 private async record(model: string, error: unknown) {
   const down = unavailable(error);
   await providerHealth(this.db, this.key(model), !down, down ? failureCode(error as UpstreamError) : undefined).catch(() => {});
 }
}
```

Two deliberate differences from the original, both invisible to existing behaviour:
- `coolingUntil` is keyed `provider:model` instead of bare `model`.
- `providerHealth` is called with `this.key(model)`, which for `GeminiClient` produces exactly today's `gemini:<model>` rows.

- [ ] **Step 2: Rewrite `src/gemini.ts` as a subclass**

Replace the whole file with:

```ts
import { z } from 'zod';
import { UpstreamError } from './http.js';
import { ModelClient, type InlineImage } from './model-client.js';

export const ORIGIN = 'https://generativelanguage.googleapis.com';
export type { InlineImage };
const response = z.object({
 candidates: z.array(z.object({
   finishReason: z.string().optional(),
   content: z.object({parts: z.array(z.object({text: z.string().optional(), thought: z.boolean().optional()})).default([])}).optional(),
 })).default([]),
 promptFeedback: z.object({blockReason: z.string().optional()}).optional(),
});

export class GeminiClient extends ModelClient {
 protected get provider() { return 'gemini'; }
 get models() {
   return [...new Set([this.config.JUDGE_MODEL || this.config.GEMINI_MODEL,
     ...this.config.JUDGE_FALLBACK_MODELS.split(',').map(m => m.trim()).filter(Boolean)])];
 }
 protected async ask(model: string, system: string, text: string, schema: object, images: InlineImage[]) {
   const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, ORIGIN);
   const parts = [{text}, ...images.flatMap(image => [{text: image.label},
     {inlineData: {mimeType: image.mimeType, data: image.data.toString('base64')}}])];
   const raw = response.parse(await this.transport(url.href, {method: 'POST', trustedOrigin: ORIGIN,
     headers: {'x-goog-api-key': this.config.GEMINI_API_KEY}, timeoutMs: this.config.JUDGE_TIMEOUT_MS, redirects: 0,
     body: {systemInstruction: {parts: [{text: system}]}, contents: [{role: 'user', parts}],
       generationConfig: {responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 8192,
         ...(images.length ? {mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'} : {}),
         ...(this.config.JUDGE_THINKING_LEVEL === 'model_default' ? {} : {thinkingConfig: {thinkingLevel: this.config.JUDGE_THINKING_LEVEL}})}}}));
   if (raw.promptFeedback?.blockReason) throw new UpstreamError('model_blocked');
   const first = raw.candidates[0];
   if (!first || first.finishReason !== 'STOP') throw new UpstreamError('model_output_incomplete');
   try { return JSON.parse((first.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('')) as unknown; }
   catch { throw new UpstreamError('malformed_response'); }
 }
}
```

Note `ask` changes from `private` to `protected` (it now overrides an abstract member), and the `DB`/`Config`/`fetchJSON`/`takeBudget`/`providerHealth` imports are gone — they live in the base now.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: no output, exit 0.

- [ ] **Step 4: Run the suite that guards this refactor**

Run: `node --import tsx --test --test-concurrency=1 tests/watchdog.test.ts tests/planning.test.ts`
Expected: `pass 20`, `fail 0`. In particular `a retired primary model falls through to its fallback, and every model call is recorded` must still find `gemini:retired-model` and `gemini:current-model` rows in `provider_health`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/model-client.ts src/gemini.ts
git commit -m "$(cat <<'EOF'
Separate a model client's shared retry logic from Gemini's wire format

The fallback chain, per-model cooldowns, daily budget and health recording
are the same for any model provider. They move to an abstract ModelClient
so a second provider can reuse them; GeminiClient keeps only Gemini's
request and response shape.

Cooldowns and health rows are now keyed by provider and model, so two
providers offering the same model name cannot share state.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: OpenAI-compatible client

**Files:**
- Create: `src/openai-compatible.ts`
- Create: `tests/openai-compatible.test.ts`
- Modify: `src/config.ts` (add four vars after the `JUDGE_*` block, around line 55)
- Modify: `.env.example` (document the four vars after the `JUDGE_*` block)

**Interfaces:**
- Consumes: `ModelClient`, `InlineImage` from `./model-client.js` (Task 1).
- Produces: `export class OpenAICompatibleClient extends ModelClient` with `constructor(db: DB, config: Config, modelList: string[], transport = fetchJSON)`. Task 5 constructs it as `new OpenAICompatibleClient(db, config, [model])`.
- Produces config keys `OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME`.

- [ ] **Step 1: Add the config vars**

In `src/config.ts`, immediately after the line `JUDGE_DAILY_BUDGET: number(200, 0, 100000), JUDGE_TIMEOUT_MS: number(20000, 1000, 60000),`:

```ts
  // An OpenAI-compatible model endpoint (OpenRouter by default), used alongside Gemini. Nothing calls it until a
  // model names it, so an empty OPENROUTER_API_KEY leaves behaviour unchanged. An empty base URL means the default.
  OPENROUTER_BASE_URL: z.string().url().or(z.literal('')).default('https://openrouter.ai/api/v1')
    .transform(v => v || 'https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: optional,
  OPENROUTER_SITE_URL: z.string().url().or(z.literal('')).default(''),
  OPENROUTER_SITE_NAME: optional,
```

- [ ] **Step 2: Document them in `.env.example`**

After the `JUDGE_TIMEOUT_MS` line (match the surrounding comment style — a `#` line explaining why, then the var):

```
# An OpenAI-compatible model endpoint used alongside Gemini; OpenRouter by default. Leave the key empty to switch it off.
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=
# OpenRouter attributes requests to a site; both are optional and sent only when set.
OPENROUTER_SITE_URL=
OPENROUTER_SITE_NAME=
```

- [ ] **Step 3: Write the failing tests**

Create `tests/openai-compatible.test.ts`. Note the model names differ per test: `coolingUntil` is module state that lives for the whole test file.

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {OpenAICompatibleClient} from '../src/openai-compatible.js';
import {UpstreamError} from '../src/http.js';

const config={...testConfig,OPENROUTER_API_KEY:'or-key',OPENROUTER_SITE_URL:'http://127.0.0.1:3000',OPENROUTER_SITE_NAME:'ZenAtlas'};
const SCHEMA={type:'object',properties:{ok:{type:'boolean'},items:{type:'array',items:{type:'object',
 properties:{name:{type:'string'}},required:['name']}}},required:['ok','items']};
const answer=(value:unknown)=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]});

test('the OpenAI-compatible client sends a strict schema, images and the OpenRouter headers',async()=>{
 const db=await database();
 try{
   let sent:any,url='';
   const transport=async(u:string,options:any)=>{url=u;sent=options;return answer({ok:true,items:[]});};
   const reply=await new OpenAICompatibleClient(db,config,['vendor/model-a:free'],transport as any)
     .json('planner_calls','be helpful','the request',SCHEMA,
       [{label:'Screenshot for candidate k1:',mimeType:'image/jpeg',data:Buffer.from('jpegbytes')}]);
   assert.deepEqual([reply.model,reply.value],['vendor/model-a:free',{ok:true,items:[]}]);
   assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
   assert.equal(sent.trustedOrigin,'https://openrouter.ai');
   assert.equal(sent.token,'or-key','the transport turns the token into an Authorization header only on the trusted origin');
   assert.deepEqual([sent.headers['HTTP-Referer'],sent.headers['X-Title']],['http://127.0.0.1:3000','ZenAtlas']);
   assert.equal(sent.body.model,'vendor/model-a:free');
   assert.deepEqual(sent.body.messages[0],{role:'system',content:'be helpful'});
   assert.deepEqual(sent.body.messages[1].content[0],{type:'text',text:'the request'});
   assert.deepEqual(sent.body.messages[1].content[1],{type:'text',text:'Screenshot for candidate k1:'});
   assert.equal(sent.body.messages[1].content[2].image_url.url,`data:image/jpeg;base64,${Buffer.from('jpegbytes').toString('base64')}`);
   // Strict structured output rejects any object schema that does not forbid extra keys, at every depth.
   const json=sent.body.response_format.json_schema;
   assert.equal(json.strict,true);
   assert.equal(json.schema.additionalProperties,false);
   assert.equal(json.schema.properties.items.items.additionalProperties,false);
   assert.deepEqual(json.schema.required,['ok','items'],'the caller\'s own schema is otherwise untouched');
   // Without images the user message stays a plain string, which every backend accepts.
   const plain=async(_u:string,options:any)=>{sent=options;return answer({ok:false,items:[]});};
   await new OpenAICompatibleClient(db,config,['vendor/model-a:free'],plain as any).json('planner_calls','s','t',SCHEMA);
   assert.equal(sent.body.messages[1].content,'t');
 }finally{await db.close();}
});

test('a reply that is not usable JSON is a malformed response',async()=>{
 const db=await database();
 try{
   const notJSON=async()=>({choices:[{finish_reason:'stop',message:{content:'I cannot help with that.'}}]});
   await assert.rejects(new OpenAICompatibleClient(db,config,['vendor/model-b:free'],notJSON as any).json('planner_calls','s','t',SCHEMA),
     /malformed_response/,'prose instead of JSON');
   const wrongShape=async()=>({id:'gen-1',error:{message:'no endpoints found'}});
   await assert.rejects(new OpenAICompatibleClient(db,config,['vendor/model-c:free'],wrongShape as any).json('planner_calls','s','t',SCHEMA),
     /malformed_response/,'valid JSON that is not a completion');
   const truncated=async()=>({choices:[{finish_reason:'length',message:{content:'{"ok":'}}]});
   await assert.rejects(new OpenAICompatibleClient(db,config,['vendor/model-d:free'],truncated as any).json('planner_calls','s','t',SCHEMA),
     /model_output_incomplete/,'a reply cut off by the token cap is reported as such, not as bad JSON');
 }finally{await db.close();}
});

test('a rate-limited model is set aside and the next one is tried first afterwards',async()=>{
 const db=await database();
 try{
   const tried:string[]=[];
   const transport=async(_u:string,options:any)=>{
     tried.push(options.body.model);
     if(options.body.model==='vendor/limited:free')throw new UpstreamError('rate_limited',429);
     return answer({ok:true,items:[]});
   };
   const client=new OpenAICompatibleClient(db,config,['vendor/limited:free','vendor/spare:free'],transport as any);
   const first=await client.json('planner_calls','s','t',SCHEMA);
   assert.deepEqual([first.model,tried],['vendor/spare:free',['vendor/limited:free','vendor/spare:free']]);
   const rows=Object.fromEntries((await db.query("SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider LIKE 'openrouter:%'")).rows.map(r=>[r.provider,r]));
   assert.deepEqual([rows['openrouter:vendor/limited:free'].failure_count,rows['openrouter:vendor/limited:free'].last_error_code],[1,'rate_limited']);
   assert.equal(rows['openrouter:vendor/spare:free'].failure_count,0);
   tried.length=0;
   const second=await client.json('planner_calls','s','t',SCHEMA);
   assert.deepEqual([second.model,tried],['vendor/spare:free',['vendor/spare:free']],'the cooling model is not tried again while it is set aside');
 }finally{await db.close();}
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `node --import tsx --test --test-concurrency=1 tests/openai-compatible.test.ts`
Expected: FAIL — `Cannot find module '../src/openai-compatible.js'`.

- [ ] **Step 5: Write `src/openai-compatible.ts`**

```ts
import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { ModelClient, type InlineImage } from './model-client.js';

const response = z.object({choices: z.array(z.object({
 finish_reason: z.string().nullish(),
 message: z.object({content: z.string().nullish()}),
})).min(1)});
// Strict structured output rejects an object schema that does not forbid extra keys, at any depth. The judge's and
// planner's schemas predate it, so the requirement is added on the way out rather than in every caller.
const strict = (node: any): any => !node || typeof node !== 'object' ? node
 : {...node, ...(node.type === 'object' ? {additionalProperties: false} : {}),
   ...(node.properties ? {properties: Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, strict(v)]))} : {}),
   ...(node.items ? {items: strict(node.items)} : {})};

// Any endpoint speaking OpenAI's chat-completions API, such as OpenRouter. Models are given by whoever builds it:
// their ids carry slashes and colons, which the Gemini model settings do not allow.
export class OpenAICompatibleClient extends ModelClient {
 constructor(db: DB, config: Config, private modelList: string[], transport = fetchJSON) { super(db, config, transport); }
 protected get provider() { return 'openrouter'; }
 get models() { return this.modelList; }
 protected async ask(model: string, system: string, text: string, schema: object, images: InlineImage[]) {
   const url = new URL(`${this.config.OPENROUTER_BASE_URL.replace(/\/$/, '')}/chat/completions`);
   const parts = [{type: 'text', text}, ...images.flatMap(image => [{type: 'text', text: image.label},
     {type: 'image_url', image_url: {url: `data:${image.mimeType};base64,${image.data.toString('base64')}`}}])];
   const raw = response.safeParse(await this.transport(url.href, {method: 'POST', trustedOrigin: url.origin,
     token: this.config.OPENROUTER_API_KEY, timeoutMs: this.config.JUDGE_TIMEOUT_MS, redirects: 0,
     headers: {...(this.config.OPENROUTER_SITE_URL ? {'HTTP-Referer': this.config.OPENROUTER_SITE_URL} : {}),
       ...(this.config.OPENROUTER_SITE_NAME ? {'X-Title': this.config.OPENROUTER_SITE_NAME} : {})},
     body: {model, messages: [{role: 'system', content: system}, {role: 'user', content: images.length ? parts : text}],
       response_format: {type: 'json_schema', json_schema: {name: 'reply', schema: strict(schema), strict: true}},
       max_tokens: 8192}}));
   // A 200 carrying an error object, or anything else that is not a completion, is not an answer this app can use.
   if (!raw.success) throw new UpstreamError('malformed_response');
   const first = raw.data.choices[0];
   // Reasoning models can spend the whole token cap before writing any answer; that is a truncated reply, not bad JSON.
   if (first.finish_reason && first.finish_reason !== 'stop') throw new UpstreamError('model_output_incomplete');
   // Not every backend enforces the schema it was sent, so the reply is parsed and the caller validates its shape.
   try { return JSON.parse(first.message.content ?? '') as unknown; } catch { throw new UpstreamError('malformed_response'); }
 }
}
```

- [ ] **Step 6: Run the tests until they pass**

Run: `node --import tsx --test --test-concurrency=1 tests/openai-compatible.test.ts`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 7: Typecheck and run everything**

Run: `npm run build && npm test`
Expected: both clean, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/openai-compatible.ts src/config.ts .env.example tests/openai-compatible.test.ts
git commit -m "$(cat <<'EOF'
Add a client for OpenAI-compatible model endpoints

Speaks the chat-completions API, so any OpenRouter model can answer the
same structured requests Gemini does, screenshots included. Models are
passed in rather than read from config: their ids carry slashes and
colons that the Gemini model settings reject.

Strict structured output requires every object in a schema to forbid
extra keys. The judge's and planner's schemas predate that rule, so the
client adds it on the way out instead of changing every caller.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Give the planner a client seam

Pure refactor of `src/planner.ts`. No behaviour change, no new tests — `tests/planning.test.ts` is the gate.

**Files:**
- Modify: `src/planner.ts:84-109` (the `GeminiPlanner` class)

**Interfaces:**
- Consumes: `ModelClient` from `./model-client.js` (Task 1).
- Produces: `export class ModelPlanner implements Planner` with `constructor(protected client: ModelClient, protected config: Config, protected bucket = 'planner_calls')`. Task 4 composes these; Task 5 builds them with a per-model bucket.
- `GeminiPlanner(db, config, transport)` keeps its exact three-argument signature — `tests/planning.test.ts:34` and `:40` and `:45` and `:51` all construct it that way.

- [ ] **Step 1: Add the `ModelClient` import**

In `src/planner.ts`, line 5 currently reads `import { GeminiClient } from './gemini.js';`. Make it:

```ts
import { GeminiClient } from './gemini.js';
import type { ModelClient } from './model-client.js';
```

- [ ] **Step 2: Replace the `GeminiPlanner` class (lines 84-109)**

The body of `plan` and `followUps` is unchanged except that `'planner_calls'` becomes `this.bucket`.

```ts
// Plans searches with any model client. The bucket is the daily budget it spends, so several models can plan
// alongside each other without one exhausting the others' allowance.
export class ModelPlanner implements Planner {
 constructor(protected client: ModelClient, protected config: Config, protected bucket = 'planner_calls') {}
 async plan(query: string, options: PlanOptions = {}): Promise<SearchPlan> {
   const avoid = options.avoid ?? [];
   const limit = options.deep ? this.config.DEEP_PLAN_SEARCHES : this.config.PLAN_SEARCHES;
   const system = (options.deep ? DEEP_INSTRUCTION : SYSTEM_INSTRUCTION).replace('{{N}}', String(limit))
     .replace('{{AVOID}}', avoid.length ? JSON.stringify(avoid) : 'none');
   const text = [`Request: ${JSON.stringify(query)}`,
     ...(options.anime ? [`Known anime match: ${JSON.stringify(animeSummary(options.anime, query))}`] : [])].join('\n');
   const answer = await this.client.json(this.bucket, system, text, RESPONSE_SCHEMA);
   const parsed = reply.safeParse(answer.value);
   if (!parsed.success) throw new UpstreamError('malformed_response');
   return normalisePlan(query, parsed.data, limit, answer.model, options.deep ? avoid : []);
 }
 async followUps(query: string, material: string[], avoid: string[]): Promise<PlannedSearch[]> {
   const limit = this.config.DEEP_FOLLOW_UPS;
   const text = [`Request: ${JSON.stringify(query)}`, `Searches already run: ${JSON.stringify(avoid)}`,
     'Material follows, one item per line.', '<material>', ...material.map(line => JSON.stringify(line)), '</material>'].join('\n');
   const answer = await this.client.json(this.bucket, FOLLOW_UP_INSTRUCTION.replace('{{N}}', String(limit)), text,
     {type: 'object', properties: {searches: SEARCHES_SCHEMA}, required: ['searches']});
   const parsed = z.object({searches}).safeParse(answer.value);
   if (!parsed.success) throw new UpstreamError('malformed_response');
   return uniqueSearches(parsed.data.searches, limit, avoid);
 }
}

export class GeminiPlanner extends ModelPlanner {
 constructor(db: DB, config: Config, transport = fetchJSON) { super(new GeminiClient(db, config, transport), config); }
}
```

- [ ] **Step 3: Typecheck and run the guard suite**

Run: `npm run build && node --import tsx --test --test-concurrency=1 tests/planning.test.ts`
Expected: no typecheck output; planning tests all pass, unchanged.

- [ ] **Step 4: Run everything**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/planner.ts
git commit -m "$(cat <<'EOF'
Let a planner work with any model client, not just Gemini

The planning prompts and reply handling have nothing Gemini-specific in
them, so they move to ModelPlanner, which takes the client and the daily
budget bucket it spends. GeminiPlanner stays as it was for its callers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: EnsemblePlanner

**Files:**
- Modify: `src/planner.ts` (append after `GeminiPlanner`)
- Modify: `src/config.ts` (add `PLANNER_ASSIST_MODELS` and `PLANNER_ASSIST_TIMEOUT_MS` after the `OPENROUTER_*` block)
- Modify: `.env.example`
- Modify: `tests/planning.test.ts` (append new tests; change nothing existing)

**Interfaces:**
- Consumes: `Planner`, `PlanOptions`, `SearchPlan`, `PlannedSearch`, `uniqueSearches` — all already in `src/planner.ts`.
- Produces: `export class EnsemblePlanner implements Planner` with `constructor(primary: Planner, assists: Planner[], config: Config)`. Task 5 builds it.
- Produces config keys `PLANNER_ASSIST_MODELS` (comma-separated, default `''`) and `PLANNER_ASSIST_TIMEOUT_MS` (default 6000).

- [ ] **Step 1: Add the config vars**

In `src/config.ts`, straight after the `OPENROUTER_SITE_NAME: optional,` line from Task 2:

```ts
  // Models that plan searches alongside the primary planner, on the OpenAI-compatible endpoint. Comma-separated
  // OpenRouter ids, so slashes and colons are allowed. Empty means one planner, as before.
  PLANNER_ASSIST_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default(''),
  // An assist must not hold up a search, so it is dropped when it does not answer within this; well under
  // JUDGE_TIMEOUT_MS, because a free model can hang for a minute.
  PLANNER_ASSIST_TIMEOUT_MS: number(6000, 500, 30000),
```

- [ ] **Step 2: Document them in `.env.example`**

After the `OPENROUTER_SITE_NAME` line:

```
# Models that plan searches alongside Gemini and have their queries merged with its own, e.g.
# deepseek/deepseek-v4-flash-0731:free,qwen/qwen3.8-27b:free. Needs OPENROUTER_API_KEY. Empty uses Gemini alone.
PLANNER_ASSIST_MODELS=
# An assist that does not answer within this is left out, so a slow model cannot hold up a search.
PLANNER_ASSIST_TIMEOUT_MS=6000
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/planning.test.ts`. Add `EnsemblePlanner` to the existing import on line 4:

```ts
import {fallbackPlan,normalisePlan,GeminiPlanner,EnsemblePlanner,type Planner,type PlannedSearch,type SearchPlan} from '../src/planner.js';
```

Then append these tests:

```ts
const stubPlanner=(plan:Partial<SearchPlan>,follow:PlannedSearch[]=[]):Planner=>({
 async plan(){return {kind:'videos',searches:[],criteria:[],model:'stub',...plan};},
 async followUps(){return follow;},
});
const failing=(error:unknown,after=0):Planner=>({
 async plan(){await new Promise(r=>setTimeout(r,after));throw error;},
 async followUps(){await new Promise(r=>setTimeout(r,after));throw error;},
});

test('an ensemble merges its planners round-robin, keeps the user query first and honours the search limit',async()=>{
 const config={...testConfig,PLAN_SEARCHES:4,PLANNER_ASSIST_TIMEOUT_MS:500};
 // Each planner has already normalised its own plan, so each list starts with the user's own query.
 const primary=stubPlanner({kind:'websites',criteria:['uses 3D'],model:'gemini-3.6-flash',
   searches:[{query:'3d sites',target:'web'},{query:'site:awwwards.com three.js',target:'web'},{query:'webgl showcase',target:'web'}]});
 const assist=stubPlanner({kind:'videos',criteria:['is a video'],model:'vendor/assist:free',
   searches:[{query:'3d sites',target:'web'},{query:'site:codrops.com webgl',target:'web'},{query:'3D SITES',target:'web'}]});
 const plan=await new EnsemblePlanner(primary,[assist],config).plan('3d sites');
 assert.deepEqual(plan.searches,[{query:'3d sites',target:'web'},{query:'site:awwwards.com three.js',target:'web'},
   {query:'site:codrops.com webgl',target:'web'},{query:'webgl showcase',target:'web'}],
   'the user query leads, the planners alternate, duplicates go, and the union stops at PLAN_SEARCHES');
 assert.deepEqual([plan.kind,plan.criteria,plan.model],['websites',['uses 3D'],'gemini-3.6-flash'],'kind and criteria come from the primary');
});

test('an ensemble survives a failing or slow planner and only gives up when they all fail',async()=>{
 const config={...testConfig,PLAN_SEARCHES:4,PLANNER_ASSIST_TIMEOUT_MS:100};
 const good=stubPlanner({kind:'videos',criteria:['is a clip'],model:'vendor/assist:free',
   searches:[{query:'q',target:'videos'},{query:'assist idea',target:'videos'}]});
 const promoted=await new EnsemblePlanner(failing(new UpstreamError('upstream_failure',500)),[good],config).plan('q');
 assert.deepEqual([promoted.kind,promoted.model,promoted.searches],['videos','vendor/assist:free',
   [{query:'q',target:'videos'},{query:'assist idea',target:'videos'}]],'a working assist is promoted when the primary fails');

 const primary=stubPlanner({kind:'websites',criteria:[],model:'gemini-3.6-flash',searches:[{query:'q',target:'web'}]});
 const slow=await new EnsemblePlanner(primary,[failing(new UpstreamError('timeout'),500)],config).plan('q');
 assert.deepEqual([slow.model,slow.searches],['gemini-3.6-flash',[{query:'q',target:'web'}]],'an assist past its deadline is left out');

 await assert.rejects(new EnsemblePlanner(failing(new UpstreamError('budget_exhausted')),[failing(new UpstreamError('timeout'))],config).plan('q'),
   /budget_exhausted/,'when every planner fails the primary error is raised, so discovery can fall back and say why');
});

test('ensemble follow-ups merge and stay within DEEP_FOLLOW_UPS',async()=>{
 const config={...testConfig,DEEP_FOLLOW_UPS:3,PLANNER_ASSIST_TIMEOUT_MS:500};
 const primary=stubPlanner({},[{query:'Orbit Studio showreel',target:'videos'},{query:'orbit studio webgl',target:'web'}]);
 const assist=stubPlanner({},[{query:'orbit studio interview',target:'videos'},{query:'ORBIT STUDIO WEBGL',target:'web'},{query:'one too many',target:'web'}]);
 const follow=await new EnsemblePlanner(primary,[assist],config).followUps('orbit studio',['orbit.example: Orbit Studio'],['already run']);
 assert.deepEqual(follow,[{query:'Orbit Studio showreel',target:'videos'},{query:'orbit studio interview',target:'videos'},
   {query:'orbit studio webgl',target:'web'}]);
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `node --import tsx --test --test-concurrency=1 tests/planning.test.ts`
Expected: FAIL — `EnsemblePlanner` is not exported from `../src/planner.js`.

- [ ] **Step 5: Implement `EnsemblePlanner`**

Append to `src/planner.ts`, after `GeminiPlanner`:

```ts
// Round-robin, so every planner contributes a query before any planner contributes a second one.
const interleave = (lists: PlannedSearch[][]): PlannedSearch[] => {
 const out: PlannedSearch[] = [];
 for (let i = 0; i < Math.max(0, ...lists.map(l => l.length)); i++) for (const list of lists) if (i < list.length) out.push(list[i]);
 return out;
};

// Several models plan the same search and their queries are merged. The union is capped at the limit one planner
// gets: every extra query is fanned across every configured engine, so it costs discovery wall-time and engine budget.
export class EnsemblePlanner implements Planner {
 constructor(private primary: Planner, private assists: Planner[], private config: Config) {}
 async plan(query: string, options: PlanOptions = {}): Promise<SearchPlan> {
   const plans = await this.gather(() => this.primary.plan(query, options), this.assists.map(a => () => a.plan(query, options)));
   const limit = options.deep ? this.config.DEEP_PLAN_SEARCHES : this.config.PLAN_SEARCHES;
   // The leading plan is the primary's, or the first assist's when the primary failed; its kind and criteria stand.
   return {...plans[0], searches: uniqueSearches(interleave(plans.map(p => p.searches)), limit, options.deep ? options.avoid ?? [] : [])};
 }
 async followUps(query: string, material: string[], avoid: string[]): Promise<PlannedSearch[]> {
   const ask = (p: Planner) => () => p.followUps ? p.followUps(query, material, avoid) : Promise.reject(new UpstreamError('model_unavailable'));
   const lists = await this.gather(ask(this.primary), this.assists.map(ask));
   return uniqueSearches(interleave(lists), this.config.DEEP_FOLLOW_UPS, avoid);
 }
 // The primary is awaited in full; an assist races a much shorter deadline, because one slow model must not hold up
 // every search. Whatever answered in time is used, and only when nothing did does this throw — so planWith() in
 // discovery.ts still falls back to fallbackPlan and reports why.
 private async gather<T>(primary: () => Promise<T>, assists: (() => Promise<T>)[]): Promise<T[]> {
   const inTime = (work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) =>
     setTimeout(() => reject(new UpstreamError('timeout')), this.config.PLANNER_ASSIST_TIMEOUT_MS).unref())]);
   const settled = await Promise.allSettled([primary(), ...assists.map(a => inTime(a()))]);
   const done = settled.flatMap(s => s.status === 'fulfilled' ? [s.value] : []);
   if (!done.length) throw (settled[0] as PromiseRejectedResult).reason;
   return done;
 }
}
```

`.unref()` matters: without it a pending assist timer keeps the node:test process alive after the assertions finish.

- [ ] **Step 6: Run the tests until they pass**

Run: `node --import tsx --test --test-concurrency=1 tests/planning.test.ts`
Expected: all pass, including the three new ones and every pre-existing case.

- [ ] **Step 7: Typecheck and run everything**

Run: `npm run build && npm test`
Expected: both clean, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/planner.ts src/config.ts .env.example tests/planning.test.ts
git commit -m "$(cat <<'EOF'
Let several models plan one search and merge what they suggest

Different models reach for different queries, so an ensemble interleaves
their lists round-robin and keeps the user's own query in front. The
union is capped at the limit a single planner gets: every extra query is
fanned across every engine, so it would cost search time and budget.

An assist races a short deadline and is dropped when it misses it. A
free model can hang for a minute, and no search should wait for one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Build the planner from config and wire it into discovery

**Files:**
- Modify: `src/planner.ts` (append `assistModels` and `makePlanner`)
- Modify: `src/discovery.ts:11` (import) and `src/discovery.ts:95` (the ternary)
- Modify: `tests/planning.test.ts` (append one test)

**Interfaces:**
- Consumes: `EnsemblePlanner`, `ModelPlanner`, `GeminiPlanner` (Tasks 3, 4); `OpenAICompatibleClient` (Task 2).
- Produces: `export const assistModels = (config: Config): string[]` — Task 6 uses it; and `export function makePlanner(db: DB, config: Config): Planner|undefined`.

- [ ] **Step 1: Write the failing test**

Append to `tests/planning.test.ts`. Add `runDiscovery` and `makePlanner` imports:

```ts
import {runDiscovery} from '../src/discovery.js';
```
and extend the `../src/planner.js` import with `makePlanner`.

```ts
test('the planner is built from config, and a search still runs when every planner fails',async()=>{
 const db=await database();
 try{
   assert.equal(makePlanner(db,testConfig),undefined,'no Gemini key and no assists means no planner');
   assert.ok(makePlanner(db,{...testConfig,GEMINI_API_KEY:'k'}) instanceof GeminiPlanner,'Gemini alone stays a plain GeminiPlanner');
   const both={...testConfig,GEMINI_API_KEY:'k',OPENROUTER_API_KEY:'or',PLANNER_ASSIST_MODELS:'vendor/one:free, vendor/two:free'};
   assert.ok(makePlanner(db,both) instanceof EnsemblePlanner,'assists turn it into an ensemble');
   assert.ok(makePlanner(db,{...testConfig,GEMINI_API_KEY:'k',PLANNER_ASSIST_MODELS:'vendor/one:free'}) instanceof GeminiPlanner,
     'assists need an OpenRouter key to be used');

   // When no planner can answer, discovery must still search the query as typed and say planning was unavailable.
   const dead=new EnsemblePlanner(failing(new UpstreamError('timeout')),[failing(new UpstreamError('timeout'))],
     {...testConfig,PLANNER_ASSIST_TIMEOUT_MS:100});
   const run=await runDiscovery(db,testConfig,searchInput.parse({q:'3d sites'}),[],{planner:dead},async()=>{});
   const status=run.providers.find(p=>p.provider==='planner');
   assert.equal(status?.status,'unavailable');
   assert.deepEqual(run.searches,fallbackPlan('3d sites').searches,'the query is searched as typed');
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test --test-concurrency=1 tests/planning.test.ts`
Expected: FAIL — `makePlanner` is not exported.

- [ ] **Step 3: Add `assistModels` and `makePlanner` to `src/planner.ts`**

Add the imports at the top of the file:

```ts
import { OpenAICompatibleClient } from './openai-compatible.js';
```

Append after `EnsemblePlanner`:

```ts
export const assistModels = (config: Config): string[] => config.PLANNER_ASSIST_MODELS.split(',').map(m => m.trim()).filter(Boolean);

// Gemini leads when it is configured; each assist model plans alongside it on the OpenAI-compatible endpoint, spending
// its own daily budget so one model running out does not stop the others. With no assists this is the planner as before.
export function makePlanner(db: DB, config: Config): Planner|undefined {
 const assists = config.OPENROUTER_API_KEY
   ? assistModels(config).map(model => new ModelPlanner(new OpenAICompatibleClient(db, config, [model]), config, `planner_calls:${model}`))
   : [];
 const primary = config.GEMINI_API_KEY ? new GeminiPlanner(db, config) : assists.shift();
 if (!primary) return undefined;
 return assists.length ? new EnsemblePlanner(primary, assists, config) : primary;
}
```

- [ ] **Step 4: Wire it into `src/discovery.ts`**

Change the import on line 11 from `GeminiPlanner` to `makePlanner`:

```ts
import { makePlanner, fallbackPlan, uniqueSearches, type PlannedSearch, type Planner, type SearchPlan, type SearchTarget } from './planner.js';
```

Change line 95 from the inline ternary to:

```ts
 const planner = input.source ? undefined : deps.planner ?? makePlanner(db, config);
```

The `deps.planner ??` part is untouched.

- [ ] **Step 5: Run the tests until they pass**

Run: `node --import tsx --test --test-concurrency=1 tests/planning.test.ts`
Expected: all pass.

If `runDiscovery` rejects on the empty `deps` object, pass the no-op progress callback it wants and keep `adapters` as `[]`; do not add real providers — the point of the test is the planner status, not the search results.

- [ ] **Step 6: Typecheck and run everything**

Run: `npm run build && npm test`
Expected: both clean, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/planner.ts src/discovery.ts tests/planning.test.ts
git commit -m "$(cat <<'EOF'
Build the search planner from config instead of inline in discovery

makePlanner decides what plans a search: Gemini alone, as before, or
Gemini with assist models merged in when PLANNER_ASSIST_MODELS names
any. Each assist spends its own daily budget bucket, so one model
hitting its limit leaves the rest planning.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Watch each assist's budget

**Files:**
- Modify: `src/dependencies.ts:185-198` (the `DAILY_BUDGETS` const) and `:199-213` (the `budgets` check body)
- Modify: `tests/watchdog.test.ts` (append one assertion to the existing budgets coverage, or add a small test)

**Interfaces:**
- Consumes: `assistModels` from `./planner.js` (Task 5).
- Produces: nothing new for later tasks; this is the last one.

- [ ] **Step 1: Write the failing test**

Append to `tests/watchdog.test.ts`:

```ts
test('each planning assist has its own watched budget',async()=>{
 const db=await database();
 try{
   const config={...testConfig,GEMINI_API_KEY:'k',OPENROUTER_API_KEY:'or',PLANNER_ASSIST_MODELS:'vendor/one:free',JUDGE_DAILY_BUDGET:10};
   await db.query(`INSERT INTO budgets(bucket,window_start,used) VALUES('planner_calls:vendor/one:free',date_trunc('day',now()),10)`);
   const result=await check('budgets').run(env(db,{config}));
   assert.equal(result.code,'budget_spent');
   assert.match(result.summary,/AI planning calls \(vendor\/one:free\)/,'the assist is named, so it is clear which model stopped');
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test --test-concurrency=1 tests/watchdog.test.ts`
Expected: FAIL — the bucket is not in the fixed list, so the check reports `within_budget`.

- [ ] **Step 3: Make `DAILY_BUDGETS` config-derived**

In `src/dependencies.ts`, add to the imports:

```ts
import { assistModels } from './planner.js';
```

Rename the const at line 185 to `FIXED_BUDGETS` (its contents unchanged) and add below it:

```ts
// Each planning assist spends its own bucket (see makePlanner), so each is watched separately; otherwise a model
// quietly reaching its limit would look like it was simply not contributing.
const dailyBudgets = (config: Config) => [...FIXED_BUDGETS,
 ...assistModels(config).map(model => ({bucket: `planner_calls:${model}`, label: `AI planning calls (${model})`, setting: 'JUDGE_DAILY_BUDGET' as keyof Config}))];
```

Then in the `budgets` check body, replace the two `DAILY_BUDGETS` references:

```ts
 async run({db, config}) {
   const watched = dailyBudgets(config);
   const used = new Map((await db.query<{bucket: string; used: number}>(`SELECT bucket,used FROM budgets
     WHERE window_start=date_trunc('day',now()) AND bucket=ANY($1::text[])`, [watched.map(b => b.bucket)])).rows.map(r => [r.bucket, r.used]));
   const rows = watched.flatMap(b => {
```

The rest of the body is unchanged.

- [ ] **Step 4: Run the tests until they pass**

Run: `node --import tsx --test --test-concurrency=1 tests/watchdog.test.ts`
Expected: all pass, including the pre-existing budgets test (with `PLANNER_ASSIST_MODELS` empty, `dailyBudgets` returns exactly `FIXED_BUDGETS`).

Check for an import cycle while you are here: `dependencies.ts` → `planner.ts` → `gemini.ts`/`openai-compatible.ts` → `model-client.ts`. None of those import `dependencies.ts`, so there is no cycle. If tsc or the runtime disagrees, move `assistModels` into `src/config.ts` instead and import it from there in both places.

- [ ] **Step 5: Typecheck and run everything**

Run: `npm run build && npm test`
Expected: both clean, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/dependencies.ts tests/watchdog.test.ts
git commit -m "$(cat <<'EOF'
Watch each planning assist's daily budget

Assists spend a bucket per model, which the fixed budget list could not
see. A model reaching its limit now raises a warning naming it, instead
of looking like a model that had stopped suggesting anything.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] `npm run build` — clean
- [ ] `npm test` — `fail 0`, and the count is 20 pre-existing plus the 7 added here
- [ ] `git log --oneline` shows six commits, one per task
- [ ] `git diff main --stat` touches only: `src/model-client.ts`, `src/gemini.ts`, `src/openai-compatible.ts`, `src/planner.ts`, `src/discovery.ts`, `src/config.ts`, `src/dependencies.ts`, `.env.example`, `tests/openai-compatible.test.ts`, `tests/planning.test.ts`, `tests/watchdog.test.ts`, and the two docs files
- [ ] `git diff main -- src/signals.ts src/judge.ts scene-worker/` is empty
- [ ] With `PLANNER_ASSIST_MODELS` unset, a search behaves exactly as before: `makePlanner` returns a plain `GeminiPlanner`
