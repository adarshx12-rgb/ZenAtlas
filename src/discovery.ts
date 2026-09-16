import type { DB } from './db.js';
import type { Config } from './config.js';
import type { DiscoveryPage, ProviderStatus, Result, SearchInput, SourceAdapter } from './types.js';
import { configuredProviders, SearXNG } from './providers.js';
import { takeBudget } from './budgets.js';
import { canonicalize } from './urls.js';
import { rankDiscovery } from './ranking.js';
import { ingest } from './catalogue.js';
import { UpstreamError } from './http.js';
import { applySignals, type SignalDeps } from './signals.js';
import { GeminiPlanner, fallbackPlan, type Planner, type SearchPlan, type SearchTarget } from './planner.js';

export interface DiscoveryDeps extends SignalDeps { planner?: Planner }
type Health = (provider: string, ok: boolean) => Promise<void>;
type Outcome = {provider: SourceAdapter; search: SearchPlan['searches'][number]; index: number; page: DiscoveryPage|null; failure?: 'budget_exhausted'|'unavailable'};

function summarise(name: string, outcomes: Outcome[]): ProviderStatus {
 const pages = outcomes.flatMap(o => o.page ? [o.page.status] : []);
 if (pages.length === outcomes.length && pages.every(s => s.status === pages[0].status)) return pages[0];
 if (!pages.length) return outcomes[0].failure === 'budget_exhausted'
   ? {provider: name, status: 'budget_exhausted', message: 'The daily discovery budget has been reached.'}
   : {provider: name, status: 'unavailable', message: 'External discovery is unavailable. Catalogue results are still available.'};
 return {provider: name, status: 'partial', message: 'Some discovery searches or engines did not respond.'};
}

async function planFor(db: DB, config: Config, input: SearchInput, deps: DiscoveryDeps): Promise<{plan: SearchPlan; status: ProviderStatus|null}> {
 // A search scoped to one source (replacement-domain discovery) runs exactly as asked.
 if (input.source) return {plan: {kind: 'videos', searches: [{query: input.q, target: 'videos'}], criteria: [], model: null}, status: null};
 const planner = deps.planner ?? (config.GEMINI_API_KEY ? new GeminiPlanner(db, config) : undefined);
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

// Plans the search, runs every planned query on every provider in parallel, shortlists the leads, stores them,
// then checks and judges the shortlist. Returns the ranked results and the newly ingested records.
export async function runDiscovery(db: DB, config: Config, input: SearchInput, adapters: SourceAdapter[]|undefined,
 deps: DiscoveryDeps, health: Health): Promise<{results: Result[]; ingested: Result[]; providers: ProviderStatus[]}> {
 const providers = (adapters ?? configuredProviders(config)).slice(0, 3);
 const {plan, status: planStatus} = await planFor(db, config, input, deps);
 const outcomes = await Promise.all(plan.searches.flatMap((search, index) => providers.map(async (provider): Promise<Outcome> => {
   const limit = provider.name === 'searxng' ? config.SEARXNG_DAILY_BUDGET : config.DISCOVERY_DAILY_BUDGET;
   if (!await takeBudget(db, `discovery:${provider.name}`, limit)) return {provider, search, index, page: null, failure: 'budget_exhausted'};
   const adapter = provider instanceof SearXNG ? provider.forTarget(search.target) : provider;
   try {
     const page = await adapter.search(search.query, {...input, q: search.query});
     await health(provider.name, page.status.status === 'ok');
     return {provider, search, index, page};
   } catch {
     await health(provider.name, false);
     return {provider, search, index, page: null, failure: 'unavailable'};
   }
 })));
 const candidates = outcomes.flatMap(o => (o.page?.results ?? []).map((item, position) => ({
   item: {...item, url: canonicalize(item.url)}, provider: o.provider.name, position, query: o.search.query, searchIndex: o.index, target: o.search.target})));
 const webUrls = new Set(candidates.filter(c => c.target === 'web').map(c => c.item.url));
 const ingested: Result[] = [];
 const targets = new Map<string,SearchTarget>();
 for (const lead of rankDiscovery(input.q, candidates, config.DISCOVERY_RESULTS)) {
   const result = await ingest(db, lead.item, {adapter: lead.provider, method: 'search', discovered_at: new Date().toISOString()});
   if (!result) continue;
   ingested.push(result);
   targets.set(result.id, webUrls.has(lead.item.url) ? 'web' : 'videos');
 }
 const signals = input.source ? {results: ingested, providers: []}
   : await applySignals(db, config, input.q, ingested, deps, {kind: plan.kind, criteria: plan.criteria, targets});
 return {results: signals.results, ingested,
   providers: [...providers.map(p => summarise(p.name, outcomes.filter(o => o.provider === p))), ...(planStatus ? [planStatus] : []), ...signals.providers]};
}
