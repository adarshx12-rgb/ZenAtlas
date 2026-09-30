// Name-first probe: runs quick video searches in-process on this checkout and records what each showed, how long each
// stage took and which model calls it made, so two checkouts (before/after) can be compared on the same queries.
// Usage: node --env-file-if-exists=.env --import tsx scripts/probe-name-first.ts <label> [query index]
// Run one query at a time and alternate which checkout goes first, so neither side always meets the other's caches.
// Uses the live database and normal search budgets; never migrates, resets budgets or restarts services.
import { writeFileSync, mkdirSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { connect } from '../src/db.js';
import { runDiscovery } from '../src/discovery.js';
import { searchInput } from '../src/types.js';

export const QUERIES = [
 'documentary about the guy who climbed El Capitan without ropes',
 'moment in a MKBHD review where he drops the phone',
 'hindi explainer on how UPI works, under 10 minutes, not from big news channels',
 'cat knocking a glass off a table in slow motion',
 'mr beast surprises a subscriber with a ps5',
 'underrated osint tools',
];
const label = process.argv[2] ?? 'run';
const only = process.argv[3] === undefined ? null : Number(process.argv[3]);
const queries = only === null ? QUERIES : [QUERIES[only]];
const config = configSchema.parse(process.env);
const db = connect(config.DATABASE_URL);

// Model-cost and stage lines the pipeline writes to stdout, collected per search.
let lines: Record<string, unknown>[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
 for (const line of String(chunk).split('\n')) { try { const v = JSON.parse(line); if (v && typeof v === 'object' && v.event) lines.push(v); } catch {} }
 return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const runs = [];
for (const q of queries) {
 lines = [];
 const started = Date.now();
 try {
   const out = await runDiscovery(db, config, searchInput.parse({q}), undefined, {}, async () => {});
   const costs = lines.filter(l => l.event === 'model_cost');
   const byBucket: Record<string, {calls: number; cost: number}> = {};
   for (const l of costs) { const b = byBucket[String(l.bucket)] ??= {calls: 0, cost: 0}; b.calls++; b.cost += Number(l.cost ?? 0); }
   runs.push({q, ms: Date.now() - started, timings: out.trace.timings, shown: out.results.length, closest: out.closest.length, checked: out.ingested.length,
     identify: (out.trace as {identify?: unknown}).identify ?? null, searches: out.searches.map(s => `${s.target}: ${s.query}`),
     top: out.results.slice(0, 5).map(r => ({title: r.title, url: r.canonical_url, relevance: r.judgement?.relevance ?? null, badges: r.badges})),
     notes: out.providers.filter(p => ['identify', 'link_expansion', 'gap_exploration'].includes(p.provider)).map(p => p.message),
     calls: byBucket, cost: +costs.reduce((s, l) => s + Number(l.cost ?? 0), 0).toFixed(4),
     corroboration: lines.find(l => l.event === 'corroboration') ?? null, identify_line: lines.find(l => l.event === 'identify') ?? null,
     pool: out.trace.pool.map(p => ({title: p.title, url: p.url, relevance: p.relevance, shown: p.shown, round: p.round}))});
 } catch (error) { runs.push({q, ms: Date.now() - started, error: String(error)}); }
 const last = runs.at(-1) as {ms: number; shown?: number; error?: string};
 console.error(JSON.stringify({label, q: q.slice(0, 50), s: Math.round(last.ms / 1000), shown: last.shown, error: last.error}));
}
mkdirSync('output', {recursive: true});
const file = `output/name-first-${label}${only === null ? '' : `-q${only}`}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({label, runs}, null, 1));
console.error(file);
await db.close();
process.exit(0);
