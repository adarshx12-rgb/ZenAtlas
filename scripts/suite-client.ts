// Searches the running app the way the site does, one tab at a time, and waits for each tab's review to finish.
// Shared by the probe suites (scripts/ssj3-suite.ts, scripts/field-eval.ts).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Tab = 'videos'|'docs'|'web'|'images';
const BASE = 'http://127.0.0.1:3000';
export const LOGS = ['zenatlas-api-out.log', 'zenatlas-worker-out.log'].map(f => join(homedir(), '.pm2', 'logs', f));
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const logOffsets = () => LOGS.map(f => statSync(f).size);
export const linesSince = (start: number[]) => LOGS.flatMap((f, i) => readFileSync(f).subarray(start[i]).toString().split('\n'))
 .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
let cookie = '';
async function get(path: string) {
 const r = await fetch(BASE + path, {headers: cookie ? {cookie} : {}});
 const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
 return r.json();
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function videos(q: string, tier: string) {
 let s = await get(`/api/search?${new URLSearchParams({q, tier, mode: 'refresh', limit: '10'})}`);
 for (let i = 0; i < 200 && s.status === 'discovering'; i++) { await sleep(3000); s = await get(`/api/search/${s.search_id}`); }
 return {status: s.status, providers: s.providers, results: (s.results ?? []).slice(0, 10).map((r: any) => ({title: r.title, url: r.canonical_url, creator: r.creator,
   duration: r.duration, language: r.language, relevance: r.judgement?.relevance ?? null, reason: r.judgement?.reason ?? null,
   moments: (r.moments ?? []).slice(0, 3).map((m: any) => `${clock(m.focus?.[0] ?? m.start_seconds)} ${m.evidence_type}: ${String(m.summary).slice(0, 120)}`),
   requirements: (r.requirements ?? []).map((x: any) => `${x.text}: ${x.status}`)}))};
}
export async function webOrDocs(q: string, kind: 'web'|'docs', tier: string) {
 const body = await get(`/api/web?${new URLSearchParams({q, kind, tier})}`);
 const pick = (list: any[]) => list.slice(0, 10).map(r => ({title: r.title, url: r.url, snippet: r.snippet?.slice(0, 200) ?? null,
   published: r.published ?? null, relevance: r.judgement?.relevance ?? null, reason: r.judgement?.reason ?? null, lead: r.lead ?? false}));
 if (body.review) for (let i = 0; i < 120; i++) { const s = await get(`/api/web/review?token=${body.review}`);
   if (s.status === 'complete') return {rewrite: body.rewrite ?? null, providers: s.providers, results: pick(s.results ?? [])}; await sleep(2000); }
 if (body.hunt) for (let i = 0; i < 120; i++) { const s = await get(`/api/docs/hunt?token=${body.hunt}`);
   if (s.status === 'complete') return {rewrite: body.rewrite ?? null, providers: s.providers, results: pick(s.documents.filter((d: any) => d.state === 'kept'))}; await sleep(2000); }
 return {rewrite: body.rewrite ?? null, providers: body.providers, results: pick(body.results ?? [])};
}
export async function images(q: string, tier: string) {
 let body = await get(`/api/images?${new URLSearchParams({q, limit: '24', tier})}`);
 if (body.review) for (let i = 0; i < 60; i++) { const s = await get(`/api/images/review?token=${body.review}`);
   if (s.status === 'complete') { body = {...body, ...s}; break; } await sleep(2000); }
 return {providers: body.providers, removed: body.removed ?? null, results: (body.results ?? []).slice(0, 12).map((r: any) => ({title: r.title, page_url: r.page_url,
   image_url: r.thumbnail || r.image_url || null, source: r.source_name, engine: r.engine, license: r.license?.name ?? null, ai: !!r.ai_generated,
   relevance: r.judgement?.relevance ?? null, unseen: !!r.unseen, reason: r.judgement?.reason ?? null}))};
}
export const search = (tab: Tab, q: string, tier: string) =>
 tab === 'videos' ? videos(q, tier) : tab === 'images' ? images(q, tier) : webOrDocs(q, tab, tier);

// The model calls a search made, from the model_cost lines logged between its start and end.
export function costOf(lines: any[]) {
 const costs = lines.filter(l => l.event === 'model_cost'), byRole: Record<string, number> = {};
 for (const l of costs) { const role = String(l.bucket).replace(/:.*$/, ''); byRole[role] = +((byRole[role] ?? 0) + (l.cost ?? 0)).toFixed(5); }
 return {cost_usd: +costs.reduce((n, l) => n + (l.cost ?? 0), 0).toFixed(5), by_role: byRole};
}
