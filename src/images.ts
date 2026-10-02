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
import { aiGenerated, excludesAI, openverseQuery, openverseResults, wantsLicense, type ImageLicense } from './image-signals.js';
import { startImageReview } from './image-review.js';
import { bySource, interleaveImages, mergeShares, onSite, rankSearxng, siteWord } from './image-sources.js';
import { withSearchTrace, traceFields } from './search-trace.js';

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
 // The background review's token (src/image-review.ts), polled at /api/images/review.
 review?: string; rewrite?: {corrected: string};
}
export interface ImageSearchDeps {
 rewrite?: typeof rewriteQuery; review?: false | ((query: string, images: ImageResult[]) => string | null);
 budget?: typeof takeBudget; transport?: typeof fetchJSON;
}

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

// Brave's image index: the whole web, each planned search in turn (the second only within budget). Its image API has no
// offset, so Brave answers the first page only.
async function braveImages(db: DB, config: Config, queries: string[], input: ImageSearchInput, deps: ImageSearchDeps): Promise<{results: ImageResult[]; status: ProviderStatus|null}> {
 if (!config.BRAVE_SEARCH_API_KEY || input.page > 1) return {results: [], status: null};
 const budget = deps.budget ?? takeBudget;
 if (!await budget(db, 'discovery:brave', config.BRAVE_DAILY_BUDGET)) {
   return {results: [], status: {provider: 'brave', status: 'budget_exhausted', message: 'The daily Brave budget has been reached.'}};
 }
 const ask = async (q: string, first: boolean) => {
   if (!first && !await budget(db, 'discovery:brave', config.BRAVE_DAILY_BUDGET)) return null;
   const url = new URL('https://api.search.brave.com/res/v1/images/search');
   url.search = new URLSearchParams({q, count: String(Math.min(100, input.limit)), safesearch: 'strict',
     ...(input.language ? {search_lang: input.language.split('-')[0]!} : {})}).toString();
   return braveImageResults(await (deps.transport ?? fetchJSON)(url.href, {trustedOrigin: url.origin,
     headers: {'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY}, timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0}));
 };
 const answers = await Promise.allSettled(queries.map((q, i) => ask(q, i === 0)));
 const lists = answers.flatMap(a => a.status === 'fulfilled' && a.value ? [a.value] : []);
 if (!lists.length) return {results: [], status: {provider: 'brave', status: 'unavailable', message: 'Brave did not answer; other engines were asked.'}};
 return {results: bySource(interleaveImages(...lists)), status: {provider: 'brave', status: 'ok', message: 'Brave image search completed.'}};
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
// kept only when their caption names the whole query, best first. A second search names the focus site; the fallback
// engines are asked only when fewer than SEARXNG_IMAGE_MIN images are usable. The status shown is the main search's.
async function searxngImages(db: DB, config: Config, q: string, input: ImageSearchInput): Promise<ImageSearchResponse> {
 const focus = config.IMAGE_FOCUS_SITE;
 const strict = engineList(config.SEARXNG_IMAGE_STRICT_ENGINES);
 const focusEngines = focus ? engineList(config.SEARXNG_IMAGE_FOCUS_ENGINES) : [];
 const [main, site] = await Promise.all([engineImages(db, config, {...input, q}, [...new Set([...engineList(config.SEARXNG_IMAGE_ENGINES), ...strict])]),
   focusEngines.length ? engineImages(db, config, {...input, q: `${siteWord(focus)} ${q}`}, focusEngines) : null]);
 // Only the focus site's images count from the search that names it; the rest of that search is about the site, not the query.
 const rank = (list: ImageResult[]) => rankSearxng(interleaveImages(list), q, focus, new Set(strict));
 let results = rank([...main.results, ...(site?.results ?? []).filter(r => onSite(r, focus))]);
 const fallback = engineList(config.SEARXNG_IMAGE_FALLBACK_ENGINES);
 if (fallback.length && results.length < config.SEARXNG_IMAGE_MIN) results = rank([...results, ...(await engineImages(db, config, {...input, q}, fallback)).results]);
 return {...main, results, next_cursor: main.next_cursor ?? site?.next_cursor ?? null};
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

export const searchImages = (...args: Parameters<typeof searchImagesImpl>) => withSearchTrace(async () => Object.assign(await searchImagesImpl(...args), traceFields()));
async function searchImagesImpl(db: DB, config: Config, input: ImageSearchInput, deps: ImageSearchDeps = {}): Promise<ImageSearchResponse> {
 // What was meant rather than what was typed, plus a second search phrased the way captions describe the picture.
 const rewrite = await (deps.rewrite ?? rewriteQuery)(db, config, input.q, 'images').catch(() => null);
 const q = rewrite?.corrected ?? input.q;
 const plan = [q, ...(rewrite?.searches ?? []).slice(0, 1)];
 // Brave (the whole web), SearXNG (the focus site first) and Openverse (licensed images) are asked in parallel.
 const [found, brave, extra] = await Promise.all([searxngImages(db, config, q, input), braveImages(db, config, plan, input, deps),
   openverse(db, config, openverseQuery(q, rewrite?.topic ?? null), input.page)]);
 const providers = [...(brave.status ? [brave.status] : []), ...found.providers, ...(extra.status ? [extra.status] : [])];
 const noAI = excludesAI(input.q);
 let unmarked = 0;
 const usable = (list: ImageResult[]) => list.map(r => aiGenerated(r.page_url, r.title) ? {...r, ai_generated: true as const} : r)
   .filter(r => !(noAI && r.ai_generated && ++unmarked));
 const engines = mergeShares(usable(brave.results), usable(found.results), config.IMAGE_BRAVE_SHARE, input.limit);
 const seen = new Set(engines.map(r => r.image_url));
 const fresh = usable(extra.results).filter(r => !seen.has(r.image_url));
 // A request about licences puts licensed images first; otherwise they follow the engines' results.
 const results = (wantsLicense(input.q) ? [...fresh, ...engines] : [...engines, ...fresh]).slice(0, input.limit);
 if (unmarked) providers.push({provider: 'ai_filter', status: 'ok', message: `${unmarked} images their source marks as AI-generated were left out.`});
 const review = deps.review === false ? null : (deps.review ?? ((query, list) => startImageReview(db, config, query, list)))(q, results);
 return {...found, results, providers, next_cursor: found.next_cursor ?? (results.length ? String(input.page + 1) : null),
   ...(review ? {review} : {}), ...(rewrite?.changed ? {rewrite: {corrected: rewrite.corrected}} : {})};
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
