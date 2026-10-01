// Early scene probe (docs/superpowers/specs/2026-10-01-early-scenes-design.md): runs one search through the live search
// path (sceneLive) in-process, then watches the scene_analysis jobs it queued until they finish. It reports when results
// were ready, when each scene job was created and finished, and when judging ended: the old code queued scene jobs only
// after judging, so that mark is where the same jobs would have started before this change.
// Usage: node --env-file-if-exists=.env --import tsx scripts/probe-early-scenes.ts "<query>"
// Uses the live database, budgets and the live scenes worker; never migrates or restarts services.
import { configSchema } from '../src/config.js';
import { connect } from '../src/db.js';
import { runDiscovery } from '../src/discovery.js';
import { searchInput } from '../src/types.js';

const q = process.argv[2];
if (!q) throw new Error('usage: probe-early-scenes.ts "<query>"');
const config = configSchema.parse(process.env);
const db = connect(config.DATABASE_URL);
const lines: Record<string, unknown>[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
 for (const line of String(chunk).split(/\r?\n/)) { try { const v = JSON.parse(line); if (v?.event) lines.push(v); } catch {} }
 return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const started = new Date();
const out = await runDiscovery(db, config, searchInput.parse({q}), undefined, {sceneLive: true}, async () => {});
const ready = Date.now() - started.getTime();
const secs = (ms: number) => Math.round(ms / 100) / 10;
const jobs = async () => (await db.query(`SELECT id,created_at,updated_at,status,result->>'status' AS result FROM jobs
 WHERE kind='scene_analysis' AND created_at>=$1 AND payload->>'query'=$2 ORDER BY created_at`, [started, q.slice(0, 500)])).rows;
for (let i = 0; i < 48; i++) {
 const rows = await jobs();
 if (rows.length && rows.every(r => ['complete', 'failed'].includes(r.status))) break;
 await new Promise(r => setTimeout(r, 5000));
}
const rows = await jobs();
const timings = out.trace.timings as Record<string, number> | undefined;
const evidence = (timings?.evidence ?? {}) as unknown as Record<string, number>;
const searchedAt = timings?.expanded ?? 0;
console.error(JSON.stringify({q, watch: (out.trace.plan as {watch?: boolean}).watch ?? null, results_ready_s: secs(ready), shown: out.results.length,
 old_start_s: secs(searchedAt + (evidence.judge ?? 0)),
 early: lines.find(l => l.event === 'scene_early') ?? null,
 in_time: lines.find(l => l.event === 'scene_early_in_time') ?? null,
 watched_in_first_results: out.results.filter(r => (r.evidence_coverage?.analysed_scenes ?? 0) > 0).map(r => ({title: r.title.slice(0, 60), relevance: r.judgement?.relevance ?? null})),
 scene_jobs: rows.map(r => ({created_s: secs(new Date(r.created_at).getTime() - started.getTime()),
   finished_s: ['complete', 'failed'].includes(r.status) ? secs(new Date(r.updated_at).getTime() - started.getTime()) : null, status: r.status, result: r.result}))}, null, 1));
await db.close();
process.exit(0);
