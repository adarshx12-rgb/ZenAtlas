// Judge seat benchmark: runs candidate models through the real ModelJudge (same prompt, schema and evidence ceilings as
// live searches) on evaluation/council-bench.json, several times each, and reports label accuracy, correct orderings,
// stability, latency, failures and token cost. Usage:
//   node --env-file-if-exists=.env --import tsx scripts/council-bench.ts [runs] model [model...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { ModelJudge, type JudgeCandidate, type JudgeContext } from '../src/judge.js';
import { OpenAICompatibleClient } from '../src/openai-compatible.js';
import { fetchJSON } from '../src/http.js';
import type { DB } from '../src/db.js';

type Case = {id: string; query: string; context: JudgeContext; candidates: (JudgeCandidate & {label: 'good'|'bad'})[]; prefer: [string, string][]};
const {cases} = JSON.parse(readFileSync('evaluation/council-bench.json', 'utf8')) as {cases: Case[]};
const config = configSchema.parse({...process.env, JUDGE_DAILY_BUDGET: '100000'});
// Budgets and health rows are not the point here: a stand-in database accepts every write.
const db = {async query() { return {rows: [{used: 1}]}; }, async transaction(fn: (tx: DB) => unknown) { return fn(db); }, async close() {}} as unknown as DB;
const runs = Number(process.argv[2]) || 3, models = process.argv.slice(3);

type Usage = {prompt: number; completion: number; cost: number};
async function once(model: string, c: Case) {
 const usage: Usage = {prompt: 0, completion: 0, cost: 0};
 const transport = (async (url: string, options: Parameters<typeof fetchJSON>[1]) => {
   const body = options?.body as Record<string, unknown> | undefined;
   const raw = await fetchJSON(url, {...options, body: body ? {...body, usage: {include: true}} : body});
   usage.prompt += raw?.usage?.prompt_tokens ?? 0; usage.completion += raw?.usage?.completion_tokens ?? 0; usage.cost += raw?.usage?.cost ?? 0;
   return raw;
 }) as typeof fetchJSON;
 const judge = new ModelJudge(new OpenAICompatibleClient(db, config, [model], transport), config, 'bench');
 const candidates = c.candidates.map(({label: _label, ...rest}) => rest);
 const t = Date.now();
 try {
   const out = await judge.judge(c.query, candidates, c.context);
   return {ms: Date.now() - t, usage, scores: Object.fromEntries(c.candidates.map(x => [x.key, out.verdicts.get(x.key)?.relevance ?? null])), error: null as string|null};
 } catch (e) { return {ms: Date.now() - t, usage, scores: {} as Record<string, number|null>, error: (e as {code?: string}).code ?? String(e)}; }
}

const report: Record<string, unknown> = {};
for (const model of models) {
 const perRun: {case: string; run: number; ms: number; usage: Usage; scores: Record<string, number|null>; error: string|null}[] = [];
 for (let run = 1; run <= runs; run++) {
   const results = await Promise.all(cases.map(c => once(model, c)));
   results.forEach((r, i) => perRun.push({case: cases[i].id, run, ...r}));
 }
 let labels = 0, labelsRight = 0, pairs = 0, pairsRight = 0, missing = 0;
 for (const r of perRun) {
   const c = cases.find(x => x.id === r.case)!;
   for (const cand of c.candidates) {
     const s = r.scores[cand.key];
     labels++; if (s === null || s === undefined) { missing++; continue; }
     if (cand.label === 'good' ? s >= 5 : s <= 4) labelsRight++;
   }
   for (const [a, b] of c.prefer) { pairs++; const sa = r.scores[a], sb = r.scores[b]; if (sa != null && sb != null && sa > sb) pairsRight++; }
 }
 // Stability: how far each candidate's score moves across runs, averaged.
 const spread: number[] = [];
 for (const c of cases) for (const cand of c.candidates) {
   const s = perRun.filter(r => r.case === c.id).map(r => r.scores[cand.key]).filter((x): x is number => x != null);
   if (s.length > 1) spread.push(Math.max(...s) - Math.min(...s));
 }
 const ok = perRun.filter(r => !r.error), ms = ok.map(r => r.ms).sort((a, b) => a - b);
 const summary = {calls: perRun.length, failures: perRun.filter(r => r.error).map(r => `${r.case}#${r.run}: ${r.error}`), missing_verdicts: missing,
   label_accuracy: +(labelsRight / labels).toFixed(3), pair_accuracy: +(pairsRight / pairs).toFixed(3),
   mean_spread: spread.length ? +(spread.reduce((a, b) => a + b, 0) / spread.length).toFixed(2) : null,
   median_ms: ms[Math.floor(ms.length / 2)] ?? null, p90_ms: ms[Math.floor(ms.length * 0.9)] ?? null,
   cost_usd_per_call: ok.length ? +(ok.reduce((a, r) => a + r.usage.cost, 0) / ok.length).toFixed(5) : null,
   tokens_per_call: ok.length ? Math.round(ok.reduce((a, r) => a + r.usage.prompt + r.usage.completion, 0) / ok.length) : null};
 report[model] = {summary, runs: perRun};
 console.log(model.padEnd(28), JSON.stringify(summary));
}
mkdirSync('output/council-bench', {recursive: true});
const file = `output/council-bench/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 1));
console.log('saved', file);
