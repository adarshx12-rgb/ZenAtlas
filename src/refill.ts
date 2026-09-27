import type { DB } from './db.js';
import type { Config } from './config.js';
import type { Judgement } from './review.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { rankBoost, sourceKind, groupCopies } from './canonical.js';
import { hardEach, type RequirementsContract } from './requirements.js';

// The refill round (docs/superpowers/specs/2026-09-27-candidate-quality-design.md): after the first review, the planner
// looks at what was kept (titles, hosts, scores, reasons; never page text) and says what the request still lacks. Its
// targeted searches bring new candidates, which go through the same review. Jev and the judge only choose among what was
// fetched; on 2026-09-27 Brave's top 40 for a food-safety question held no food-safety authority at all, so new searches
// are what bring better candidates in.

export interface RefillItem { title: string; host: string; relevance: number|null; reason: string|null; missing?: string[] }
export interface RefillDecision { complete: boolean; missing: string; searches: string[] }
export type RefillPlanner = (query: string, kept: RefillItem[], ran: string[], contract?: RequirementsContract) => Promise<RefillDecision>;

const SCHEMA = {type: 'object', properties: {complete: {type: 'boolean'}, missing: {type: 'string'},
 searches: {type: 'array', items: {type: 'string'}}}, required: ['complete', 'missing', 'searches']};
const SYSTEM = `You check whether a list of search results serves a request, and if not, what to search for next.
Look for what the request needs but the list lacks: an authoritative or primary source where the request warrants one (a
health, safety, legal or financial question needs the official agency or regulator; a paper or law needs its original
publisher or issuing body), first-hand accounts when the request asks for experience, the official source of a named
organisation or product, and every constraint the request states. Titles, hosts, scores and reasons are all you see.
If the list already serves the request, answer complete true and no searches. Otherwise name what is missing in a few words
and write at most 2 web searches that would find it, each different from the searches already run; site: operators are
allowed (site:fsis.usda.gov, site:reddit.com). Answer JSON {"complete": boolean, "missing": string, "searches": [string]}.`;

// The planner's answer made safe to act on: a list, at most `max` searches, trimmed, none empty, too long or already run.
export function cleanDecision(raw: unknown, ran: string[], max: number): RefillDecision {
 const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RefillDecision>;
 const done = new Set(ran.map(s => s.trim().toLowerCase()));
 const searches = r.complete === true || !Array.isArray(r.searches) ? [] : [...new Set(r.searches.filter((s): s is string => typeof s === 'string')
   .map(s => s.trim().replace(/\s+/g, ' ')).filter(s => s.length >= 3 && s.length <= 150 && !done.has(s.toLowerCase())))].slice(0, max);
 return {complete: r.complete === true, missing: typeof r.missing === 'string' ? r.missing.trim().slice(0, 120) : '', searches};
}

// The planner models (PLANNER_MODELS), with their own budget and time limit.
export function makeRefillPlanner(db: DB, config: Config): RefillPlanner|undefined {
 const models = config.PLANNER_MODELS.split(',').map(m => m.trim()).filter(Boolean);
 if (!config.REFILL_ENABLED || !config.OPENROUTER_API_KEY || !models.length) return undefined;
 const client = new OpenAICompatibleClient(db, {...config, JUDGE_DAILY_BUDGET: config.REFILL_DAILY_BUDGET, JUDGE_TIMEOUT_MS: config.REFILL_TIMEOUT_MS}, models, undefined, 1024);
 return async (query, kept, ran, contract) => {
   const text = JSON.stringify({request: query, searches_already_run: ran,
     requirements: contract ? hardEach(contract) : undefined, search_date: contract?.search_date,
     results: kept.map(k => ({title: k.title.slice(0, 150), host: k.host, relevance: k.relevance, reason: k.reason?.slice(0, 160) ?? null, missing: k.missing}))});
   return cleanDecision((await client.json('refill_calls', SYSTEM, text, SCHEMA)).value, ran, config.REFILL_MAX_SEARCHES);
 };
}

type Reviewed = {url: string; judgement?: Judgement; verification?: string; content_hash?: string};
// First and refill results together: judged ones by relevance (canonical boost included), then unjudged ones.
export function mergeReviewed<T extends Reviewed>(query: string, first: T[], more: T[]): T[] {
 const all = groupCopies([...first, ...more], query), judged = all.filter(r => r.judgement), unjudged = all.filter(r => !r.judgement);
 const rank = (r: T) => r.judgement!.relevance + rankBoost(sourceKind(r.url, query));
 return [...judged.map((r, i) => ({r, i})).sort((a, b) => Number(b.r.verification === 'verified') - Number(a.r.verification === 'verified') || rank(b.r) - rank(a.r) || a.i - b.i).map(x => x.r), ...unjudged];
}
