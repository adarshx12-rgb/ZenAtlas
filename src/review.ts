import { contentInput, type ProviderStatus } from './types.js';
import type { PageEvidence } from './pages.js';
import type { Judge, JudgeCandidate, JudgeResult, Verdict } from './judge.js';
import { screeningOrder, type Screener } from './screener.js';
import { accessKind } from './access.js';

// The relevance review shared by the Docs and Web tabs: the screener orders long lists, the caller reads the text of the
// first textPool items, then the judge (Jev in front of the LLM judge) scores up to reviewPool items. Items at relevance 4
// or below, or with an intent mismatch, are removed; the rest are ordered by relevance.
export interface Reviewable { url: string; title: string; source_name: string; snippet: string|null; published: string|null; engine: string; doc_type: string|null }
export type Judgement = {relevance: number; reason: string};
// noun: what the items are called in messages. keepUnjudged: an item the judge returned no verdict for stays, unranked,
// after the ranked ones (web: a failed LLM batch is not a rejection); otherwise it is removed (Docs: nothing unvouched is shown).
export interface ReviewPlan<T extends Reviewable> { noun: string; criteria: string[]; requirement: {text: string; evidence: string};
 textPool: number; reviewPool: number; read: (items: T[]) => Promise<Map<string, PageEvidence>>; judge: Judge; screener?: Screener; keepUnjudged: boolean }
// trace: per judged item, the judge's relevance and Jev's record, for metrics.
// lead: the item's own text could not be read, so it was judged on its title and snippet only: a lead, not a verified match.
export interface ReviewOutcome<T> { results: (T & {judgement?: Judgement; lead?: true})[]; removed: number; providers: ProviderStatus[];
 trace: {url: string; relevance: number|null; jev?: unknown}[] }
// 4 is "only tangential"; a plausible 5 stays: short queries are often ambiguous and an unconfirmed detail is not a miss.
const TANGENTIAL = 4;
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

export async function reviewResults<T extends Reviewable>(query: string, items: T[], plan: ReviewPlan<T>): Promise<ReviewOutcome<T>> {
 const providers: ProviderStatus[] = [];
 let pool = items;
 if (plan.screener && items.length > plan.textPool) {
   try {
     const leads = items.map((d, i) => ({item: contentInput.parse({url: d.url, title: d.title, description: d.snippet, published_at: d.published}),
       provider: d.engine, position: i, doc: d}));
     pool = screeningOrder(leads, (await plan.screener.screen(query, leads)).promising).map(l => l.doc);
   } catch { providers.push({provider: 'jev_screener', status: 'unavailable', message: `${capital(plan.noun)} were reviewed in search order.`}); }
 }
 const judged = pool.slice(0, plan.reviewPool), unreviewed = pool.length - judged.length;
 const inspected = await plan.read(judged.slice(0, plan.textPool));
 const keys = new Map(judged.map((d, i) => [`d${i + 1}`, d]));
 const candidates: JudgeCandidate[] = [...keys].map(([key, d]) => {
   const page = inspected.get(d.url);
   return {key, kind: 'website', site: d.source_name, url: d.url, title: d.title, channel: null, official: false, duration: null, live: null,
     description: d.snippet, comments: [], moments: [], discussions: [], description_source: 'search',
     inspected: {format: d.doc_type, published: page?.meta?.published ?? d.published?.slice(0, 10) ?? null, publisher: null, access: accessKind(d.url)},
     ...(page ? {page: {status: page.status, title: page.title, description: page.description, text: page.text, libraries: []}} : {})};
 });
 const context = {kind: 'websites' as const, criteria: plan.criteria, requirements: [{id: 'R1', ...plan.requirement}]};
 let out: JudgeResult;
 try { out = await plan.judge.judge(query, candidates, context); }
 catch {
   providers.push({provider: 'judge', status: 'unavailable', message: `Relevance checking is unavailable right now; ${plan.noun} are shown in search order.`});
   return {results: items, removed: 0, providers, trace: []};
 }
 const scored = [...keys].map(([key, d], i) => ({d, i, v: out.verdicts.get(key) as Verdict|undefined, jev: out.jev?.get(key)}));
 const kept = scored.filter(s => s.v && s.v.relevance > TANGENTIAL && !s.v.intentChecks?.some(c => c.status === 'mismatch'))
   .sort((a, b) => b.v!.relevance - a.v!.relevance || a.i - b.i);
 const unjudged = plan.keepUnjudged ? scored.filter(s => !s.v) : [];
 const removed = judged.length - kept.length - unjudged.length;
 providers.push({provider: 'judge', status: 'ok', message: `${judged.length} ${plan.noun} were checked for relevance; ${removed} did not match`
   + `${unreviewed ? `; ${unreviewed} more were not reviewed and are not shown` : ''}`
   + `${unjudged.length ? `; ${unjudged.length} could not be checked and are shown unranked` : ''}.`});
 const lead = (d: T) => inspected.has(d.url) ? {} : {lead: true as const};
 return {results: [...kept.map(s => ({...s.d, judgement: {relevance: s.v!.relevance, reason: s.v!.reason}, ...lead(s.d)})), ...unjudged.map(s => ({...s.d, ...lead(s.d)}))],
   removed: removed + unreviewed, providers,
   trace: scored.map(s => ({url: s.d.url, relevance: s.v?.relevance ?? null, ...(s.jev ? {jev: s.jev} : {})}))};
}
