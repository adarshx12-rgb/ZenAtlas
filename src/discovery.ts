import type { DB } from './db.js';
import type { Config } from './config.js';
import type { DiscoveryPage, EngineFailure, ProviderStatus, Result, SearchInput, SourceAdapter } from './types.js';
import { configuredProviders, engineStatus, SearXNG } from './providers.js';
import { takeBudget } from './budgets.js';
import { canonicalize } from './urls.js';
import { rankDiscovery, type DiscoveryCandidate } from './ranking.js';
import { ingest } from './catalogue.js';
import { UpstreamError } from './http.js';
import { applySignals, type SignalDeps } from './signals.js';
import { GeminiPlanner, fallbackPlan, type Planner, type SearchPlan, type SearchTarget } from './planner.js';
import { queryKey } from './search.js';

export interface DiscoveryDeps extends SignalDeps { planner?: Planner }
export interface DiscoveryProgress { results: Result[]; providers: ProviderStatus[]; stage: 'searching'|'checking' }
type Health = (provider: string, ok: boolean) => Promise<void>;
type Progress = (update: DiscoveryProgress) => Promise<void>;
type Outcome = {provider: SourceAdapter; page: DiscoveryPage|null; failure?: 'budget_exhausted'|'unavailable'};
type Lead = DiscoveryCandidate & {target: SearchTarget};
// Leads shown as soon as they arrive must match at least half of the query that found them.
const CLEAR_MATCH = 0.5;

function summarise(name: string, outcomes: Outcome[]): ProviderStatus {
 const pages = outcomes.flatMap(o => o.page ? [o.page] : []);
 if (!pages.length) return outcomes[0].failure === 'budget_exhausted'
   ? {provider: name, status: 'budget_exhausted', message: 'The daily discovery budget has been reached.'}
   : {provider: name, status: 'unavailable', message: 'External discovery is unavailable. Catalogue results are still available.'};
 if (pages.length < outcomes.length) return {provider: name, status: 'partial', message: 'Some discovery searches did not respond.'};
 if (pages.every(p => p.engines)) {
   // An engine is working when it answered any of the searches it was given.
   const asked = [...new Set(pages.flatMap(p => p.engines!.asked))];
   const answered = new Set(pages.flatMap(p => p.engines!.asked.filter(e => !p.engines!.failed.some(f => f.engine === e))));
   const failed = new Map<string,EngineFailure>();
   for (const p of pages) for (const f of p.engines!.failed) if (!answered.has(f.engine)) failed.set(f.engine, f);
   return engineStatus(name, asked, [...failed.values()]);
 }
 if (pages.every(p => p.status.status === pages[0].status.status)) return pages[0].status;
 return {provider: name, status: 'partial', message: 'Some discovery searches or engines did not respond.'};
}

async function planFor(db: DB, config: Config, input: SearchInput, deps: DiscoveryDeps): Promise<{plan: SearchPlan; status: ProviderStatus|null}> {
 // A search scoped to one source (replacement-domain discovery) runs exactly as asked.
 if (input.source) return {plan: {kind: 'videos', searches: [{query: input.q, target: 'videos'}], criteria: [], model: null}, status: null};
 const planner = input.depth === 'deep' ? deps.planner ?? (config.GEMINI_API_KEY ? new GeminiPlanner(db, config) : undefined) : undefined;
 if (!planner) return {plan: fallbackPlan(input.q), status: null};
 try {
   const plan = await planner.plan(input.q);
   return {plan, status: {provider: 'planner', status: 'ok', message: `AI planned ${plan.searches.length} searches for ${plan.kind}.`}};
 } catch (error) {
   return {plan: fallbackPlan(input.q), status: error instanceof UpstreamError && error.code === 'budget_exhausted'
     ? {provider: 'planner', status: 'budget_exhausted', message: 'The daily AI planning limit has been reached; the query was searched as typed.'}
     : {provider: 'planner', status: 'unavailable', message: 'AI search planning is unavailable right now; the query was searched as typed.'}};
 }
}

// Runs every planned query on every provider in parallel and stores and reports the best leads of each answer as it
// arrives. A deep search then checks and judges what it found. Returns the final order, every stored record, and the
// addresses a deep search's judge rejected after they had been shown.
export async function runDiscovery(db: DB, config: Config, input: SearchInput, adapters: SourceAdapter[]|undefined,
 deps: DiscoveryDeps, health: Health, progress: Progress = async () => {}): Promise<{results: Result[]; ingested: Result[]; dropped: string[];
 providers: ProviderStatus[]; previews: Map<string,Buffer>}> {
 const providers = (adapters ?? configuredProviders(config)).slice(0, 3);
 const {plan, status: planStatus} = await planFor(db, config, input, deps);
 const planned = plan.searches.flatMap((search, index) => providers.map(provider =>
   ({search, index, provider, adapter: provider instanceof SearXNG ? provider.forTarget(search.target) : provider})));
 const answers = planned.reduce((n, p) => n + (p.adapter instanceof SearXNG ? p.adapter.engines.length : 1), 0);
 const limit = config.DISCOVERY_RESULTS;
 // Each answer adds only its best few leads, so the engines that answer first cannot take every slot.
 const quota = Math.max(2, Math.floor(limit / Math.max(1, answers)));
 const leads: Lead[] = [];
 // A deep search also checks and ranks what the quick search for the same query already showed.
 const earlier = input.depth === 'deep' && !input.source ? await quickFinds(db, input) : [];
 const found: Result[] = [];
 const shown = () => [...earlier, ...found];
 const tried = new Set(earlier.map(r => r.canonical_url));
 const leadUrl = new Map<string,string>();
 const notes = planStatus ? [planStatus] : [];

 const store = async (picks: Lead[]) => {
   let added = 0;
   for (const lead of picks) {
     if (found.length >= limit) break;
     if (tried.has(lead.item.url)) continue;
     tried.add(lead.item.url);
     const result = await ingest(db, lead.item, {adapter: lead.provider, method: 'search', discovered_at: new Date().toISOString()});
     if (!result) continue;
     found.push(result); leadUrl.set(result.id, lead.item.url); added++;
   }
   return added;
 };
 // Answers are handled one at a time, in arrival order; a failure is raised once every search has returned.
 let arrivals = Promise.resolve();
 let failure: unknown = null;
 const arrived = (page: DiscoveryPage, query: string, index: number, target: SearchTarget, provider: string) => {
   const batch: Lead[] = page.results.map((item, position) => ({item: {...item, url: canonicalize(item.url)}, provider, position, query, searchIndex: index, target}));
   arrivals = arrivals.then(async () => {
     leads.push(...batch);
     const urls = new Set(batch.map(l => l.item.url));
     const picks = rankDiscovery(input.q, leads, leads.length, CLEAR_MATCH).filter(l => urls.has(l.item.url) && !tried.has(l.item.url)).slice(0, quota);
     if (await store(picks)) await progress({results: shown(), providers: notes, stage: 'searching'});
   }).catch(error => { failure ??= error; });
 };

 const outcomes = await Promise.all(planned.map(async ({search, index, provider, adapter}): Promise<Outcome> => {
   const budget = provider.name === 'searxng' ? config.SEARXNG_DAILY_BUDGET : config.DISCOVERY_DAILY_BUDGET;
   if (!await takeBudget(db, `discovery:${provider.name}`, budget)) return {provider, page: null, failure: 'budget_exhausted'};
   const filters = {...input, q: search.query};
   try {
     let page: DiscoveryPage;
     if (adapter instanceof SearXNG) {
       page = await adapter.search(search.query, filters, undefined, answer =>
         arrived(answer, search.query, index, search.target, `${provider.name}:${answer.engines?.asked[0] ?? ''}`));
     } else {
       page = await adapter.search(search.query, filters);
       arrived(page, search.query, index, search.target, provider.name);
     }
     await health(provider.name, page.status.status === 'ok');
     for (const engine of page.engines?.asked ?? []) await health(`${provider.name}:${engine}`, !page.engines!.failed.some(f => f.engine === engine));
     return {provider, page};
   } catch {
     await health(provider.name, false);
     return {provider, page: null, failure: 'unavailable'};
   }
 }));
 await arrivals;
 if (failure) throw failure;
 // Fill any slots the per-answer limit left open with the best remaining clear matches, or, when no lead matches
 // clearly, with the provider's own best guesses.
 const clear = rankDiscovery(input.q, leads, limit, CLEAR_MATCH);
 await store(clear.length ? clear : rankDiscovery(input.q, leads, limit));
 const statuses = [...providers.map(p => summarise(p.name, outcomes.filter(o => o.provider === p))), ...notes];
 if (input.depth !== 'deep' || input.source) return {results: found, ingested: found, dropped: [], providers: statuses, previews: new Map()};

 // New finds go first, so they get the limited YouTube comment checks; the judge sees every result.
 const pool = [...found, ...earlier];
 await progress({results: pool, providers: notes, stage: 'checking'});
 const webUrls = new Set(leads.filter(l => l.target === 'web').map(l => l.item.url));
 const targets = new Map(pool.map(r => [r.id, webUrls.has(leadUrl.get(r.id) ?? r.canonical_url) ? 'web' as const : 'videos' as const]));
 const signals = await applySignals(db, {...config, JUDGE_CANDIDATES: Math.max(config.JUDGE_CANDIDATES, pool.length)}, input.q, pool, deps,
   {kind: plan.kind, criteria: plan.criteria, targets});
 const kept = new Set(signals.results.map(r => r.id));
 return {results: signals.results, ingested: found, previews: signals.previews,
   dropped: pool.filter(r => !kept.has(r.id)).map(r => r.canonical_url), providers: [...statuses, ...signals.providers]};
}

async function quickFinds(db: DB, input: SearchInput): Promise<Result[]> {
 const row = (await db.query(`SELECT result FROM jobs WHERE dedupe_key=$1 AND status='complete'`,
   [`discovery:${queryKey({...input, depth: 'quick'})}`])).rows[0];
 return row?.result?.results ?? [];
}
