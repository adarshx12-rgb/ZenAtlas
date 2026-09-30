// Critic model benchmark: re-audits recent searches with two critic models side by side, on the live traces but
// without writing audits or spending the live critic budget, and reports cost, latency, failures, invented urls and
// how many claimed missing sources a real site: probe confirmed.
// Usage: node --env-file-if-exists=.env --import tsx scripts/critic-bench.ts [traces] [modelA,modelB]
import { writeFileSync, mkdirSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { connect, type DB } from '../src/db.js';
import { auditTrace, criticClient, type Audit } from '../src/learning.js';
import { fetchJSON } from '../src/http.js';

const n = Number(process.argv[2]) || 10;
const models = (process.argv[3] ?? 'anthropic/claude-sonnet-5,moonshotai/kimi-k3').split(',');
const config = configSchema.parse({...process.env, CRITIC_DAILY_BUDGET: '10000', CRITIC_ENABLED: 'true'});
const real = connect(config.DATABASE_URL);

type Run = {model: string; trace: string; query: string; status: string; code?: string; ms: number; cost: number; calls: number;
 raw_misranked: number; raw_issue_urls: number; audit?: Audit; probes?: {domain: string; status: string; relevant: number; checked: number}[]};
// Reads go to the live database; audit and budget writes are captured instead, so the live critic is untouched.
function sandbox(captured: {row?: unknown[]}): DB {
 const db: DB = {
   async query(sql: string, params?: unknown[]) {
     if (/INSERT INTO search_audits/i.test(sql)) { captured.row = params; return {rows: []}; }
     if (/FROM search_audits/i.test(sql)) return {rows: []};
     if (/budgets/i.test(sql)) return {rows: /^\s*SELECT/i.test(sql) ? [{used: 0}] : [{used: 1}]};
     if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return {rows: []};
     return real.query(sql, params);
   },
   async transaction(fn: (tx: DB) => unknown) { return fn(db); }, async close() {},
 } as unknown as DB;
 return db;
}

// The latest search of each audited topic, so near-identical rewordings of one request do not fill the sample.
const traces = (await real.query(`SELECT id,query FROM (SELECT DISTINCT ON (lower(a.audit->>'topic')) t.id,t.query,t.created_at FROM search_traces t
 JOIN search_audits a ON a.trace_id=t.id WHERE a.status='complete' AND coalesce(t.trace->>'tier','ssj3')='ssj3'
 ORDER BY lower(a.audit->>'topic'),t.created_at DESC) x ORDER BY created_at DESC LIMIT $1`, [n])).rows as {id: string; query: string}[];
const runs: Run[] = [];
// Three searches at a time, each audited by every model at once.
const pending = [...traces];
await Promise.all([0, 1, 2].map(async () => { for (let t = pending.shift(); t; t = pending.shift()) {
 await Promise.all(models.map(async model => {
   const captured: {row?: unknown[]} = {}, db = sandbox(captured);
   const run: Run = {model, trace: t!.id, query: t!.query, status: '', ms: 0, cost: 0, calls: 0, raw_misranked: 0, raw_issue_urls: 0};
   const transport = (async (url: string, options: Parameters<typeof fetchJSON>[1]) => {
     const raw = await fetchJSON(url, options);
     run.calls++; if (typeof raw?.usage?.cost === 'number') run.cost += raw.usage.cost;
     // The first call is the audit: count urls before the invented ones are filtered out.
     if (run.calls === 1) try { const v = JSON.parse(raw.choices[0].message.content);
       run.raw_misranked = v.best_results?.misranked?.length ?? 0;
       run.raw_issue_urls = (v.quality?.issues ?? []).reduce((s: number, i: {urls?: unknown[]}) => s + (i.urls?.length ?? 0), 0); } catch {}
     return raw;
   }) as typeof fetchJSON;
   const client = criticClient(db, config, model, transport);
   (client as unknown as {log: () => void}).log = () => {};
   const start = Date.now();
   try { Object.assign(run, await auditTrace(db, config, t!.id, {client})); } catch (e) { run.status = 'error'; run.code = String(e); }
   run.ms = Date.now() - start;
   if (captured.row) { run.audit = JSON.parse(String(captured.row[4] ?? 'null')) ?? undefined; run.probes = JSON.parse(String(captured.row[5] ?? 'null')) ?? undefined; }
   runs.push(run);
   console.log(JSON.stringify({model, query: t!.query.slice(0, 50), status: run.status, code: run.code, s: Math.round(run.ms / 1000), cost: run.cost.toFixed(4)}));
 }));
} }));

const summary = models.map(model => {
 const r = runs.filter(x => x.model === model), ok = r.filter(x => x.status === 'complete');
 const probes = ok.flatMap(x => x.probes ?? []);
 const kept = ok.reduce((s, x) => s + (x.audit?.best_results.misranked.length ?? 0), 0), raw = ok.reduce((s, x) => s + x.raw_misranked, 0);
 const avg = (f: (a: Audit) => number) => ok.length ? ok.reduce((s, x) => s + f(x.audit!), 0) / ok.length : null;
 return {model, audits: r.length, complete: ok.length, failed: r.filter(x => x.status !== 'complete').map(x => x.code),
   cost_total: +r.reduce((s, x) => s + x.cost, 0).toFixed(4), cost_per_audit: +(r.reduce((s, x) => s + x.cost, 0) / (r.length || 1)).toFixed(4),
   median_s: +(r.map(x => x.ms).sort((a, b) => a - b)[Math.floor(r.length / 2)] / 1000).toFixed(1),
   misranked_kept: kept, misranked_invented: raw - kept,
   sources_claimed: probes.length, confirmed: probes.filter(p => p.status === 'confirmed').length, weak: probes.filter(p => p.status === 'weak').length,
   refuted: probes.filter(p => p.status === 'refuted').length, no_results: probes.filter(p => p.status === 'no_results').length,
   avg_best_score: avg(a => a.best_results.score), avg_quality: avg(a => a.quality.score),
   depth: Object.fromEntries(['too_shallow', 'enough', 'too_deep'].map(d => [d, ok.filter(x => x.audit!.search_depth.verdict === d).length]))};
});
// Where the two models land on the same search: score gaps and whether they call the same depth.
const pairs = traces.map(t => { const [a, b] = models.map(m => runs.find(x => x.model === m && x.trace === t.id)?.audit);
 return a && b ? {query: t.query, best: [a.best_results.score, b.best_results.score], quality: [a.quality.score, b.quality.score],
   depth: [a.search_depth.verdict, b.search_depth.verdict], sources: [a.missing_sources.sources.map(s => s.domain), b.missing_sources.sources.map(s => s.domain)]} : null; }).filter(Boolean);
console.table(summary);
mkdirSync('output', {recursive: true});
const file = `output/critic-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({models, summary, pairs, runs}, null, 1));
console.log(file);
process.exit(0);
