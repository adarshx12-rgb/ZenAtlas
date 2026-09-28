// Judge architecture benchmark (docs/superpowers/specs/2026-09-27-judge-cascade-design.md): runs the live council and the
// proposed cascade on evaluation/council-bench.json with the real JevJudge, ModelJudge and councilReview, and reports
// label accuracy, pair accuracy, calls and cost per role, wall time per case and how much work each stage took.
//   council: Jev gate (rejects, no settling, as Web) -> Scorer -> Checker on the top 15 -> Chair on disputes.
//   cascade: Jev (settles and rejects on verbatim snippets) -> Scorer on the rest -> flags -> Strong judge on flagged only.
// Usage: node --env-file-if-exists=.env --import tsx scripts/judge-arch-bench.ts [runs]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { ModelJudge, TANGENTIAL, type JudgeCandidate, type JudgeContext } from '../src/judge.js';
import { JevJudge, type JevRecord } from '../src/jev-judge.js';
import { cascadeReview, cascadeOptions } from '../src/cascade.js';
import { createHash } from 'node:crypto';
import { councilReview } from '../src/council.js';
import { OpenAICompatibleClient } from '../src/openai-compatible.js';
import { fetchJSON } from '../src/http.js';
import type { DB } from '../src/db.js';

type Case = {id: string; query: string; context: JudgeContext; candidates: (JudgeCandidate & {label: 'good'|'bad'})[]; prefer: [string, string][]};
const {cases} = JSON.parse(readFileSync('evaluation/council-bench.json', 'utf8')) as {cases: Case[]};
const config = configSchema.parse({...process.env, JUDGE_DAILY_BUDGET: '100000', JEV_JUDGE_DAILY_BUDGET: '100000'});
// Budgets and health rows are not the point here: a stand-in database accepts every write.
const db = {async query() { return {rows: [{used: 1}]}; }, async transaction(fn: (tx: DB) => unknown) { return fn(db); }, async close() {}} as unknown as DB;
const runs = Number(process.argv[2]) || 3;
const SCORER = 'google/gemini-3.5-flash-lite', CHECKER = 'openai/gpt-5.6-terra', CHAIR = 'anthropic/claude-sonnet-5', STRONG = 'openai/gpt-6-luna';
// BENCH_ARCHS=cascade runs one architecture; CASCADE_SCORER / CASCADE_STRONG swap the cascade's two judges.
// CASCADE_BORDER=4-7: the Scorer relevance range the Strong judge re-checks.
const BORDER = (process.env.CASCADE_BORDER ?? `${config.CASCADE_BORDER_LOW}-${config.CASCADE_BORDER_HIGH}`).split('-').map(Number) as [number, number];
const ARCHS = (process.env.BENCH_ARCHS ?? 'council,cascade').split(','), CASCADE_SCORER = process.env.CASCADE_SCORER ?? SCORER,
 CASCADE_STRONG = process.env.CASCADE_STRONG ?? STRONG;

type Spend = Record<string, {calls: number; cost: number; ms: number; unpriced: number; failed: number}>;
// Counts every model call and its reported cost under the role that made it.
const meter = (spend: Spend, role: string) => (async (url: string, options: Parameters<typeof fetchJSON>[1]) => {
 const t = Date.now(), s = spend[role] ??= {calls: 0, cost: 0, ms: 0, unpriced: 0, failed: 0}; s.calls++;
 try {
   const raw = await fetchJSON(url, options);
   if (typeof raw?.usage?.cost === 'number') s.cost += raw.usage.cost; else s.unpriced++;
   return raw;
 } catch (error) { s.failed++; s.unpriced++; throw error; }
 finally { s.ms += Date.now() - t; }
}) as typeof fetchJSON;
const seat = (spend: Spend, role: string, model: string, timeout: number, maxTokens = 8192) =>
 new ModelJudge(new OpenAICompatibleClient(db, {...config, JUDGE_TIMEOUT_MS: timeout}, [model], meter(spend, role), maxTokens), config, role);

async function council(c: Case, spend: Spend) {
 const candidates = c.candidates.map(({label: _l, ...rest}) => rest as JudgeCandidate);
 const jev = new JevJudge(db, {...config, JEV_JUDGE_REJECT: true}, seat(spend, 'scorer', SCORER, config.JUDGE_TIMEOUT_MS), meter(spend, 'jev'), {settle: false});
 const first = await jev.judge(c.query, candidates, c.context);
 const reviewed = await councilReview(c.query, candidates, first.verdicts, c.context, undefined,
   {checker: seat(spend, 'checker', CHECKER, config.COUNCIL_CHECKER_TIMEOUT_MS), chair: seat(spend, 'chair', CHAIR, config.COUNCIL_CHAIR_TIMEOUT_MS, 16000)},
   {top: 15, disagreement: 3, sureScore: 8, log: () => {}});
 const disputed = [...reviewed.records.values()].filter(r => r.disputed).length;
 return {verdicts: reviewed.verdicts, jev: first.jev as Map<string, JevRecord>|undefined, stages: {checked: reviewed.records.size, disputed}};
}

async function cascade(c: Case, spend: Spend) {
 const candidates = c.candidates.map(({label: _l, ...rest}) => rest as JudgeCandidate);
 const first = await new JevJudge(db, {...config, JEV_JUDGE_REJECT: true},
   seat(spend, 'scorer', CASCADE_SCORER, config.JUDGE_TIMEOUT_MS), meter(spend, 'jev'),
   {settle: c.context.kind === 'videos' ? true : config.WEB_JEV_SETTLE}).judge(c.query, candidates, c.context);
 // Frozen-evidence benchmark: use the production router; external inspections are deliberately disabled.
 let stages: Record<string, unknown> = {};
 let seed = createHash('sha256').update(c.id).digest().readUInt32LE(0);
 const reviewed = await cascadeReview(c.query, candidates, first.verdicts, first.jev, c.context, undefined,
   seat(spend, 'strong', CASCADE_STRONG, config.CASCADE_STRONG_TIMEOUT_MS), {...cascadeOptions(config), border: BORDER, inspectionLimit: 0,
     random: () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296), log: line => { stages = line; }});
 return {verdicts: reviewed.verdicts, jev: first.jev as Map<string, JevRecord>|undefined, stages};
}

const report: Record<string, unknown> = {};
for (const [name, run] of ([['council', council], ['cascade', cascade]] as const).filter(([n]) => ARCHS.includes(n))) {
 const rows: {case: string; run: number; ms: number; spend: Spend; scores: Record<string, number|null>; stages: unknown; jev: Record<string, number>; error: string|null}[] = [];
 for (let r = 1; r <= runs; r++) rows.push(...await Promise.all(cases.map(async c => {
   const spend: Spend = {}, t = Date.now();
   try {
     const out = await run(c, spend);
     const jev: Record<string, number> = {};
     for (const rec of out.jev?.values() ?? []) jev[rec.outcome] = (jev[rec.outcome] ?? 0) + 1;
     return {case: c.id, run: r, ms: Date.now() - t, spend, scores: Object.fromEntries(c.candidates.map(x => [x.key, out.verdicts.get(x.key)?.relevance ?? null])), stages: out.stages, jev, error: null};
   } catch (e) { return {case: c.id, run: r, ms: Date.now() - t, spend, scores: {}, stages: null, jev: {}, error: (e as {code?: string}).code ?? String(e)}; }
 })));
 let labels = 0, right = 0, pairs = 0, pairsRight = 0, missing = 0;
 for (const row of rows) {
   const c = cases.find(x => x.id === row.case)!;
   for (const cand of c.candidates) { const s = row.scores[cand.key]; labels++; if (s == null) { missing++; continue; } if (cand.label === 'good' ? s > TANGENTIAL : s <= TANGENTIAL) right++; }
   for (const [a, b] of c.prefer) { pairs++; const sa = row.scores[a], sb = row.scores[b]; if (sa != null && sb != null && sa > sb) pairsRight++; }
 }
 const roles: Spend = {};
 for (const row of rows) for (const [k, v] of Object.entries(row.spend)) { const s = roles[k] ??= {calls: 0, cost: 0, ms: 0, unpriced: 0, failed: 0}; s.calls += v.calls; s.cost += v.cost; s.ms += v.ms; s.unpriced += v.unpriced; s.failed += v.failed; }
 const ms = rows.filter(x => !x.error).map(x => x.ms).sort((a, b) => a - b);
 const summary = {case_runs: rows.length, failures: rows.filter(x => x.error).map(x => `${x.case}#${x.run}: ${x.error}`), missing_verdicts: missing,
   label_accuracy: +(right / labels).toFixed(3), pair_accuracy: +(pairsRight / pairs).toFixed(3),
   cost_per_case: Object.values(roles).some(s => s.unpriced) ? null : +(Object.values(roles).reduce((a, s) => a + s.cost, 0) / rows.length).toFixed(5),
   reported_cost_per_case: +(Object.values(roles).reduce((a, s) => a + s.cost, 0) / rows.length).toFixed(5),
   unpriced_calls: Object.values(roles).reduce((a, s) => a + s.unpriced, 0),
   median_ms: ms[Math.floor(ms.length / 2)] ?? null, p90_ms: ms[Math.floor(ms.length * 0.9)] ?? null,
   per_role: Object.fromEntries(Object.entries(roles).map(([k, s]) => [k, {calls_per_case: +(s.calls / rows.length).toFixed(2), cost_per_case: s.unpriced ? null : +(s.cost / rows.length).toFixed(5),
     reported_cost_per_case: +(s.cost / rows.length).toFixed(5), unpriced_calls: s.unpriced, failed_calls: s.failed, ms_per_call: Math.round(s.ms / Math.max(1, s.calls))}]))};
 report[name] = {architecture_version: 'evidence-v2', production_router: name === 'cascade', frozen_evidence: true,
   source_hash: ['src/cascade.ts', 'src/judge.ts', 'src/jev-judge.ts', 'src/search-contract.ts', 'src/requirements.ts', 'src/config.ts']
     .reduce((hash, file) => hash.update(file).update(readFileSync(file)), createHash('sha256')).digest('hex'),
   web_settle: config.WEB_JEV_SETTLE, border: BORDER, scorer: name === 'cascade' ? CASCADE_SCORER : SCORER, strong: name === 'cascade' ? CASCADE_STRONG : null, summary, rows};
 console.log(name.padEnd(8), JSON.stringify(summary));
}
mkdirSync('output/judge-arch-bench', {recursive: true});
const file = `output/judge-arch-bench/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 1));
console.log('saved', file);
