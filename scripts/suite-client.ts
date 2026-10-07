// Searches the running app the way the site does, one tab at a time, and waits for each tab's review to finish.
// Shared by the probe suites (scripts/ssj3-suite.ts, scripts/field-eval.ts).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeCosts } from '../src/evaluation.js';

export type Tab = 'videos'|'docs'|'web'|'images';
const BASE = 'http://127.0.0.1:3000';
export const LOGS = ['zenatlas-api-out.log', 'zenatlas-worker-out.log'].map(f => join(homedir(), '.pm2', 'logs', f));
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const logOffsets = () => LOGS.map(f => {try{return statSync(f).size;}catch{return 0;}});
export const linesSince = (start: number[]) => LOGS.flatMap((f, i) => {try{const data=readFileSync(f);return data.subarray(data.length<start[i]?0:start[i]).toString().split('\n');}catch{return [];}})
 .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
let cookie = '';
async function get(path: string) {
 const r = await fetch(BASE + path, {headers: cookie ? {cookie} : {},signal:AbortSignal.timeout(30000)});
 const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
 if(!r.ok)throw new Error(`HTTP ${r.status} ${path.split('?')[0]}`);
 return r.json();
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function videos(q: string, tier: string) {
 let s = await get(`/api/search?${new URLSearchParams({q, tier, mode: 'refresh', limit: '10'})}`);
 for (let i = 0; i < 200 && s.status === 'discovering'; i++) { await sleep(3000); s = await get(`/api/search/${s.search_id}`); }
 if(s.status==='discovering')throw new Error('evaluation_timeout');
 return {trace_id:s.trace_id,runtime:s.runtime,status: s.status, providers: s.providers, results: (s.results ?? []).slice(0, 10).map((r: any) => ({title: r.title, url: r.canonical_url, creator: r.creator,
   duration: r.duration, language: r.language, relevance: r.judgement?.relevance ?? null, reason: r.judgement?.reason ?? null,
   moments: (r.moments ?? []).slice(0, 3).map((m: any) => `${clock(m.focus?.[0] ?? m.start_seconds)} ${m.evidence_type}: ${String(m.summary).slice(0, 120)}`),
   requirements: (r.requirements ?? []).map((x: any) => `${x.text}: ${x.status}`)}))};
}
export async function webOrDocs(q: string, kind: 'web'|'docs', tier: string) {
 const body = await get(`/api/web?${new URLSearchParams({q, kind, tier})}`);
 const pick = (list: any[]) => list.slice(0, 10).map(r => ({title: r.title, url: r.url, snippet: r.snippet?.slice(0, 200) ?? null,
   published: r.published ?? null, relevance: r.judgement?.relevance ?? null, reason: r.judgement?.reason ?? null, lead: r.lead ?? false}));
 if (body.review) for (let i = 0; i < 120; i++) { const s = await get(`/api/web/review?token=${body.review}`);
   if (s.status === 'complete') return {trace_id:body.trace_id,runtime:body.runtime,rewrite: body.rewrite ?? null, providers: s.providers, results: pick(s.results ?? [])}; await sleep(2000); }
 if (body.hunt) for (let i = 0; i < 120; i++) { const s = await get(`/api/docs/hunt?token=${body.hunt}`);
   if (s.status === 'complete') return {trace_id:body.trace_id,runtime:body.runtime,rewrite: body.rewrite ?? null, providers: s.providers, results: pick(s.documents.filter((d: any) => d.state === 'kept'))}; await sleep(2000); }
 if(body.review||body.hunt)throw new Error('evaluation_timeout');
 return {trace_id:body.trace_id,runtime:body.runtime,rewrite: body.rewrite ?? null, providers: body.providers, results: pick(body.results ?? [])};
}
export async function images(q: string, tier: string) {
 let body = await get(`/api/images?${new URLSearchParams({q, limit: '24', tier})}`);
 let complete=!body.review;
 if (body.review) for (let i = 0; i < 60; i++) { const s = await get(`/api/images/review?token=${body.review}`);
   if (s.status === 'complete') { body = {...body, ...s}; complete=true;break; } await sleep(2000); }
 if(!complete)throw new Error('evaluation_timeout');
 return {trace_id:body.trace_id,runtime:body.runtime,providers: body.providers, removed: body.removed ?? null, results: (body.results ?? []).slice(0, 12).map((r: any) => ({title: r.title, page_url: r.page_url,
   image_url: r.thumbnail || r.image_url || null, source: r.source_name, engine: r.engine, license: r.license?.name ?? null, ai: !!r.ai_generated,
   relevance: r.judgement?.relevance ?? null, unseen: !!r.unseen, reason: r.judgement?.reason ?? null}))};
}
export const search = (tab: Tab, q: string, tier: string) =>
 tab === 'videos' ? videos(q, tier) : tab === 'images' ? images(q, tier) : webOrDocs(q, tab, tier);

// The model calls a search made, from the model_cost lines logged between its start and end.
export const costOf = summarizeCosts;
