// Judge architecture benchmark (docs/superpowers/specs/2026-09-27-judge-cascade-design.md): runs the live council and the
// proposed cascade on evaluation/council-bench.json with the real JevJudge, ModelJudge and councilReview, and reports
// label accuracy, pair accuracy, calls and cost per role, wall time per case and how much work each stage took.
//   council: Jev gate (rejects, no settling, as Web) -> Scorer -> Checker on the top 15 -> Chair on disputes.
//   cascade: Jev (settles and rejects on verbatim snippets) -> Scorer on the rest -> flags -> Strong judge on flagged only.
// Usage: node --env-file-if-exists=.env --import tsx scripts/judge-arch-bench.ts [runs]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { ModelJudge, groundedQuote, TANGENTIAL, type Judge, type JudgeCandidate, type JudgeContext, type Verdict } from '../src/judge.js';
import { JevJudge, snippetsOf, type JevRecord } from '../src/jev-judge.js';
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
const SCORER = 'google/gemini-3.5-flash-lite', CHECKER = 'openai/gpt-5.6-terra', CHAIR = 'anthropic/claude-sonnet-5', STRONG = 'openai/gpt-5.6-terra';
// BENCH_ARCHS=cascade runs one architecture; CASCADE_SCORER / CASCADE_STRONG swap the cascade's two judges.
// CASCADE_BORDER=4-7: the Scorer relevance range the Strong judge re-checks.
const AUDIT_RATE = 0.1, BORDER = (process.env.CASCADE_BORDER ?? '4-6').split('-').map(Number) as [number, number];
const ARCHS = (process.env.BENCH_ARCHS ?? 'council,cascade').split(','), CASCADE_SCORER = process.env.CASCADE_SCORER ?? SCORER,
 CASCADE_STRONG = process.env.CASCADE_STRONG ?? STRONG;

type Spend = Record<string, {calls: number; cost: number; ms: number}>;
// Counts every model call and its reported cost under the role that made it.
const meter = (spend: Spend, role: string) => (async (url: string, options: Parameters<typeof fetchJSON>[1]) => {
 const t = Date.now(), raw = await fetchJSON(url, options);
 const s = spend[role] ??= {calls: 0, cost: 0, ms: 0}; s.calls++; s.cost += raw?.usage?.cost ?? 0; s.ms += Date.now() - t;
 return raw;
}) as typeof fetchJSON;
const seat = (spend: Spend, role: string, model: string, timeout: number, maxTokens = 8192) =>
 new ModelJudge(new OpenAICompatibleClient(db, {...config, JUDGE_TIMEOUT_MS: timeout}, [model], meter(spend, role), maxTokens), config, role);
async function inBatches(judge: Judge, query: string, list: JudgeCandidate[], size: number, context: JudgeContext) {
 const out = new Map<string, Verdict>();
 const done = await Promise.allSettled(Array.from({length: Math.ceil(list.length / size)}, (_, i) => judge.judge(query, list.slice(i * size, (i + 1) * size), context)));
 for (const d of done) if (d.status === 'fulfilled') for (const [k, v] of d.value.verdicts) out.set(k, v);
 return out;
}

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

// Why a Scorer verdict goes to the Strong judge; none means it stands.
function flags(c: JudgeCandidate, v: Verdict, r: JevRecord|undefined, required: number): string[] {
 const out: string[] = [], thr = config.JEV_JUDGE_CONFIDENCE, answers = Object.values(r?.requirements ?? {});
 if (v.relevance >= BORDER[0] && v.relevance <= BORDER[1]) out.push('borderline');
 const jevMismatch = answers.some(a => a.choice === 'mismatch' && a.confidence >= thr);
 const jevBacked = answers.length === required && required > 0 && answers.every(a => a.choice.startsWith('s') && a.confidence >= thr);
 if ((jevMismatch && v.relevance > TANGENTIAL) || (jevBacked && v.relevance <= TANGENTIAL)) out.push('conflicts_with_evidence');
 const grounded = (v.requirementChecks ?? []).filter(ch => ch.status === 'supported' && groundedQuote(c, ch)).length;
 if (v.relevance >= 7 && required > 0 && grounded < required && snippetsOf(c).length) out.push('unbacked');
 return out;
}

async function cascade(c: Case, spend: Spend) {
 const candidates = c.candidates.map(({label: _l, ...rest}) => rest as JudgeCandidate);
 const required = c.context.requirements?.length ?? 0;
 // Stage 1: Jev alone (no inner judge) settles or rejects on snippets and returns everything else unjudged.
 const jev = await new JevJudge(db, {...config, JEV_JUDGE_REJECT: true}, undefined, meter(spend, 'jev'), {settle: true}).judge(c.query, candidates, c.context);
 const records = (jev.jev ?? new Map()) as Map<string, JevRecord>;
 // Only snippet-backed decisions stand: a rejection from Jev's low score and confidence alone, with no confident
 // mismatch snippet, goes to the Scorer like any undecided candidate.
 const backedReject = (r?: JevRecord) => Object.values(r?.requirements ?? {}).some(a => a.choice === 'mismatch' && a.confidence >= config.JEV_JUDGE_CONFIDENCE);
 const decided = new Map([...jev.verdicts].filter(([k]) => records.get(k)?.outcome === 'settled' || backedReject(records.get(k))));
 const verdicts = new Map(decided);
 const audited = candidates.filter(x => records.get(x.key)?.outcome === 'settled' && Math.random() < AUDIT_RATE);
 // Stage 2: the Scorer on everything Jev did not decide, plus the audited sample of settled ones.
 const toScore = candidates.filter(x => !verdicts.has(x.key) || audited.includes(x));
 const scored = await inBatches(seat(spend, 'scorer', CASCADE_SCORER, config.JUDGE_TIMEOUT_MS), c.query, toScore, 6, c.context);
 for (const [k, v] of scored) verdicts.set(k, v);
 // Stage 3: flags. Stage 4: the Strong judge re-judges flagged verdicts only, and its verdict is final.
 const flagged = candidates.flatMap(x => { const v = verdicts.get(x.key); const f = v && (!decided.has(x.key) || audited.includes(x)) ? flags(x, v, records.get(x.key), required) : [];
   return f.length ? [{x, f}] : []; });
 const note = 'A faster judge scored these candidates and each was flagged as uncertain (borderline, in conflict with quoted evidence, or confident without quoted support). Judge each from its evidence yourself.';
 const strong = flagged.length ? await inBatches(seat(spend, 'strong', CASCADE_STRONG, config.COUNCIL_CHECKER_TIMEOUT_MS), c.query, flagged.map(f => f.x), 5,
   {...c.context, criteria: [...c.context.criteria, note]}) : new Map<string, Verdict>();
 for (const [k, v] of strong) verdicts.set(k, v);
 const reasons: Record<string, number> = {};
 for (const f of flagged) for (const r of f.f) reasons[r] = (reasons[r] ?? 0) + 1;
 return {verdicts, jev: records, stages: {decided_by_jev: decided.size, audited: audited.length, scored: toScore.length, escalated: flagged.length, reasons}};
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
 for (const row of rows) for (const [k, v] of Object.entries(row.spend)) { const s = roles[k] ??= {calls: 0, cost: 0, ms: 0}; s.calls += v.calls; s.cost += v.cost; s.ms += v.ms; }
 const ms = rows.filter(x => !x.error).map(x => x.ms).sort((a, b) => a - b);
 const summary = {case_runs: rows.length, failures: rows.filter(x => x.error).map(x => `${x.case}#${x.run}: ${x.error}`), missing_verdicts: missing,
   label_accuracy: +(right / labels).toFixed(3), pair_accuracy: +(pairsRight / pairs).toFixed(3),
   cost_per_case: +(Object.values(roles).reduce((a, s) => a + s.cost, 0) / rows.length).toFixed(5),
   median_ms: ms[Math.floor(ms.length / 2)] ?? null, p90_ms: ms[Math.floor(ms.length * 0.9)] ?? null,
   per_role: Object.fromEntries(Object.entries(roles).map(([k, s]) => [k, {calls_per_case: +(s.calls / rows.length).toFixed(2), cost_per_case: +(s.cost / rows.length).toFixed(5), ms_per_call: Math.round(s.ms / Math.max(1, s.calls))}]))};
 report[name] = {border: BORDER, scorer: name === 'cascade' ? CASCADE_SCORER : SCORER, strong: name === 'cascade' ? CASCADE_STRONG : null, summary, rows};
 console.log(name.padEnd(8), JSON.stringify(summary));
}
mkdirSync('output/judge-arch-bench', {recursive: true});
const file = `output/judge-arch-bench/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 1));
console.log('saved', file);
