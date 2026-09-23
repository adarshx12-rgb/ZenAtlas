import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DB } from '../src/db.js';
import { contentInput } from '../src/types.js';
import { JevScreener, makeScreener, screeningOrder } from '../src/screener.js';
import { UpstreamError } from '../src/http.js';
import type { fetchJSON } from '../src/http.js';
import { testConfig } from './helpers.js';

const config = {...testConfig, OPENROUTER_API_KEY: 'test-key'};
const candidates = (count: number) => Array.from({length: count}, (_, i) => ({
 item: contentInput.parse({url: `https://example.org/${i}`, title: `Candidate ${i}`}), provider: 'test', position: i,
}));
function budgetDB(limit = Infinity): DB {
 let calls = 0;
 const db: DB = {async query<T>() {return {rows: (++calls <= limit ? [{used: calls}] : []) as T[]};},
   async transaction(fn) {return fn(db);}, async close() {}};
 return db;
}
const choice = (label = 'promising', confidence = 0.95) => ({type: 'choice', choice: label, confidence,
 probabilities: {promising: label === 'promising' ? 0.95 : 0.025,
   uncertain: label === 'uncertain' ? 0.95 : 0.025, mismatch: label === 'mismatch' ? 0.95 : 0.025}});
const reply = (body: any) => ({model: 'typesafe/jev-1.13-20260917', answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, choice()]))});

test('Jev is optional and can be explicitly disabled', () => {
 assert.equal(makeScreener(budgetDB(), testConfig), undefined);
 assert.equal(makeScreener(budgetDB(), {...config, JEV_SCREENING_ENABLED: false}), undefined);
 assert.ok(makeScreener(budgetDB(), config) instanceof JevScreener);
});

test('screening promotes confident leads, preserves every candidate and reserves the original-order lane', () => {
 const input = candidates(12), promoted = new Set(input.slice(5).map(c => c.item.url));
 const ordered = screeningOrder(input, promoted);
 assert.deepEqual(ordered.slice(0, 4).map(c => c.position), [5, 6, 7, 0]);
 assert.deepEqual(ordered.filter(c => !promoted.has(c.item.url)).map(c => c.position), [0, 1, 2, 3, 4]);
 assert.equal(new Set(ordered).size, input.length);
 assert.equal(screeningOrder(input, new Set()), input);
});

test('OpenRouter decision request references each candidate and ignores uncertain/low-confidence decisions', async () => {
 const transport: typeof fetchJSON = async (url, options) => {
   assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
   assert.equal(options?.token, 'test-key');
   assert.equal(options?.trustedOrigin, 'https://openrouter.ai');
   assert.equal(options?.timeoutMs, 4000);
   assert.equal(options?.redirects, 0);
   const body = options!.body as any;
   assert.equal(body.state.request, 'WWE commentator reactions');
   assert.match(body.questions.c1.instructions, /state\.candidates\.c1/);
   assert.equal(body.state.candidates.c1.title, 'Candidate 1');
   assert.equal(body.model, 'typesafe/jev-1.13');
   assert.equal(body.messages, undefined);
   return {model: 'typesafe/jev-1.13-20260917', answers: {c0: choice(), c1: choice('uncertain'), c2: choice('promising', 0.4), c3: choice('mismatch')}};
 };
 const input = candidates(4);
 const out = await new JevScreener(budgetDB(), config, transport).screen('WWE commentator reactions', input);
 assert.deepEqual([...out.promising], [input[0].item.url]);
 assert.equal(out.screened, 4);
 assert.equal(out.decisions?.length, 4);
 assert.equal(out.decisions?.[2].confidence, 0.4);
 assert.equal(out.decisions?.[2].promoted, false);
 assert.equal(out.decisions?.[1].choice, 'uncertain');
});

test('OpenRouter decisions respect the configured base and attribution headers', async () => {
 for (const base of ['https://gateway.example/api/v1/', 'https://gateway.example/api/']) {
   const custom = {...config, OPENROUTER_BASE_URL: base, OPENROUTER_SITE_URL: 'https://search.example', OPENROUTER_SITE_NAME: 'ZenAtlas'};
   const transport: typeof fetchJSON = async (url, options) => {
     assert.equal(url, 'https://gateway.example/api/alpha/decisions');
     assert.equal(options?.trustedOrigin, 'https://gateway.example');
     assert.deepEqual(options?.headers, {'HTTP-Referer': 'https://search.example', 'X-Title': 'ZenAtlas'});
     return reply(options!.body);
   };
   await new JevScreener(budgetDB(), custom, transport).screen('query', candidates(1));
 }
});

test('screening samples beyond the head and bounds batches and Unicode payloads', async () => {
 const input = candidates(300).map(c => ({...c, item: {...c.item, title: '漢'.repeat(500), description: '漢'.repeat(10000)}}));
 const bodies: any[] = [];
 const transport: typeof fetchJSON = async (_url, options) => {bodies.push(options!.body); return reply(options!.body);};
 const out = await new JevScreener(budgetDB(), config, transport).screen('漢'.repeat(500), input);
 assert.equal(bodies.length, 6);
 assert.equal(out.screened, 120);
 assert.equal(out.promising.size, 120);
 assert.ok([...out.promising].some(url => Number(url.split('/').at(-1)) > 290));
 for (const body of bodies) {
   assert.ok(Object.keys(body.questions).length <= 20);
   assert.ok(Buffer.byteLength(JSON.stringify(body.state)) <= 24000);
   assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 56000);
 }
});

test('invalid, missing, extra and inconsistent answers fail the entire screening request', async () => {
 const invalid = [
   {}, {c0: choice()}, {c0: choice(), c1: choice(), c2: choice()},
   {c0: {...choice(), confidence: 2}, c1: choice()},
   {c0: {...choice(), probabilities: {promising: 0.9, uncertain: 0.9, mismatch: 0}}, c1: choice()},
   {c0: {...choice('uncertain'), choice: 'promising'}, c1: choice()},
 ];
 for (const answers of invalid) {
   const screener = new JevScreener(budgetDB(), config, async () => ({model: 'typesafe/jev-1.13-20260917', answers}));
   await assert.rejects(screener.screen('query', candidates(2)), (e: unknown) => e instanceof UpstreamError && e.code === 'malformed_response');
 }
});

test('budget exhaustion and a failed batch do not yield partial promotions or retry', async () => {
 let calls = 0;
 const transport: typeof fetchJSON = async (_url, options) => {calls++; return reply(options!.body);};
 await assert.rejects(new JevScreener(budgetDB(0), config, transport).screen('query', candidates(1)), /budget_exhausted/);
 assert.equal(calls, 0);
 await assert.rejects(new JevScreener(budgetDB(), {...config, JEV_SCREEN_DAILY_BUDGET: 0}, transport).screen('query', candidates(1)), /budget_exhausted/);
 assert.equal(calls, 0);
 const failing: typeof fetchJSON = async (_url, options) => {
   calls++; if (calls === 2) throw new UpstreamError('timeout'); return reply(options!.body);
 };
 await assert.rejects(new JevScreener(budgetDB(), config, failing).screen('query', candidates(25)), /timeout/);
 assert.equal(calls, 2);
});
