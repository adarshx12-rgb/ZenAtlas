import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { runDiscovery } from '../src/discovery.js';
import { JevScreener, screeningOrder } from '../src/screener.js';
import { fetchJSON, UpstreamError } from '../src/http.js';
import { searchInput } from '../src/types.js';

const queries = [
 'official whatsapp chat ui interface from over past 3 years',
 'rosswell ufo incident real article',
 'robert greene art of seduction pdf',
];
const config = readConfig(), db = connect(config.DATABASE_URL);
const output = process.argv[2] || 'output/jev-evaluation-2026-09-23.json';
const report: any = {created_at: new Date().toISOString(), depth: 'quick', model: config.JEV_MODEL,
 confidence_threshold: config.JEV_SCREEN_CONFIDENCE, screening_timeout_ms: config.JEV_SCREEN_TIMEOUT_MS,
 candidate_limit: config.DISCOVERY_CANDIDATES, notes: 'Live searches. Final judge agreement is not human accuracy or statistical calibration.', queries: []};
await mkdir('output', {recursive: true});
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
try {
 for (const q of queries) {
   const started = Date.now();
   const run: any = {q, batches: [], baseline: [], decisions: []};
   report.queries.push(run);
   console.log(JSON.stringify({event: 'query_started', q}));
   const transport: typeof fetchJSON = async (url, options) => {
     const start = Date.now(), body = options?.body as any;
     try {
       const result = await fetchJSON(url, options);
       run.batches.push({elapsed_ms: Date.now() - start, model: result.model, usage: result.usage,
         request_candidates: body.state.candidates, answers: result.answers});
       await save();
       return result;
     } catch (error) {
       run.batches.push({elapsed_ms: Date.now() - start, error: error instanceof UpstreamError ? error.code : 'failed',
         status: error instanceof UpstreamError ? error.status : undefined, request_candidates: body.state.candidates});
       await save(); throw error;
     }
   };
   const screener = new JevScreener(db, config, transport);
   try {
     const out = await runDiscovery(db, config, searchInput.parse({q, mode: 'refresh', depth: 'quick'}), undefined, {
       screener: {async screen(query, candidates) {
         run.baseline = candidates.map((c, i) => ({url: c.item.url, title: c.item.title, description: c.item.description,
           creator: c.item.creator, provider: c.provider, baseline_rank: i + 1}));
         const start = Date.now();
         try {
           const result = await screener.screen(query, candidates);
           run.decisions = result.decisions;
           run.screening_order = screeningOrder(candidates, result.promising).map(c => c.item.url);
           run.screening_applied = true;
           console.log(JSON.stringify({event: 'screened', q, screened: result.screened, promoted: result.promising.size}));
           return result;
         } catch (error) {
           run.screening_applied = false;
           run.screening_order = candidates.map(c => c.item.url);
           throw error;
         } finally { run.screening_ms = Date.now() - start; await save(); }
       }},
     }, async () => {});
     run.trace = out.trace;
     run.results = out.results.map(r => ({url: r.canonical_url, title: r.title, judgement: r.judgement, evidence: r.evidence}));
     run.providers = out.providers;
     run.elapsed_ms = Date.now() - started;
     console.log(JSON.stringify({event: 'query_complete', q, candidates: run.baseline.length,
       screened: run.decisions?.length ?? 0, checked: out.trace.pool.length, shown: out.results.length, elapsed_ms: run.elapsed_ms}));
   } catch (error) {
     run.error = error instanceof UpstreamError ? error.code : 'evaluation_failed';
     console.log(JSON.stringify({event: 'query_failed', q, error: run.error}));
   }
   await save();
 }
} finally { await db.close(); }
console.log(JSON.stringify({event: 'report_saved', output}));
