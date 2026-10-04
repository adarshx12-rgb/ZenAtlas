import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { ProviderStatus } from './types.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { publicURL } from './urls.js';
import { searchSearXNG } from './providers.js';
import { tierSchema } from './tiers.js';
import { rewriteQuery } from './query-rewrite.js';
import { planImages, rankSearches, type ImagePlan } from './image-plan.js';
import { aiGenerated, excludesAI, openverseQuery, openverseResults, wantsLicense, type ImageLicense } from './image-signals.js';
import { startImageJob } from './image-review.js';
import { bySource, interleaveImages, mergeShares, onSite, rankSearxng, siteWord } from './image-sources.js';
import { withSearchTrace, traceFields } from './search-trace.js';
import { routeFields, type FieldRoute } from './field-routing.js';

const engineList = (engines: string) => [...new Set(engines.split(',').map(e => e.trim()).filter(Boolean))];

// Image search is discovery-only: results are returned straight from the engines and never
// enter the catalogue. The evidence pipeline — transcripts, moments, scene analysis — is
// video-shaped and has nothing to say about a still, so it is skipped rather than stubbed out.
//
// Pinterest has its own SearXNG engine; Reddit has none in this build, but the general image engines index it.

export const imageSearchInput = z.object({
 q: z.string().transform(v => v.normalize('NFC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(500)),
 limit: z.coerce.number().int().min(1).max(100).default(48),
 language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
 page: z.coerce.number().int().min(1).max(10).default(1),
 tier: tierSchema,
}).strict();
export type ImageSearchInput = z.infer<typeof imageSearchInput>;

export interface ImageResult {
 id: string; title: string; image_url: string; thumbnail: string;
 page_url: string; source_name: string;
 width: number | null; height: number | null; engine: string;
 // From Openverse, which indexes openly licensed images; absent means the licence is unknown.
 license?: ImageLicense;
 // The source marks it AI-generated (an ai-image URL, a "Generative AI" label).
 ai_generated?: true;
}
export interface ImageSearchResponse {
 query: string; results: ImageResult[]; providers: ProviderStatus[]; next_cursor: string | null;
 // The job's token (src/image-review.ts), polled at /api/images/review; pending: the results come only from there.
 review?: string; pending?: true; rewrite?: {corrected: string};
}
export interface ImageSearchDeps {
 plan?: (query: string) => Promise<ImagePlan>; rewrite?: typeof rewriteQuery;
 review?: false | ((query: string, collect: () => Promise<CollectedImages>) => string | null);
 budget?: typeof takeBudget; transport?: typeof fetchJSON;
 route?: (query: string) => Promise<FieldRoute>;
}
// Routed specialist sites (src/field-routing.ts): each site's best few images, and at most this many in all.
const FIELD_IMAGES_PER_SITE = 5, FIELD_IMAGES = 10;

// Openverse (openly licensed images with their licence), asked beside the engines when enabled and within budget.
async function openverse(db: DB, config: Config, q: string, page: number): Promise<{results: ImageResult[]; status: ProviderStatus|null}> {
 if (!config.OPENVERSE_ENABLED) return {results: [], status: null};
 if (!await takeBudget(db, 'discovery:openverse', config.OPENVERSE_DAILY_BUDGET)) return {results: [], status: null};
 const url = new URL('https://api.openverse.org/v1/images/');
 url.search = new URLSearchParams({q, page: String(page), page_size: '20', mature: 'false'}).toString();
 try {
   return {results: openverseResults(await fetchJSON(url.href, {trustedOrigin: url.origin, timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0})),
     status: {provider: 'openverse', status: 'ok', message: 'Openly licensed images came from Openverse.'}};
 } catch {
   return {results: [], status: {provider: 'openverse', status: 'unavailable', message: 'Openverse (licensed images) did not answer.'}};
 }
}

// Brave's image index: the whole web, every planned search (each after the first only within budget). Its image API has no
// offset, so Brave answers the first page only.
async function braveImages(db: DB, config: Config, queries: string[], input: ImageSearchInput, deps: ImageSearchDeps): Promise<{results: ImageResult[]; status: ProviderStatus|null}> {
 if (!config.BRAVE_SEARCH_API_KEY || input.page > 1) return {results: [], status: null};
 const budget = deps.budget ?? takeBudget;
 if (!await budget(db, 'discovery:brave', config.BRAVE_DAILY_BUDGET)) {
   return {results: [], status: {provider: 'brave', status: 'budget_exhausted', message: 'The daily Brave budget has been reached.'}};
 }
 const ask = async (q: string, first: boolean) => {
   if (!first && !await budget(db, 'discovery:brave', config.BRAVE_DAILY_BUDGET)) return null;
   return braveImageSearch(config, q, input, deps);
 };
 const answers = await Promise.allSettled(queries.map((q, i) => ask(q, i === 0)));
 const lists = answers.flatMap(a => a.status === 'fulfilled' && a.value ? [a.value] : []);
 if (!lists.length) return {results: [], status: {provider: 'brave', status: 'unavailable', message: 'Brave did not answer; other engines were asked.'}};
 return {results: bySource(interleaveImages(...lists), '', queries[0]), status: {provider: 'brave', status: 'ok', message: 'Brave image search completed.'}};
}
async function braveImageSearch(config: Config, q: string, input: ImageSearchInput, deps: ImageSearchDeps) {
 const url = new URL('https://api.search.brave.com/res/v1/images/search');
 url.search = new URLSearchParams({q, count: String(Math.min(100, input.limit)), safesearch: 'strict',
   ...(input.language ? {search_lang: input.language.split('-')[0]!} : {})}).toString();
 return braveImageResults(await (deps.transport ?? fetchJSON)(url.href, {trustedOrigin: url.origin,
   headers: {'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY}, timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0}));
}

// One Brave image search per routed site, kept to that site's pages and images; the sites' best few, taken in turn.
async function routedImages(db: DB, config: Config, q: string, sites: string[], input: ImageSearchInput, deps: ImageSearchDeps): Promise<ImageResult[]> {
 if (!config.BRAVE_SEARCH_API_KEY || !sites.length) return [];
 const budget = deps.budget ?? takeBudget;
 const lists = await Promise.all(sites.map(async site => {
   if (!await budget(db, 'discovery:brave', config.BRAVE_DAILY_BUDGET)) return [];
   return (await braveImageSearch(config, `${q} site:${site}`, input, deps).catch(() => [] as ImageResult[]))
     .filter(r => onSite(r, site)).slice(0, FIELD_IMAGES_PER_SITE);
 }));
 return interleaveImages(...lists).slice(0, FIELD_IMAGES);
}

export function braveImageResults(payload: unknown): ImageResult[] {
 const rows = z.object({results: z.array(z.unknown()).max(200)}).safeParse(payload);
 const results: ImageResult[] = [];
 for (const raw of rows.success ? rows.data.results : []) {
   const row = z.looseObject({url: z.string(), properties: z.looseObject({url: z.string()})}).safeParse(raw);
   if (!row.success) continue;
   const r = row.data as Record<string, any>;
   const image = mediaURL(r.properties.url), page = mediaURL(r.url);
   if (!image || !page) continue;
   const host = new URL(page).hostname.replace(/^www\./, '');
   const size = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
   results.push({id: createHash('sha1').update(image).digest('hex'), title: displayTitle(r.title, host), image_url: image,
     thumbnail: mediaURL(r.thumbnail?.src) ?? image, page_url: page, source_name: host,
     width: size(r.properties.width), height: size(r.properties.height), engine: 'brave'});
 }
 return results;
}

// SearXNG brings a few good images rather than many: engines chosen by judged quality, the strict ones and the focus site
// kept only when their caption names the whole request, best first. Each planned search runs on the main engines; one more
// names the focus site. The fallback engines are asked only when fewer than SEARXNG_IMAGE_MIN images are usable. The status
// shown is the first search's.
async function searxngImages(db: DB, config: Config, queries: string[], input: ImageSearchInput): Promise<ImageSearchResponse> {
 const q = queries[0]!;
 const focus = config.IMAGE_FOCUS_SITE;
 const strict = engineList(config.SEARXNG_IMAGE_STRICT_ENGINES);
 const engines = [...new Set([...engineList(config.SEARXNG_IMAGE_ENGINES), ...strict])];
 const focusEngines = focus ? engineList(config.SEARXNG_IMAGE_FOCUS_ENGINES) : [];
 const [mains, site] = await Promise.all([Promise.all(queries.map(query => engineImages(db, config, {...input, q: query}, engines))),
   focusEngines.length ? engineImages(db, config, {...input, q: `${siteWord(focus)} ${q}`}, focusEngines) : null]);
 // Only the focus site's images count from the search that names it; the rest of that search is about the site, not the query.
 const rank = (list: ImageResult[]) => rankSearxng(interleaveImages(list), q, focus, new Set(strict));
 let results = rank([...interleaveImages(...mains.map(m => m.results)), ...(site?.results ?? []).filter(r => onSite(r, focus))]);
 const fallback = engineList(config.SEARXNG_IMAGE_FALLBACK_ENGINES);
 if (fallback.length && results.length < config.SEARXNG_IMAGE_MIN) results = rank([...results, ...(await engineImages(db, config, {...input, q}, fallback)).results]);
 const main = mains[0]!;
 return {...main, results, next_cursor: mains.find(m => m.next_cursor)?.next_cursor ?? site?.next_cursor ?? null};
}

// Optional upstream metadata is best effort: an unusable value drops the field, not the result.
// publicURL also keeps the egress guard honest — an engine must not be able to point the
// thumbnail proxy at a private address.
function mediaURL(value: unknown) {
 if (typeof value !== 'string' || !value) return null;
 try { const url = publicURL(value.startsWith('//') ? `https:${value}` : value).href; return url.length <= 2048 ? url : null; }
 catch { return null; }
}
function resolution(value: unknown): [number | null, number | null] {
 const match = typeof value === 'string' ? /^(\d{1,5})\s*[x×]\s*(\d{1,5})$/.exec(value.trim()) : null;
 return match ? [Number(match[1]), Number(match[2])] : [null, null];
}
// Engines often title an image with its filename. A hostname reads better than "IMG_2841.jpg".
function displayTitle(title: unknown, host: string) {
 const text = typeof title === 'string' ? title.trim() : '';
 if (!text) return host;
 // Two shapes of filename to catch. Anything ending in an image extension, whatever else it
 // contains — engines return names with ellipses, percent-escapes and dimensions baked in. And
 // CDN-style stems with no extension at all ("718ayP-IFiL._AC_UF894,1000_QL80_"), identified by
 // having no spaces at all plus digits or underscores, which a real caption effectively never has.
 const looksLikeFile = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(text)
   || (!/\s/.test(text) && text.length > 20 && /[_\d]/.test(text));
 return looksLikeFile ? host : text.slice(0, 300);
}

// The image planner's picture of the answer (src/image-plan.ts); when it has no searches to offer, the light rewrite's,
// kept only when they add to the request.
async function imagePlan(db: DB, config: Config, query: string, deps: ImageSearchDeps): Promise<ImagePlan> {
 const planned = await (deps.plan ?? (q => planImages(db, config, q)))(query).catch(() => null);
 if (planned?.searches.length) return planned;
 const r = await (deps.rewrite ?? rewriteQuery)(db, config, query, 'images').catch(() => null);
 return r ? {query, corrected: r.corrected, changed: r.changed, topic: r.topic, searches: rankSearches(r.corrected, r.searches), look_for: planned?.look_for ?? []}
   : planned ?? {query, corrected: query, changed: false, topic: null, searches: [], look_for: []};
}

// Everything the request's searches found, before any checking: Brave's share first in each stretch of the pool, licensed
// images after (first when the request is about licences), AI-marked images left out when the request excludes them.
// field: the request's field when it was routed, so the judge's verdicts can teach its picture sites; routed: the image URLs
// that came from its specialist sites (for evaluation).
export interface CollectedImages { plan: ImagePlan; images: ImageResult[]; providers: ProviderStatus[]; next_cursor: string|null; field?: string|null; routed?: string[] }
export async function collectImages(db: DB, config: Config, input: ImageSearchInput, deps: ImageSearchDeps = {}, size = input.limit): Promise<CollectedImages> {
 // Alongside the plan, the request's field and its specialist picture sites, on the first page.
 const [plan, route] = await Promise.all([imagePlan(db, config, input.q, deps),
   input.page === 1 ? (deps.route ?? (q => routeFields(db, config, q, 'images')))(input.q).catch(() => null) : null]);
 const q = plan.corrected;
 // The request as typed (corrected) runs first, so a redesign can only add to what is found.
 const queries = [q, ...plan.searches];
 const [found, brave, extra, routed] = await Promise.all([searxngImages(db, config, queries, input), braveImages(db, config, queries, {...input, limit: Math.max(input.limit, 50)}, deps),
   openverse(db, config, openverseQuery(q, plan.topic), input.page), routedImages(db, config, q, route?.sites ?? [], {...input, limit: 20}, deps)]);
 const providers = [...(brave.status ? [brave.status] : []), ...found.providers, ...(extra.status ? [extra.status] : [])];
 const noAI = excludesAI(input.q);
 let unmarked = 0;
 const usable = (list: ImageResult[]) => list.map(r => aiGenerated(r.page_url, r.title) ? {...r, ai_generated: true as const} : r)
   .filter(r => !(noAI && r.ai_generated && ++unmarked));
 const engines = mergeShares(usable(brave.results), usable(found.results), config.IMAGE_BRAVE_SHARE, size);
 const seen = new Set(engines.map(r => r.image_url));
 const fresh = usable(extra.results).filter(r => !seen.has(r.image_url));
 let images = (wantsLicense(input.q) ? [...fresh, ...engines] : [...engines, ...fresh]).slice(0, size);
 // Routed sites' images sit just inside the end of the judged pool: they add to the open web's best instead of displacing
 // them, and a site that found nothing leaves its places to the open web.
 const taken = new Set(images.map(r => r.image_url));
 const sited = usable(routed).filter(r => !taken.has(r.image_url));
 if (sited.length) {
   const at = Math.min(images.length, Math.max(0, config.IMAGE_JUDGE_POOL - sited.length));
   images = [...images.slice(0, at), ...sited, ...images.slice(at)].slice(0, Math.max(size, at + sited.length));
 }
 if (unmarked) providers.push({provider: 'ai_filter', status: 'ok', message: `${unmarked} images their source marks as AI-generated were left out.`});
 return {plan, images, providers, next_cursor: found.next_cursor ?? (images.length ? String(input.page + 1) : null), field: route?.field ?? null,
   routed: sited.map(r => r.image_url)};
}

// With the review on, the page gets only judged results: the search answers at once with a token, and the job behind it
// redesigns the request, collects a pool from every search, has Jev screen it, collapses duplicates and judges the best
// (src/image-review.ts). /api/images/review reports its stage until the judged page is ready. Without a judge, the
// collected images are returned as found.
export const searchImages = (...args: Parameters<typeof searchImagesImpl>) => withSearchTrace(async () => Object.assign(await searchImagesImpl(...args), traceFields()));
async function searchImagesImpl(db: DB, config: Config, input: ImageSearchInput, deps: ImageSearchDeps = {}): Promise<ImageSearchResponse> {
 if (deps.review !== false) {
   const start = deps.review ?? ((query: string, collect: () => Promise<CollectedImages>) => startImageJob(db, config, query, input.limit, collect));
   const token = start(input.q, () => collectImages(db, config, input, deps, config.IMAGE_POOL));
   if (token) return {query: input.q, results: [], providers: [], next_cursor: null, review: token, pending: true};
 }
 const found = await collectImages(db, config, input, deps);
 return {query: found.plan.corrected, results: found.images, providers: found.providers, next_cursor: found.next_cursor,
   ...(found.plan.changed ? {rewrite: {corrected: found.plan.corrected}} : {})};
}

export async function engineImages(db: DB, config: Config, input: ImageSearchInput, engines: string[]): Promise<ImageSearchResponse> {
 if (!config.SEARXNG_BASE_URL || !engines.length) {
   return {query: input.q, results: [], next_cursor: null,
     providers: [{provider: 'searxng', status: 'disabled', message: 'Image search is not configured on this instance.'}]};
 }
 if (!await takeBudget(db, 'discovery:searxng', config.SEARXNG_DAILY_BUDGET)) {
   return {query: input.q, results: [], next_cursor: null,
     providers: [{provider: 'searxng', status: 'budget_exhausted', message: 'The daily discovery budget has been reached.'}]};
 }

 let parsed: Awaited<ReturnType<typeof searchSearXNG>>;
 try {
   parsed = await searchSearXNG(config, {query: input.q, engines, page: String(input.page), language: input.language});
 } catch (error) {
   if (!(error instanceof UpstreamError)) throw error;
   return {query: input.q, results: [], next_cursor: null,
     providers: [{provider: 'searxng', status: 'unavailable', message: 'Image search is unavailable right now.'}]};
 }

 const results: ImageResult[] = [];
 const seen = new Set<string>();
 for (const raw of parsed.results) {
   if (results.length >= input.limit) break;
   try {
     const row = z.looseObject({url: z.string()}).parse(raw);
     const image = mediaURL(row.img_src);
     const page = mediaURL(row.url);
     if (!image || !page || seen.has(image)) continue;
     seen.add(image);
     const host = new URL(page).hostname.replace(/^www\./, '');
     const [width, height] = resolution(row.resolution);
     results.push({
       id: createHash('sha1').update(image).digest('hex'),
       title: displayTitle(row.title, host),
       image_url: image,
       thumbnail: mediaURL(row.thumbnail_src) ?? mediaURL(row.thumbnail) ?? image,
       page_url: page, source_name: host, width, height,
       engine: typeof row.engine === 'string' ? row.engine.slice(0, 60) : 'searxng',
     });
   } catch { /* One malformed entry must not discard the rest. */ }
 }

 return {query: input.q, results, next_cursor: results.length ? String(input.page + 1) : null,
   providers: [parsed.status]};
}
