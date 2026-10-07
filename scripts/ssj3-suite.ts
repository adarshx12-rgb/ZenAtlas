// Runs the hand-written probe queries (videos, docs, web, images) against the running app on one tier and saves what each
// search returned, with its time, model cost (model_cost log lines) and cascade lines, for grading by hand.
// Run: node --env-file-if-exists=.env --import tsx scripts/ssj3-suite.ts [tier]   (nothing else should search meanwhile)
import { writeFileSync } from 'node:fs';
import { costOf, linesSince, logOffsets, search, sleep } from './suite-client.js';

const TIER = process.argv[2] ?? 'ssj3';
const QUERIES: {tab: 'videos'|'docs'|'web'|'images'; q: string; repeat?: number}[] = [
 // Repeats within DISCOVERY_CACHE_SECONDS (10 minutes) replay the first run, so stability needs runs further apart.
 {tab: 'videos', q: "the part in Steve Jobs' Stanford commencement speech where he talks about connecting the dots"},
 {tab: 'videos', q: 'moment in the Falcon Heavy test flight video when both side boosters land at the same time'},
 {tab: 'videos', q: 'hindi explainer on how UPI works, under 10 minutes, not from big news channels'},
 {tab: 'docs', q: 'which article of the GDPR covers the right to be forgotten'},
 {tab: 'docs', q: 'the Google paper that introduced MapReduce'},
 {tab: 'docs', q: 'RTI Act 2005 full text in Hindi'},
 {tab: 'web', q: 'current RBI repo rate'},
 {tab: 'web', q: 'how long can cooked rice be safely kept in the fridge'},
 {tab: 'web', q: 'postgres vs mysql for write-heavy workloads from engineers who ran both, not vendor blogs'},
 {tab: 'images', q: 'red vintage bicycle leaning against a blue wall'},
 {tab: 'images', q: 'free to use photo of mount everest with license and attribution'},
 {tab: 'images', q: "infographic showing india's population by state, not AI-generated"}];
const rows: any[] = [];
for (const {tab, q, repeat} of QUERIES) for (let run = 1; run <= (repeat ?? 1); run++) {
 const start = logOffsets(), started = Date.now();
 let out: any;
 try { out = await search(tab, q, TIER); }
 catch (e) { out = {error: String(e)}; }
 const ms = Date.now() - started; await sleep(3000);
 const lines = linesSince(start), {cost_usd: cost, by_role: byRole} = costOf(lines, out.trace_id);
 const ours = (event: string) => lines.filter(l => l.event === event && !!out.trace_id && l.trace_id === out.trace_id);
 rows.push({tab, q, run, tier: TIER, ms, cost_usd: cost, by_role: byRole, cascade: ours('cascade'), council: ours('council'), ...out});
 console.log(`${tab.padEnd(6)} #${run} ${(ms / 1000).toFixed(0)}s $${cost?.toFixed(4) ?? 'unknown'} ${out.results?.length ?? 0} results  ${q.slice(0, 60)}`);
}
const file = `output/ssj3-suite-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(rows, null, 1)); console.log('wrote', file);
