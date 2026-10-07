// OPT-IN LIVE EVALUATION. Never imported by tests and never starts or restarts PM2.
// node --env-file-if-exists=.env --import tsx scripts/deep-sources-eval.ts --run
// Optional DEEP_EVAL_IDS=id,id; DEEP_EVAL_TIER=ssj3; DEEP_EVAL_SEED=path/to/seed.json.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {embedded} from './embedded.js';
import {migrate} from '../src/migrate.js';
import {readConfig} from '../src/config.js';
import {tierConfig, tierSchema} from '../src/tiers.js';
import {searchWeb, webSearchInput, type WebResult} from '../src/web.js';
import {huntState} from '../src/doc-hunt.js';
import {webReviewState} from '../src/web-review.js';

type Query = {id: string; field: string; tab: 'web'|'docs'; q: string};
type Labels = Record<string, Record<string, number>>;
type Run = {id: string; flag: 0|1; first_result_ms: number|null; complete_ms: number; items: {url: string; relevance: number|null}[]; error?: string};
const file = fileURLToPath(import.meta.url);
const queries: Query[] = JSON.parse(readFileSync('evaluation/field-queries.json', 'utf8')).queries;
const labels: Labels = JSON.parse(readFileSync('evaluation/field-labels.json', 'utf8'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Each case runs in a fresh process and private in-memory database: neither variant learns from the other,
// and provider lanes, route caches, circuits, verdict caches and budgets cannot leak between cases.
async function one(id: string, flag: 0|1, output: string) {
 const query = queries.find(q => q.id === id && ['web', 'docs'].includes(q.tab));
 if (!query) throw new Error(`Unknown Web/Docs query: ${id}`);
 const base = tierConfig(readConfig(), tierSchema.parse(process.env.DEEP_EVAL_TIER ?? 'ssj3'));
 if (!base.FIELD_ROUTING_ENABLED || !base.FIELD_ROUTING_SITES || !base.OPENROUTER_API_KEY || !base.QUERY_REWRITE_MODEL)
   throw new Error('Evaluation requires field routing and its model credentials; otherwise the flag cannot affect routed retrieval.');
 const config = {...base, DEEP_SOURCES: flag === 1, ANSWER_ENABLED: false};
 const db = embedded();
 try {
   await migrate(db);
   // Optional operator-exported learning state, identically seeded in both variants. No production DB is opened.
   if (process.env.DEEP_EVAL_SEED) {
     const seed = JSON.parse(readFileSync(process.env.DEEP_EVAL_SEED, 'utf8'));
     for (const row of seed.field_sources ?? []) await db.query('INSERT INTO field_sources(field,domain,good,poor) VALUES($1,$2,$3,$4)', [row.field, row.domain, row.good, row.poor]);
     for (const row of seed.site_search ?? []) await db.query('INSERT INTO site_search(domain,template,status,checked_at,hits,good) VALUES($1,$2,$3,$4,$5,$6)',
       [row.domain, row.template, row.status, row.checked_at, row.hits, row.good]);
   }
   const started = performance.now(); let first: number|null = null;
   const out = await searchWeb(db, config, webSearchInput.parse({q: query.q, kind: query.tab, tier: config.TIER}));
   let list: WebResult[] = out.results;
   if (list.length) first = performance.now() - started;
   // The initial endpoint returns candidates, then the existing review/hunt token exposes final judgement.
   let complete = !out.review && !out.hunt;
   while (!complete && performance.now() - started < 240_000) {
     await sleep(100);
     if (out.review) {
       const state = webReviewState(out.review);
       if (!state) throw new Error('Web review expired');
       list = state.results; complete = state.status === 'complete';
     } else if (out.hunt) {
       const state = huntState(out.hunt);
       if (!state) throw new Error('Document hunt expired');
       list = state.docs.filter(d => d.state === 'kept'); complete = state.status === 'complete';
     }
     if (first === null && list.length) first = performance.now() - started;
   }
   const run: Run = {id, flag, first_result_ms: first, complete_ms: performance.now() - started,
     items: list.map(r => ({url: r.url, relevance: r.judgement?.relevance ?? null})), ...(!complete ? {error: 'review_timeout'} : {})};
   if (!out.review && !out.hunt) run.error = 'no_review_or_hunt';
   writeFileSync(output, JSON.stringify(run, null, 2));
 } finally { await db.close(); }
}

function metrics(row: Run) {
 const unique = [...new Map(row.items.map(i => [i.url, i])).values()];
 const judged = unique.filter(i => i.relevance !== null), good = judged.filter(i => i.relevance! >= 8).length;
 const graded = unique.filter(i => labels[row.id]?.[i.url] !== undefined);
 return {judged_good: good, returned_judged_precision: judged.length ? good / judged.length : null, judged: judged.length,
   unjudged: unique.length - judged.length, human_precision: graded.length ? graded.filter(i => labels[row.id][i.url] === 2).length / graded.length : null,
   label_coverage: unique.length ? graded.length / unique.length : null, returned: unique.length,
   first_result_ms: row.first_result_ms, complete_ms: row.complete_ms};
}
function child(id: string, flag: 0|1, output: string): Promise<void> {
 return new Promise((resolveChild, reject) => {
   const processChild = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', file, '--case', id, String(flag), output],
     {env: {...process.env, DEEP_SOURCES: String(flag)}, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
   let detail = ''; processChild.stderr.on('data', chunk => { detail = (detail + chunk.toString()).slice(-2000); });
   const timer = setTimeout(() => { processChild.kill(); reject(new Error('case_timeout')); }, 300_000);
   processChild.on('error', e => { clearTimeout(timer); reject(e); });
   processChild.on('exit', code => { clearTimeout(timer); code === 0 ? resolveChild() : reject(new Error(`case exited ${code}: ${detail}`)); });
 });
}
async function compare() {
 const only = process.env.DEEP_EVAL_IDS?.split(',');
 const selected = queries.filter(q => ['web', 'docs'].includes(q.tab) && q.id in labels && (!only || only.includes(q.id)));
 if (!selected.length) throw new Error('No labelled Web/Docs queries selected');
 const directory = resolve('output', 'deep-sources-eval', new Date().toISOString().replace(/[:.]/g, '-'));
 mkdirSync(directory, {recursive: true});
 const rows: Run[] = [];
 for (const [i, query] of selected.entries()) {
   // Alternate order to reduce warm upstream cache and time-of-day bias.
   for (const flag of (i % 2 ? [1, 0] : [0, 1]) as (0|1)[]) {
     const output = resolve(directory, `${query.id}-${flag}.json`);
     try { await child(query.id, flag, output); rows.push(JSON.parse(readFileSync(output, 'utf8'))); }
     catch (e) { const failed: Run = {id: query.id, flag, first_result_ms: null, complete_ms: 0, items: [], error: String(e)};
       rows.push(failed); writeFileSync(output, JSON.stringify(failed, null, 2)); }
     console.log(query.id, `DEEP_SOURCES=${flag}`, rows.at(-1)!.error ?? metrics(rows.at(-1)!));
   }
 }
 const paired = selected.filter(q => [0, 1].every(flag => rows.some(r => r.id === q.id && r.flag === flag && !r.error)));
 const mean = (values: (number|null)[]) => { const n = values.filter((v): v is number => v !== null); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; };
 const summary = [0, 1].map(flag => {
   const scored = rows.filter(r => r.flag === flag && paired.some(q => q.id === r.id)).map(metrics);
   return {flag, queries: scored.length, judged_good_per_query: mean(scored.map(m => m.judged_good)),
     precision: mean(scored.map(m => m.returned_judged_precision)), human_precision: mean(scored.map(m => m.human_precision)),
     label_coverage: mean(scored.map(m => m.label_coverage)), first_result_ms: mean(scored.map(m => m.first_result_ms)),
     queries_without_results: scored.filter(m => m.first_result_ms === null).length, complete_ms: mean(scored.map(m => m.complete_ms))};
 });
 writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify({
   note: 'Paired successful queries only. Precision is among returned judged results; human precision excludes unlabelled URLs. First result means first nonempty API response, including initial unjudged candidates. No exhaustive recall claim.',
   seed: process.env.DEEP_EVAL_SEED ?? null, summary, failures: rows.filter(r => r.error),
   queries: paired.map(q => ({...q, off: metrics(rows.find(r => r.id === q.id && r.flag === 0)!), on: metrics(rows.find(r => r.id === q.id && r.flag === 1)!)})),
 }, null, 2));
 console.table(summary); console.log(`Saved ${directory}`);
}

if (process.argv[2] === '--case') {
 const flag = process.argv[4]; if (flag !== '0' && flag !== '1') throw new Error('Invalid flag');
 // A case owns its child process: stop remaining background work after the saved final observation.
 try { await one(process.argv[3], Number(flag) as 0|1, process.argv[5]); process.exit(0); }
 catch (error) { console.error(error); process.exit(1); }
} else if (process.argv[2] === '--run') await compare();
else console.log('Opt-in live evaluation: node --env-file-if-exists=.env --import tsx scripts/deep-sources-eval.ts --run');
