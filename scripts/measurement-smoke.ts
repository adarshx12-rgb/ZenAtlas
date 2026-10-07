// Two real video tasks exercise persisted main/closest placements and requirement accounting:
// each search's stored trace must exist and its stored metrics must equal traceMetrics recomputed now.
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { traceMetrics } from '../src/learning.js';
import { costOf, linesSince, logOffsets, search, sleep } from './suite-client.js';

const db = connect(readConfig().DATABASE_URL), rows: any[] = [];
const queries = ['official Blender Big Buck Bunny short film', 'Steve Jobs Stanford commencement speech 2005'];
const FILE = 'output/order1-tracing/checked.json';
// JSONB does not keep key order, so objects are compared with their keys sorted.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
 v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
mkdirSync('output/order1-tracing', {recursive: true});
try {
 for (const q of queries) {
   const logs = logOffsets(), started = Date.now();
   try {
     const result = await search('videos', q, 'ssj3');
     const elapsed = Date.now() - started; await sleep(1500);
     const stored = result.trace_id ? (await db.query(`SELECT trace,metrics FROM search_traces WHERE trace->>'trace_id'=$1
       ORDER BY created_at DESC LIMIT 1`, [result.trace_id])).rows[0] : null;
     const metrics = stored ? traceMetrics(stored.trace) : null;
     rows.push({q, ms: elapsed, ...result, usage: costOf(linesSince(logs), result.trace_id),
       measurement: {trace_found: !!stored, metrics_consistent: !!stored && canonical(metrics) === canonical(stored.metrics)},
       trace: stored?.trace ?? null, metrics: stored?.metrics ?? null});
     console.log(JSON.stringify({q, seconds: elapsed / 1000, results: result.results.length, trace_id: result.trace_id, metrics}));
   } catch (error) {
     rows.push({q, ms: Date.now() - started, error: String(error)});
     console.log(JSON.stringify({q, error: String(error)}));
     process.exitCode = 1;
   }
   writeFileSync(FILE, JSON.stringify(rows, null, 2));
 }
 if (rows.some(r => !r.measurement?.trace_found || !r.measurement?.metrics_consistent)) process.exitCode = 1;
} finally { await db.close(); }
