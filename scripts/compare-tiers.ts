// Runs the same real queries on SSJ3 and SSJ1 against the running app, one at a time, and records per search: results
// kept after review, time until the review (or discovery) finished, and what its model calls cost: the model_cost lines
// the app logs for every OpenRouter answer (tagged with tier and role), between the search's start and end. Video
// searches also wait for their critic audit, so its cost counts too. Jev calls (the same in both tiers, ~$0.00001 each)
// are not included; the key's usage figure lags by tens of seconds, so it cannot be split per search. A grader
// model then scores every kept result 0-2, blind to the tier: both tiers' results for a query are pooled, shuffled
// and graded together. Council lines from the PM2 logs give each tier's checker agreement.
// Run: node --env-file-if-exists=.env --import tsx scripts/compare-tiers.ts   (nothing else should search meanwhile)
import { execSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3000', KEY = process.env.OPENROUTER_API_KEY!, GRADER = 'anthropic/claude-sonnet-5';
const QUERIES: {q: string; kind: 'web'|'docs'|'videos'}[] = [
 {q: 'Gen X Soft Club aesthetic', kind: 'web'}, {q: 'free websites to remove video background', kind: 'web'},
 {q: 'rtx 5090 teardown', kind: 'web'}, {q: 'y2k visual design style catalogue', kind: 'docs'},
 {q: 'IPCC AR6 synthesis report 2023', kind: 'docs'}, {q: 'python asyncio tutorial', kind: 'docs'},
 {q: 'underrated osint tools', kind: 'videos'}, {q: 'ghost story short film', kind: 'videos'}];
const LOGS = ['zenatlas-api-out.log', 'zenatlas-worker-out.log'].map(f => join(homedir(), '.pm2', 'logs', f));
type Kept = {url: string; title: string; snippet: string|null};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const offsets = () => LOGS.map(f => statSync(f).size);
function costSince(start: number[], tier: string) {
 const lines = LOGS.flatMap((f, i) => readFileSync(f).subarray(start[i]).toString().split('\n'))
   .flatMap(l => { try { const j = JSON.parse(l); return j.event === 'model_cost' && j.tier === tier ? [j] : []; } catch { return []; } });
 const byRole: Record<string, number> = {};
 for (const l of lines) { const role = String(l.bucket).replace(/:.*$/, ''); byRole[role] = (byRole[role] ?? 0) + (l.cost ?? 0); }
 return {cost: lines.reduce((n, l) => n + (l.cost ?? 0), 0), calls: lines.length, byRole};
}
let cookie = '';
async function get(path: string) {
 const r = await fetch(BASE + path, {headers: cookie ? {cookie} : {}});
 const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
 return r.json();
}
const pendingAudits = () => Number(psql(`SELECT count(*) FROM jobs WHERE kind='audit' AND status IN ('queued','running')`));

async function webOrDocs(q: string, kind: 'web'|'docs', tier: string): Promise<Kept[]> {
 const body = await get(`/api/web?${new URLSearchParams({q, kind, tier})}`);
 const pick = (list: any[]) => list.map(r => ({url: r.url, title: r.title, snippet: r.snippet ?? null}));
 if (body.review) for (let i = 0; i < 120; i++) { const s = await get(`/api/web/review?token=${body.review}`);
   if (s.status === 'complete') return pick(s.results ?? []); await sleep(2000); }
 if (body.hunt) for (let i = 0; i < 120; i++) { const s = await get(`/api/docs/hunt?token=${body.hunt}`);
   if (s.status === 'complete') return pick(s.documents.filter((d: any) => d.state === 'kept')); await sleep(2000); }
 return pick(body.results);
}
async function videos(q: string, tier: string): Promise<Kept[]> {
 let s = await get(`/api/search?${new URLSearchParams({q, tier, mode: 'refresh', limit: '20'})}`);
 for (let i = 0; i < 200 && s.status === 'discovering'; i++) { await sleep(3000); s = await get(`/api/search/${s.search_id}`); }
 // The critic audits the finished search in the background; its cost belongs to this search.
 for (let i = 0; i < 60 && pendingAudits() > 0; i++) await sleep(3000);
 return (s.results ?? []).map((r: any) => ({url: r.url, title: r.title, snippet: r.description ?? null}));
}
async function grade(q: string, items: Kept[]): Promise<number[]> {
 if (!items.length) return [];
 const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {method: 'POST', headers: {Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json'},
   body: JSON.stringify({model: GRADER, temperature: 0, max_tokens: 6000, response_format: {type: 'json_object'}, messages: [
     {role: 'system', content: 'Grade each search result for the request: 2 = clearly what was asked for, 1 = related but partial, 0 = off-topic or wrong. Judge only from its title, address and snippet. Answer JSON {"grades":[one number per result, in order]}.'},
     {role: 'user', content: JSON.stringify({request: q, results: items.map((x, i) => ({i, title: x.title, url: x.url, snippet: x.snippet?.slice(0, 300) ?? null}))})}]})});
 const text = (await r.json()).choices?.[0]?.message?.content ?? '{}';
 const g = (JSON.parse(text.replace(/^```(?:json)?|```$/g, '')).grades ?? []) as number[];
 return items.map((_, i) => Number(g[i] ?? 0));
}

// A spent judge budget makes the judge fall back to direct Gemini for both tiers (no cost lines, not either tier's
// models), which is what invalidated the first run: refuse to start without room for the whole comparison.
const psql = (sql: string) => execSync(`docker exec creator-search-db-1 psql -U postgres -d creator_search -At -c "${sql}"`).toString().trim();
const judgeUsed = Number(psql(`SELECT coalesce(max(used),0) FROM budgets WHERE bucket='judge_calls' AND window_start=date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`));
if (judgeUsed > Number(process.env.JUDGE_DAILY_BUDGET ?? 1000) - 300) throw new Error(`judge_calls budget nearly spent today (${judgeUsed} used)`);
const logStart = LOGS.map(f => statSync(f).size);
const rows: any[] = [];
for (const {q, kind} of QUERIES) for (const tier of ['ssj3', 'ssj1']) {
 const start = offsets(), started = Date.now();
 const kept = kind === 'videos' ? await videos(q, tier) : await webOrDocs(q, kind, tier);
 const ms = Date.now() - started; await sleep(3000); const {cost, calls, byRole} = costSince(start, tier);
 rows.push({q, kind, tier, kept: kept.length, ms, cost_usd: Number(cost.toFixed(6)), calls, by_role: byRole, items: kept.slice(0, 15)});
 // Web and Docs reviews always call the judge; none logged means it fell back, so this row does not measure the tier.
 if (kind !== 'videos' && kept.length && !byRole.judge_calls) console.log(`  WARNING: no judge cost logged for this search (judge fallback?)`);
 console.log(`${tier} ${kind.padEnd(6)} "${q}": ${kept.length} kept, ${(ms / 1000).toFixed(1)} s, $${cost.toFixed(4)} (${calls} calls ${JSON.stringify(byRole)})`);
}
for (const {q} of QUERIES) {
 const mine = rows.filter(r => r.q === q);
 const pool = [...new Map(mine.flatMap(r => r.items).map((x: Kept) => [x.url, x])).values()].sort(() => Math.random() - 0.5) as Kept[];
 const scores = await grade(q, pool), byUrl = new Map(pool.map((x, i) => [x.url, scores[i]]));
 for (const r of mine) r.grades = r.items.map((x: Kept) => byUrl.get(x.url) ?? 0);
}
const council = LOGS.flatMap((f, i) => readFileSync(f).subarray(logStart[i]).toString().split('\n'))
 .flatMap(l => { try { const j = JSON.parse(l); return j.event === 'council' ? [j] : []; } catch { return []; } });
const file = `output/tier-comparison-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify({grader: GRADER, rows, council}, null, 1));
console.log('wrote', file, `(${council.length} council lines)`);
