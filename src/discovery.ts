import type { DB } from './db.js';
import type { Config } from './config.js';
import type { DiscoveryPage, EngineFailure, ProviderStatus, Result, SearchInput, SourceAdapter } from './types.js';
import { configuredProviders, engineStatus, SearXNG } from './providers.js';
import { providerBudget, takeBudget } from './budgets.js';
import { canonicalize } from './urls.js';
import { rankDiscovery, type DiscoveryCandidate } from './ranking.js';
import { ingest } from './catalogue.js';
import { UpstreamError } from './http.js';
import { applySignals, discussionsFor, logFailure, type Discussion, type Judged, type SignalDeps } from './signals.js';
import { makePlanner, fallbackPlan, uniqueSearches, type PlannedSearch, type Planner, type SearchPlan, type SearchTarget } from './planner.js';
import { AniListClient, type AnimeClient, type AnimeMatch } from './anilist.js';
import { queryKey } from './search.js';
import { configuredArchives, specialistSearches } from './specialists.js';
import { PageChecker, type PageEvidence } from './pages.js';
import { matchesFilters } from './catalogue.js';
import { makeJudge } from './judge.js';
import type { SearchTrace } from './learning.js';
import { makeScreener, screeningOrder, type Screener } from './screener.js';
import { exploreSources, makeExplorer, type Explorer, type ExplorationTrace } from './exploration.js';

export interface DiscoveryDeps extends SignalDeps { planner?: Planner; anilist?: AnimeClient; archives?: SourceAdapter[]; screener?: Screener; explorer?: Explorer }
export interface DiscoveryProgress { results: Result[]; providers: ProviderStatus[]; stage: 'searching'|'following'|'checking' }
// code: why it failed, such as an engine's "blocked by a CAPTCHA".
type Health = (provider: string, ok: boolean, code?: string) => Promise<void>;
type Progress = (update: DiscoveryProgress) => Promise<void>;
type Outcome = {provider: SourceAdapter; page: DiscoveryPage|null; failure?: 'budget_exhausted'|'unavailable'};
// round: the follow-up round whose searches found it (0 for the planned searches).
type Lead = DiscoveryCandidate & {target: SearchTarget; round?: number};
// engines: which SearXNG engines to ask (see SearXNG.forTarget); other providers only take standard first pages.
type Search = PlannedSearch & {page: number; engines: 'standard'|'extra'|'all'};
// Follow-up material must match at least half of the query that found it.
const CLEAR_MATCH = 0.5;
// A deep dive only asks for follow-up leads when this much of its search time is left.
const FOLLOW_UP_MIN_MS = 15000;

function summarise(name: string, outcomes: Outcome[]): ProviderStatus {
 const pages = outcomes.flatMap(o => o.page ? [o.page] : []);
 if (!outcomes.length) return {provider: name, status: 'partial', message: 'No request started before the search deadline.'};
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

async function planWith(planner: Planner|undefined, query: string, deep: boolean, avoid: string[], anime: AnimeMatch|null): Promise<{plan: SearchPlan; status: ProviderStatus|null}> {
 if (!planner) return {plan: fallbackPlan(query), status: null};
 try {
   const plan = await planner.plan(query, deep ? {deep, avoid, anime} : {anime});
   return {plan, status: {provider: 'planner', status: 'ok',
     message: deep ? `AI planned ${plan.searches.length} searches for lesser-known sources.` : `AI planned ${plan.searches.length} searches for ${plan.kind}.`}};
 } catch (error) {
   logFailure('planner_failed', error);
   return {plan: deep ? {...fallbackPlan(query), searches: []} : fallbackPlan(query), status: error instanceof UpstreamError && error.code === 'budget_exhausted'
     ? {provider: 'planner', status: 'budget_exhausted', message: 'The daily AI planning limit has been reached; the query was searched as typed.'}
     : {provider: 'planner', status: 'unavailable', message: 'AI search planning is unavailable right now; the query was searched as typed.'}};
 }
}

// A confident AniList match, used to give the planner and judge an anime's real titles and details. Silent on a
// miss or a failure (logged only): most searches are not about anime, so failing this optional lookup should
// never show as a service problem on an unrelated query.
async function animeContext(client: AnimeClient|undefined, query: string): Promise<{anime: AnimeMatch|null; status: ProviderStatus|null}> {
 if (!client) return {anime: null, status: null};
 try {
   const anime = await client.lookup(query);
   return {anime, status: anime ? {provider: 'anilist', status: 'ok',
     message: `Recognised the anime "${anime.title}"; searches and AI checks use its official titles and details.`} : null};
 } catch (error) {
   logFailure('anilist_failed', error);
   return {anime: null, status: null};
 }
}

const pages = (from: number, to: number) => Array.from({length: Math.max(0, to - from + 1)}, (_, i) => from + i);
const sameSearch = (a: PlannedSearch, b: PlannedSearch) => a.target === b.target && a.query.toLowerCase() === b.query.toLowerCase();
function leadsMaterial(results: {url: string; title: string; creator: string|null; description: string|null}[], threads: Discussion[]) {
 const line = (text: string|null) => text ? ` — ${text.replace(/\s+/g, ' ').slice(0, 160)}` : '';
 return [...results.slice(0, 40).map(r => `${new URL(r.url).hostname}: ${r.title}${r.creator ? ` (by ${r.creator})` : ''}${line(r.description)}`),
   ...threads.slice(0, 10).map(t => `reddit: ${t.title}${line(t.snippet)}`)];
}

// Collect every launched provider's answer before admission and ranking. Deep discovery adds
// specialist indexes and grounded follow-ups, then rechecks quick and deep finds together.
// Returns the final order, the records it stored, the addresses its judge rejected after they had been shown, and the
// searches it ran.
export async function runDiscovery(db: DB, config: Config, input: SearchInput, adapters: SourceAdapter[]|undefined,
 deps: DiscoveryDeps, health: Health, progress: Progress = async () => {}): Promise<{results: Result[]; closest: Result[]; ingested: Result[]; dropped: string[];
 providers: ProviderStatus[]; previews: Map<string,Buffer>; searches: PlannedSearch[]; trace: SearchTrace}> {
 const deep = input.depth === 'deep' && !input.source;
 const providers = adapters ?? configuredProviders(config);
 const archives = deep ? deps.archives ?? configuredArchives(config, input.q) : [];
 const planner = input.source ? undefined : deps.planner ?? makePlanner(db, config);
 const anilist = input.source ? undefined : deps.anilist ?? (config.ANILIST_ENABLED ? new AniListClient(db, config) : undefined);
 const limit = deep ? config.DEEP_RESULTS : config.DISCOVERY_RESULTS;
 const deadline = deep ? Date.now() + config.DEEP_SEARCH_SECONDS*1000 : Infinity;
 const [earlier, anime] = await Promise.all([
   deep ? quickJob(db, input) : Promise.resolve({results: [] as Result[], searches: [] as PlannedSearch[]}),
   animeContext(anilist, input.q),
 ]);
 const leads: Lead[] = [];
 const found: Result[] = [];
 const tried = new Set<string>();
 const leadUrl = new Map<string,string>();
 const notes: ProviderStatus[] = [];
 if (anime.status) notes.push(anime.status);
 const outcomes: Outcome[] = [];
 let stage: DiscoveryProgress['stage'] = 'searching';
 // Publish stages, not provisional rankings. Every source gets to finish before selection.
 const report = () => progress({results: [], providers: notes, stage});

 const store = async (picks: Lead[]) => {
   let added = 0;
   for (const lead of picks) {
     if (found.length >= config.DISCOVERY_CANDIDATES) break;
     if (tried.has(lead.item.url)) continue;
     tried.add(lead.item.url);
     const result = await ingest(db, lead.item, {adapter: lead.provider, method: 'search', discovered_at: new Date().toISOString()});
     if (!result) continue;
     const previous = earlier.results.find(r => r.canonical_url === result.canonical_url);
     found.push(previous ? {...result, deep_find: previous.deep_find} : deep ? {...result, deep_find: true} : result);
     leadUrl.set(result.id, lead.item.url); added++;
   }
   return added;
 };
 // Answers are handled one at a time, in arrival order; a failure is raised once every search has returned.
 let arrivals = Promise.resolve();
 let failure: unknown = null;
 // Leads that several different searches found rank higher; pages of one search count as the same search.
 const searchIds = new Map<string,number>();
 const searchIndex = (s: PlannedSearch) => { const key = `${s.target}:${s.query.toLowerCase()}`; return searchIds.get(key) ?? searchIds.set(key, searchIds.size).get(key)!; };
 let round = 0;
 const roundOf = new Map<string,number>();
 const arrived = (page: DiscoveryPage, search: Search, provider: string) => {
   const batch: Lead[] = page.results.map((item, position) => ({item: {...item, url: canonicalize(item.url)}, provider,
     position: position + (search.page - 1)*20, query: search.query, searchIndex: searchIndex(search), target: search.target, round}));
   arrivals = arrivals.then(async () => {
     leads.push(...batch);
   }).catch(error => { failure ??= error; });
 };

 // Native APIs have their own indexes and pagination. Bound requests per source and isolate
 // failures; a timeout in one archive never discards the other engines' results.
 const runArchives = async () => Promise.all(archives.map(async provider => {
   let cursor: string|null = '1';
   for (let pageNumber = 1; cursor && pageNumber <= config.DEEP_PAGES && Date.now() < deadline; pageNumber++) {
     if (!await takeBudget(db, `discovery:${provider.name}`, config.ARCHIVE_DAILY_BUDGET)) {
       outcomes.push({provider, page: null, failure: 'budget_exhausted'}); break;
     }
     try {
       const page = await provider.search(input.q, input, cursor);
       arrived(page, {query: input.q, target: 'videos', page: pageNumber, engines: 'all'}, provider.name);
       outcomes.push({provider, page});
       await health(provider.name, page.status.status === 'ok', page.status.status);
       cursor = page.next_cursor;
     } catch (error) {
       await health(provider.name, false, error instanceof UpstreamError ? error.code : 'unavailable');
       outcomes.push({provider, page: null, failure: 'unavailable'}); break;
     }
   }
 }));
 const run = async (searches: Search[]) => {
   const jobs = searches.flatMap(search => providers.flatMap(provider => {
     if (!(provider instanceof SearXNG)) return search.page === 1 && search.engines !== 'extra' ? [{search, provider, adapter: provider}] : [];
     const adapter = provider.forTarget(search.target, search.engines);
     return adapter.engines.length ? [{search, provider, adapter}] : [];
   }));
   outcomes.push(...(await Promise.all(jobs.map(async ({search, provider, adapter}): Promise<Outcome|null> => {
     if (Date.now() > deadline) return null;
     if (!await takeBudget(db, `discovery:${provider.name}`, providerBudget(config, provider.name))) return {provider, page: null, failure: 'budget_exhausted'};
     const filters = {...input, q: search.query};
     try {
       let page: DiscoveryPage;
       if (adapter instanceof SearXNG) {
         page = await adapter.search(search.query, filters, String(search.page), {deadline,
           onPage: answer => arrived(answer, search, `${provider.name}:${answer.engines?.asked[0] ?? ''}`)});
       } else {
         page = await adapter.search(search.query, filters);
         arrived(page, search, provider.name);
       }
       await health(provider.name, page.status.status === 'ok', page.status.status);
       for (const engine of page.engines?.asked ?? []) {
         const failed = page.engines!.failed.find(f => f.engine === engine);
         await health(`${provider.name}:${engine}`, !failed, failed?.reason);
       }
       return {provider, page};
     } catch (error) {
       await health(provider.name, false, error instanceof UpstreamError ? error.code : 'unavailable');
       return {provider, page: null, failure: 'unavailable'};
     }
   }))).flatMap(o => o ? [o] : []));
 };

 let plan: SearchPlan;
 let ran: PlannedSearch[];
 if (!deep) {
   // A search scoped to one source (replacement-domain discovery) runs exactly as asked.
   const typed = input.source ? [{query: input.q, target: 'videos' as const}] : fallbackPlan(input.q).searches;
   const planning = input.source ? Promise.resolve({plan: {kind: 'videos' as const, searches: typed, criteria: [], model: null}, status: null})
     : planWith(planner, input.q, false, [], anime.anime);
   await Promise.all([
     run(typed.map(s => ({...s, page: 1, engines: 'standard'}))),
     planning.then(({plan}) => run(plan.searches.filter(s => !typed.some(t => sameSearch(t, s))).map(s => ({...s, page: 1, engines: 'standard'})))),
   ]);
   const planned = await planning;
   plan = planned.plan;
   if (planned.status) notes.push(planned.status);
   ran = [...typed, ...plan.searches.filter(s => !typed.some(t => sameSearch(t, s)))];
 } else {
   // What an ordinary search asked; its first result pages are already known unless no quick search ran.
   const ordinary = earlier.searches.length ? earlier.searches : fallbackPlan(input.q).searches;
   const planning = planWith(planner, input.q, true, ordinary.map(s => s.query), anime.anime);
   const specialists = uniqueSearches(specialistSearches(input.q, config.SPECIALIST_SEARCHES), config.SPECIALIST_SEARCHES, ordinary.map(s => s.query));
   await Promise.all([
     runArchives(),
     run(specialists.map(s => ({...s, page: 1, engines: 'all'}))),
     run(ordinary.flatMap(s => [
       ...(earlier.searches.length ? [{...s, page: 1, engines: 'extra' as const}] : [{...s, page: 1, engines: 'all' as const}]),
       ...pages(2, config.DEEP_PAGES).map(page => ({...s, page, engines: 'all' as const}))])),
     planning.then(({plan}) => run(plan.searches.filter(s => ![...ordinary, ...specialists].some(t => sameSearch(s,t)))
       .flatMap(s => pages(1, config.DEEP_PAGES).map(page => ({...s, page, engines: 'all' as const}))))),
   ]);
   const planned = await planning;
   plan = planned.plan;
   if (planned.status) notes.push(planned.status);
   ran = uniqueRan([...ordinary, ...specialists, ...plan.searches]);
 }
 await arrivals;
 if (failure) throw failure;

 // Reddit threads are read once: as leads for a deep dive and as evidence for the checks.
 const discussions = discussionsFor(db, config, deps);
 const reddit = deep && discussions ? await discussions(input.q).then(threads => ({threads, error: null}), error => ({threads: [], error})) : null;
 const signalDeps: SignalDeps = reddit ? {...deps, discussions: async () => { if (reddit.error) throw reddit.error; return reddit.threads; }} : deps;
 // Each round follows leads in the newest finds, until time runs short or the leads stop turning up anything new.
 const cachedPages = new Map<string,Promise<PageEvidence>>();
 const checker = deps.pages ?? (config.PAGE_CHECKS ? new PageChecker(config) : undefined);
 const checkPage = async (url: string): Promise<PageEvidence> => {
   if (!cachedPages.has(url) && checker && cachedPages.size < config.PAGE_CHECKS)
     cachedPages.set(url, checker.check(url).catch(() => ({status: 'unavailable', title: null, description: null, text: null, libraries: [], badges: []})));
   return cachedPages.get(url) ?? {status: 'unavailable', title: null, description: null, text: null, libraries: [], badges: []};
 };
 let exploration: ExplorationTrace|undefined;
 const explorer = deps.explorer ?? makeExplorer(db,config);
 // Reserve at least half the page budget for normal evidence checks. Scoped searches
 // remain scoped; exploration only follows real references and never approves a source.
 const explorationPages = Math.min(config.JEV_EXPLORATION_PAGES,Math.floor(config.PAGE_CHECKS/2));
 if (explorer && checker && explorationPages && !input.source && !/(?:^|\s)site:/i.test(input.q) && Date.now()<deadline) {
   stage='following';await report();
   const seeds=rankDiscovery(input.q,leads.filter(l=>l.target==='web'),leads.length,0,true).map(l=>({
     url:l.item.url,title:l.item.title,description:l.item.description,published_at:l.item.published_at,from_url:null}));
   if(seeds.length) {
     const out=await exploreSources(input.q,seeds,explorer,checkPage,config,explorationPages,deadline);
     exploration=out.trace;
     for(const [position,item] of out.items.entries()) if(!leads.some(l=>l.item.url===item.url))
       leads.push({item,provider:'jev_exploration',position,query:input.q,target:'web',round:0});
     const partial=out.trace.rounds.some(r=>r.failed_batches>0);
     notes.push({provider:'jev_exploration',status:out.trace.error?(out.trace.error==='budget_exhausted'?'budget_exhausted':'unavailable'):partial?'partial':'ok',
       message:`Explored ${out.trace.visited.length} pages and found ${out.items.length} new candidates.${out.trace.error||partial?' Some exploration decisions were unavailable; other search results were retained.':''}`});
     await health('jev_exploration',!out.trace.error&&!partial,out.trace.error??(partial?'partial':'ok'));
   }
 }
 let followed = 0, rounds = 0, leadError: unknown = null;
 while (deep && planner?.followUps && config.DEEP_FOLLOW_UPS && rounds < config.DEEP_ROUNDS && deadline - Date.now() > FOLLOW_UP_MIN_MS) {
   stage = 'following'; await report();
   const promising = rankDiscovery(input.q, leads, 40, CLEAR_MATCH);
   const material = leadsMaterial([...promising.map(l => l.item), ...earlier.results.map(r => ({...r, url: r.canonical_url}))], reddit?.threads ?? []);
   // Read a small, bounded set of promising pages to expose real creator names and references.
   const checked = await Promise.all(promising.filter(l => l.target === 'web').slice(0, 6).map(async l => ({url: l.item.url, page: await checkPage(l.item.url)})));
   for (const {url, page} of checked) if (page.status === 'checked') {
     material.push(`${url}: ${page.text ?? page.description ?? ''}`);
     for (const link of page.links ?? []) material.push(`Reference on ${url}: ${link.title} (${link.url})`);
   }
   const next = await planner.followUps(input.q, material, ran.map(s => s.query)).catch(error => { leadError = error; logFailure('deep_leads_failed', error); return null; });
   const searches = uniqueSearches(next ?? [], config.DEEP_FOLLOW_UPS, ran.map(s => s.query));
   if (!searches.length) break;
   rounds++; round = rounds; const known = new Set(leads.map(l => l.item.url));
   for (const s of searches) roundOf.set(`${s.target}:${s.query.toLowerCase()}`, rounds);
   await run(searches.map(s => ({...s, page: 1, engines: 'all'})));
   await arrivals;
   if (failure) throw failure;
   ran.push(...searches); followed += searches.length;
   if (!leads.some(l => !known.has(l.item.url))) break;
 }
 if (leadError) notes.push({provider: 'leads', status: leadError instanceof UpstreamError && leadError.code === 'budget_exhausted' ? 'budget_exhausted' : 'unavailable',
   message: 'Following leads from the first finds is unavailable right now.'});
 else if (rounds) notes.push({provider: 'leads', status: 'ok', message: `AI followed ${followed} leads from what it found, in ${rounds} ${rounds === 1 ? 'round' : 'rounds'}.`});
 if (Date.now() >= deadline) notes.push({provider: 'search_deadline', status: 'partial',
   message: 'The search time limit was reached. Results include completed sources; some planned searches may not have run.'});
 // Previous quick finds compete in the same pool and are rechecked under the same criteria.
 for (const r of earlier.results) if (!leads.some(l => l.item.url === r.canonical_url)) leads.push({
   item: {...r, url: r.canonical_url, provider_id: null, rights_status: 'unknown', availability: 'unknown'},
   provider: 'previous_search', position: 0, query: input.q, target: plan.kind === 'websites' ? 'web' : 'videos'});
 const judge = deps.judge ?? makeJudge(db, config);
 const ranked = rankDiscovery(input.q, leads, leads.length, 0, !!judge);
 if (ranked.length > config.DISCOVERY_CANDIDATES) notes.push({provider: 'candidate_pool', status: 'partial',
   message: `${ranked.length} candidates found; up to ${config.DISCOVERY_CANDIDATES} candidates were selected for checking after all sources answered.`});
 // Baseline: clear keyword matches precede loose leads. Optional screening can promote
 // promising metadata matches while reserving every fourth pick for this original order.
 const clear = new Set(rankDiscovery(input.q, leads, leads.length, CLEAR_MATCH).map(l => l.item.url));
 let picks = [...ranked.filter(l => clear.has(l.item.url)), ...ranked.filter(l => !clear.has(l.item.url))];
 const screener = deps.screener ?? makeScreener(db, config);
 stage = 'checking'; await report();
 if (screener && picks.length) {
   try {
     const screened = await screener.screen(input.q, picks);
     await health('jev_screener', true);
     picks = screeningOrder(picks, screened.promising);
     notes.push({provider: 'jev_screener', status: 'ok',
       message: `Screened ${screened.screened} of ${ranked.length} leads to prioritize evidence checks; final relevance is checked separately.`});
   } catch (error) {
     const code = error instanceof UpstreamError ? error.code : 'unavailable';
     notes.push({provider: 'jev_screener', status: code === 'budget_exhausted' ? 'budget_exhausted' : 'unavailable',
       message: 'Candidate screening was unavailable; the original candidate order was used.'});
     await health('jev_screener', false, code);
   }
 }
 await store(picks);
 const statuses = [...[...providers, ...archives].map(p => summarise(p.name, outcomes.filter(o => o.provider === p))), ...notes];
 const searches = uniqueRan(ran);

 stage = 'checking'; await report();
 const webUrls = new Set(leads.filter(l => l.target === 'web').map(l => l.item.url));
 const targets = new Map(found.map(r => [r.id, webUrls.has(leadUrl.get(r.id)!) ? 'web' as const : 'videos' as const]));
 const signals = await applySignals(db, {...config, JUDGE_CANDIDATES: found.length}, input.q, found, {...signalDeps, judge, pages: {check: checkPage}},
   {kind: plan.kind, criteria: plan.criteria, targets, underrated: deep, anime: anime.anime});
 // Semantic-only candidates were admitted for judging. If that check fails, they must not
 // displace supported keyword matches merely because the model had been configured.
 const lexical = new Set(rankDiscovery(input.q, leads, leads.length).map(l => l.item.url));
 const results = signals.results.filter(r => (r.judgement || lexical.has(r.canonical_url)) && matchesFilters(r, input))
   .slice(0, limit + earlier.results.length);
 const kept = new Set(results.map(r => r.canonical_url));
 for (const [id] of signals.previews) if (!results.some(r => r.id === id)) signals.previews.delete(id);
 return {results, closest:signals.closest.filter(r=>matchesFilters(r,input)), ingested: found, previews: signals.previews, searches,
   dropped: [...new Set([...found, ...earlier.results].filter(r => !kept.has(r.canonical_url)).map(r => r.canonical_url))], providers: [...statuses, ...signals.providers],
   trace: {...traceOf(input, plan, searches, rounds, [...statuses, ...signals.providers], leads, found, leadUrl, signals.judged, results, roundOf),
     ...(exploration?{exploration}:{})}};
}

const uniqueRan = (list: PlannedSearch[]) => list.filter((s, i) => list.findIndex(o => sameSearch(o, s)) === i);

async function quickJob(db: DB, input: SearchInput): Promise<{results: Result[]; searches: PlannedSearch[]}> {
 const row = (await db.query(`SELECT result FROM jobs WHERE dedupe_key=$1 AND status='complete'`,
   [`discovery:${queryKey({...input, depth: 'quick'})}`])).rows[0];
 return {results: row?.result?.results ?? [], searches: row?.result?.searches ?? []};
}

// What this search did, for the learning loop: every admitted candidate with the round that first found it, the judge's
// verdict (rejected ones included), and where it was shown.
function traceOf(input: SearchInput, plan: SearchPlan, searches: PlannedSearch[], rounds: number, providers: ProviderStatus[], leads: Lead[],
 found: Result[], leadUrl: Map<string,string>, judged: Judged[], results: Result[], roundOf: Map<string,number>): SearchTrace {
 const first = new Map<string,number>();
 for (const l of leads) first.set(l.item.url, Math.min(first.get(l.item.url) ?? Infinity, l.round ?? 0));
 const verdicts = new Map(judged.map(j => [j.id, j]));
 const shown = new Map(results.map((r, i) => [r.canonical_url, {rank: i + 1, badges: r.badges ?? []}]));
 return {query: input.q, depth: input.depth === 'deep' && !input.source ? 'deep' : 'quick',
   plan: {kind: plan.kind, criteria: plan.criteria, model: plan.model},
   searches: searches.map(s => ({query: s.query, target: s.target, round: roundOf.get(`${s.target}:${s.query.toLowerCase()}`) ?? 0})),
   rounds, providers,
   pool: found.map(r => { const v = verdicts.get(r.id), place = shown.get(r.canonical_url);
     return {url: r.canonical_url, title: r.title, site: new URL(r.canonical_url).hostname.replace(/^www\./, ''),
       round: first.get(leadUrl.get(r.id) ?? r.canonical_url) ?? 0, relevance: v?.relevance ?? null, reason: v?.reason ?? null, basis: v?.basis ?? null,
       shown: !!place, rank: place?.rank ?? null, badges: place?.badges ?? []}; })};
}
