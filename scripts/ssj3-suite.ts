// Runs the hand-written probe queries (videos, docs, web, images) against the running app on one tier and saves what each
// search returned, with its time, model cost (model_cost log lines) and cascade lines, for grading by hand.
// Run: node --env-file-if-exists=.env --import tsx scripts/ssj3-suite.ts [tier]   (nothing else should search meanwhile)
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3000', TIER = process.argv[2] ?? 'ssj3';
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
const LOGS = ['zenatlas-api-out.log', 'zenatlas-worker-out.log'].map(f => join(homedir(), '.pm2', 'logs', f));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const linesSince = (start: number[]) => LOGS.flatMap((f, i) => readFileSync(f).subarray(start[i]).toString().split('\n'))
 .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
let cookie = '';
async function get(path: string) {
 const r = await fetch(BASE + path, {headers: cookie ? {cookie} : {}});
 const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
 return r.json();
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function videos(q: string) {
 let s = await get(`/api/search?${new URLSearchParams({q, tier: TIER, mode: 'refresh', limit: '10'})}`);
 for (let i = 0; i < 200 && s.status === 'discovering'; i++) { await sleep(3000); s = await get(`/api/search/${s.search_id}`); }
 return {status: s.status, providers: s.providers, results: (s.results ?? []).slice(0, 10).map((r: any) => ({title: r.title, url: r.canonical_url, creator: r.creator,
   duration: r.duration, language: r.language, relevance: r.judgement?.relevance ?? null, reason: r.judgement?.reason ?? null,
   moments: (r.moments ?? []).slice(0, 3).map((m: any) => `${clock(m.focus?.[0] ?? m.start_seconds)} ${m.evidence_type}: ${String(m.summary).slice(0, 120)}`),
   requirements: (r.requirements ?? []).map((x: any) => `${x.text}: ${x.status}`)}))};
}
async function webOrDocs(q: string, kind: 'web'|'docs') {
 const body = await get(`/api/web?${new URLSearchParams({q, kind, tier: TIER})}`);
 const pick = (list: any[]) => list.slice(0, 10).map(r => ({title: r.title, url: r.url, snippet: r.snippet?.slice(0, 200) ?? null,
   published: r.published ?? null, relevance: r.judgement?.relevance ?? null, reason: r.judgement?.reason ?? null, lead: r.lead ?? false}));
 if (body.review) for (let i = 0; i < 120; i++) { const s = await get(`/api/web/review?token=${body.review}`);
   if (s.status === 'complete') return {rewrite: body.rewrite ?? null, providers: s.providers, results: pick(s.results ?? [])}; await sleep(2000); }
 if (body.hunt) for (let i = 0; i < 120; i++) { const s = await get(`/api/docs/hunt?token=${body.hunt}`);
   if (s.status === 'complete') return {rewrite: body.rewrite ?? null, providers: s.providers, results: pick(s.documents.filter((d: any) => d.state === 'kept'))}; await sleep(2000); }
 return {rewrite: body.rewrite ?? null, providers: body.providers, results: pick(body.results ?? [])};
}
async function images(q: string) {
 let body = await get(`/api/images?${new URLSearchParams({q, limit: '24', tier: TIER})}`);
 if (body.review) for (let i = 0; i < 60; i++) { const s = await get(`/api/images/review?token=${body.review}`);
   if (s.status === 'complete') { body = {...body, ...s}; break; } await sleep(2000); }
 return {providers: body.providers, removed: body.removed ?? null, results: (body.results ?? []).slice(0, 12).map((r: any) => ({title: r.title, page_url: r.page_url,
   source: r.source_name, engine: r.engine, license: r.license?.name ?? null, ai: !!r.ai_generated, relevance: r.judgement?.relevance ?? null,
   unseen: !!r.unseen, reason: r.judgement?.reason ?? null}))};
}

const rows: any[] = [];
for (const {tab, q, repeat} of QUERIES) for (let run = 1; run <= (repeat ?? 1); run++) {
 const start = LOGS.map(f => statSync(f).size), started = Date.now();
 let out: any;
 try { out = tab === 'videos' ? await videos(q) : tab === 'images' ? await images(q) : await webOrDocs(q, tab); }
 catch (e) { out = {error: String(e)}; }
 const ms = Date.now() - started; await sleep(3000);
 const lines = linesSince(start), costs = lines.filter(l => l.event === 'model_cost');
 const byRole: Record<string, number> = {};
 for (const l of costs) { const role = String(l.bucket).replace(/:.*$/, ''); byRole[role] = +((byRole[role] ?? 0) + (l.cost ?? 0)).toFixed(5); }
 const cost = costs.reduce((n, l) => n + (l.cost ?? 0), 0);
 rows.push({tab, q, run, tier: TIER, ms, cost_usd: +cost.toFixed(5), by_role: byRole, cascade: lines.filter(l => l.event === 'cascade'), council: lines.filter(l => l.event === 'council'), ...out});
 console.log(`${tab.padEnd(6)} #${run} ${(ms / 1000).toFixed(0)}s $${cost.toFixed(4)} ${out.results?.length ?? 0} results  ${q.slice(0, 60)}`);
}
const file = `output/ssj3-suite-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(rows, null, 1)); console.log('wrote', file);
