import { contentInput, type ProviderStatus } from './types.js';
import type { PageEvidence } from './pages.js';
import type { Judge, JudgeCandidate, JudgeResult, Verdict } from './judge.js';
import { screeningOrder, type Screener } from './screener.js';
import { accessKind } from './access.js';
import { councilReview, type CouncilSeats } from './council.js';
import { cascadeReview, type CascadeOptions } from './cascade.js';
import { rankBoost, sourceKind, contentHash, groupCopies } from './canonical.js';
import { inspect, factsFromFindings } from './evidence.js';
import { hardEach, type RequirementsContract } from './requirements.js';
import { judgeRequirements } from './search-contract.js';
import { missingRequirements } from './cascade.js';

// The relevance review shared by the Docs and Web tabs: the screener orders long lists, the caller reads the text of the
// first textPool items, then the judge (Jev in front of the LLM judge) scores up to reviewPool items. Items at relevance 4
// or below, or with an intent mismatch, are removed; the rest are ordered by relevance.
export interface Reviewable { url: string; title: string; source_name: string; snippet: string|null; published: string|null; engine: string; doc_type: string|null }
export type Judgement = {relevance: number; reason: string};
// noun: what the items are called in messages. keepUnjudged: an item the judge returned no verdict for stays, unranked,
// after the ranked ones (web: a failed LLM batch is not a rejection); otherwise it is removed (Docs: nothing unvouched is shown).
export interface ReviewPlan<T extends Reviewable> { noun: string; criteria: string[]; requirement: {text: string; evidence: string};
 contract?: RequirementsContract;
 textPool: number; reviewPool: number; read: (items: T[]) => Promise<Map<string, PageEvidence>>; judge: Judge; screener?: Screener; keepUnjudged: boolean;
 // The judge council's Checker and Chair (src/council.ts), re-checking the top councilTop verdicts; absent or null: one judge.
 // councilGap: score gap that counts as a dispute; councilSure: scores that skip the Checker (src/council.ts).
 council?: CouncilSeats|null; councilTop?: number; councilGap?: number; councilSure?: number;
 // The judge cascade's Strong judge and settings (src/cascade.ts), used in place of the council when given.
 strong?: Judge|null; cascade?: CascadeOptions; log?: (line: Record<string, unknown>) => void }
// trace: per judged item, the judge's relevance and Jev's record, for metrics.
// lead: the item's own text could not be read, so it was judged on its title and snippet only: a lead, not a verified match.
export interface ReviewOutcome<T> { results: (T & {judgement?: Judgement; lead?: true; verification?: 'verified'|'uncertain'; unmet_requirements?: string[]; alternatives?: {url: string; title: string}[]; content_hash?: string})[]; removed: number; providers: ProviderStatus[];
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
     pool = screeningOrder(leads, (await plan.screener.screen(query, leads, plan.contract ? {requirements: hardEach(plan.contract), formats: plan.contract.deliverable.formats,
       search_date: plan.contract.search_date} : undefined)).promising).map(l => l.doc);
   } catch { providers.push({provider: 'jev_screener', status: 'unavailable', message: `${capital(plan.noun)} were reviewed in search order.`}); }
 }
 // Canonical copies first, so the original is among the items read (and reviewed) rather than judged on its title.
 const kindOf = new Map(pool.map(d => [d.url, sourceKind(d.url, query)]));
 pool = [...pool.filter(d => kindOf.get(d.url) === 'canonical'), ...pool.filter(d => kindOf.get(d.url) !== 'canonical')];
 const judged = pool.slice(0, plan.reviewPool), unreviewed = pool.length - judged.length;
 const inspected = await plan.read(judged.slice(0, plan.textPool));
 const keys = new Map(judged.map((d, i) => [`d${i + 1}`, d]));
 const candidateFor = (key: string, d: T): JudgeCandidate => {
   const page = inspected.get(d.url);
   return {key, kind: 'website', site: d.source_name, url: d.url, title: d.title, channel: null, official: false, duration: null, live: null,
     description: d.snippet, comments: [], moments: [], discussions: [], description_source: 'search',
     inspected: {format: d.doc_type, published: page?.meta?.published ?? d.published?.slice(0, 10) ?? null, publisher: null, access: accessKind(d.url)},
     ...(plan.contract ? {facts: factsFromFindings(inspect(plan.contract, {url: d.url, title: d.title, description: d.snippet, published_at: d.published, page}))} : {}),
     ...(page ? {page: {status: page.status, title: page.title, description: page.description, text: page.text, libraries: []}} : {})};
 };
 const candidates = [...keys].map(([key, d]) => candidateFor(key, d));
 const context = {kind: 'websites' as const, criteria: plan.criteria, requirements: plan.contract ? judgeRequirements(plan.contract) : [{id: 'R1', ...plan.requirement}],
   search_date: plan.contract?.search_date};
 let out: JudgeResult;
 try { out = await plan.judge.judge(query, candidates, context); }
 catch {
   providers.push({provider: 'judge', status: 'unavailable', message: `Relevance checking is unavailable right now; ${plan.noun} are shown in search order.`});
   return {results: items, removed: 0, providers, trace: []};
 }
 if (plan.strong && plan.cascade) {
   const reviewed = await cascadeReview(query, candidates, out.verdicts, out.jev, context, undefined, plan.strong, {...plan.cascade, log: plan.log ?? plan.cascade.log,
     inspection: {judge: plan.judge, inspect: async (c, _missing, signal) => {
       if (c.page?.text) return null;
       const item = keys.get(c.key)!;
       const more = await plan.read([item]);
       const page = more.get(item.url);
       if (!page?.text || signal.aborted) return null;
       inspected.set(item.url, page);
       return candidateFor(c.key, item);
     }}});
   out = {...out, verdicts: reviewed.verdicts, jev: reviewed.jev};
   for (const c of reviewed.candidates) Object.assign(candidates.find(x => x.key === c.key)!, c);
   providers.push(...reviewed.providers);
 } else if (plan.council) {
   const reviewed = await councilReview(query, candidates, out.verdicts, context, undefined, plan.council, {top: plan.councilTop ?? 15, disagreement: plan.councilGap, sureScore: plan.councilSure, log: plan.log});
   out = {...out, verdicts: reviewed.verdicts};
   providers.push(...reviewed.providers);
 }
 const scored = [...keys].map(([key, d], i) => ({d, i, v: out.verdicts.get(key) as Verdict|undefined, jev: out.jev?.get(key)}));
 const kept = scored.filter(s => s.v && s.v.relevance > TANGENTIAL && !s.v.intentChecks?.some(c => c.status === 'mismatch'))
   .sort((a, b) => b.v!.relevance + rankBoost(kindOf.get(b.d.url) ?? null) - a.v!.relevance - rankBoost(kindOf.get(a.d.url) ?? null) || a.i - b.i);
 const unjudged = plan.keepUnjudged ? scored.filter(s => !s.v) : [];
 const removed = judged.length - kept.length - unjudged.length;
 providers.push({provider: 'judge', status: 'ok', message: `${judged.length} ${plan.noun} were checked for relevance; ${removed} did not match`
   + `${unreviewed ? `; ${unreviewed} more were not reviewed and are not shown` : ''}`
   + `${unjudged.length ? `; ${unjudged.length} could not be checked and are shown unranked` : ''}.`});
 const lead = (d: T) => inspected.has(d.url) ? {} : {lead: true as const};
 const results = [...kept.map(s => {
   const missing = plan.contract ? missingRequirements(candidates.find(c => c.key === s.v!.key)!, s.v!, context.requirements) : [];
   return {...s.d, judgement: {relevance: s.v!.relevance, reason: s.v!.reason}, ...lead(s.d),
     content_hash: contentHash(inspected.get(s.d.url)?.text),
     ...(plan.contract ? {verification: missing.length || s.v!.relevance <= 5 ? 'uncertain' as const : 'verified' as const,
       unmet_requirements: context.requirements.filter(r => missing.includes(r.id)).map(r => r.text)} : {})};
 }), ...unjudged.map(s => ({...s.d, ...lead(s.d), verification: 'uncertain' as const}))];
 return {results: groupCopies(results, query).sort((a, b) => Number(b.verification === 'verified') - Number(a.verification === 'verified')),
   removed: removed + unreviewed, providers,
   trace: scored.map(s => ({url: s.d.url, relevance: s.v?.relevance ?? null, ...(s.jev ? {jev: s.jev} : {})}))};
}
