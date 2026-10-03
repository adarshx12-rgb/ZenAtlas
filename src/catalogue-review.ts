import type { DB } from './db.js';
import type { Config } from './config.js';
import type { Result, SearchInput } from './types.js';
import { applySignals, type SignalDeps } from './signals.js';
import { makeJudge } from './judge.js';
import { matchesFilters } from './catalogue.js';
import { PageChecker, type PageEvidence } from './pages.js';
import { youtubeId } from './youtube.js';

// When the catalogue alone answers a search, its matches are keyword hits from earlier searches: "video background
// removal models" matched image background removers ("images and videos") and a Photoshop tutorial whose transcript
// says "in this video … model photo". They are judged like discovery's own finds before they stay on the page; what the
// judge rejects or cannot check is dropped (the search's merge keeps only the results returned here).
export const CATALOGUE_REVIEW_LIMIT = 12;

export async function reviewCatalogue(db: DB, config: Config, input: SearchInput, results: Result[], deps: SignalDeps = {}) {
 const pool = results.slice(0, CATALOGUE_REVIEW_LIMIT);
 const judge = deps.judge ?? makeJudge(db, config);
 if (!judge || !pool.length) return {results: pool, closest: [] as Result[], dropped: [] as string[], revision: 1,
   providers: judge ? [] : [{provider: 'judge', status: 'disabled' as const, message: 'Catalogue results were not checked for relevance.'}]};
 const checker = deps.pages ?? (config.PAGE_CHECKS ? new PageChecker(config) : undefined);
 const none: PageEvidence = {status: 'unavailable', title: null, description: null, text: null, libraries: [], badges: []};
 const pages = new Map<string, Promise<PageEvidence>>();
 const check = async (url: string): Promise<PageEvidence> => {
   if (!pages.has(url) && checker && pages.size < config.PAGE_CHECKS) pages.set(url, checker.check(url).catch(() => none));
   return pages.get(url) ?? none;
 };
 // Stored pages from any site can answer a Videos search (repositories, threads), so the judge is told "mixed".
 const targets = new Map(pool.map(r => [r.id, youtubeId(r.canonical_url) ? 'videos' as const : 'web' as const]));
 const signals = await applySignals(db, {...config, JUDGE_CANDIDATES: pool.length}, input.q, pool, {...deps, judge, pages: {check}},
   {kind: 'mixed', criteria: [], targets});
 const kept = signals.results.filter(r => matchesFilters(r, input));
 const shown = new Set(kept.map(r => r.canonical_url));
 return {results: kept, closest: signals.closest.filter(r => matchesFilters(r, input)), providers: signals.providers,
   dropped: pool.filter(r => !shown.has(r.canonical_url)).map(r => r.canonical_url), revision: 1};
}
