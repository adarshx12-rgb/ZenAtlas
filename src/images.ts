import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { ProviderStatus } from './types.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { publicURL } from './urls.js';
import { engineStatus } from './providers.js';
import { tierSchema } from './tiers.js';
import { rewriteQuery } from './query-rewrite.js';
import { aiGenerated, excludesAI, openverseQuery, openverseResults, wantsLicense, type ImageLicense } from './image-signals.js';
import { startImageReview } from './image-review.js';

// Image search is discovery-only: results are returned straight from the engines and never
// enter the catalogue. The evidence pipeline — transcripts, moments, scene analysis — is
// video-shaped and has nothing to say about a still, so it is skipped rather than stubbed out.
//
// Reddit and Pinterest have no SearXNG engine of their own (Pinterest never shipped one, and
// the reddit module is gone from this build), but the general image engines index both, so
// their images arrive here anyway — Pinterest is consistently among the top domains returned.

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
export interface ImageSearchDeps { rewrite?: typeof rewriteQuery; review?: false | ((query: string, images: ImageResult[]) => string | null) }

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

const engineList = (engines: string) => [...new Set(engines.split(',').map(e => e.trim()).filter(Boolean))];

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

export async function searchImages(db: DB, config: Config, input: ImageSearchInput, deps: ImageSearchDeps = {}): Promise<ImageSearchResponse> {
 // What was meant rather than what was typed, as on the Web tab (the planner step for images).
 const rewrite = await (deps.rewrite ?? rewriteQuery)(db, config, input.q, 'web').catch(() => null);
 const q = rewrite?.corrected ?? input.q;
 const licensed = openverse(db, config, openverseQuery(q, rewrite?.topic ?? null), input.page);
 const found = await engineImages(db, config, {...input, q});
 const extra = await licensed;
 const seen = new Set(found.results.map(r => r.image_url));
 const fresh = extra.results.filter(r => !seen.has(r.image_url));
 // A request about licences puts licensed images first; otherwise they follow the engines' results.
 let results = wantsLicense(input.q) ? [...fresh, ...found.results] : [...found.results, ...fresh];
 results = results.map(r => aiGenerated(r.page_url, r.title) ? {...r, ai_generated: true as const} : r);
 const providers = [...found.providers, ...(extra.status ? [extra.status] : [])];
 if (excludesAI(input.q)) {
   const before = results.length;
   results = results.filter(r => !r.ai_generated);
   if (before > results.length) providers.push({provider: 'ai_filter', status: 'ok', message: `${before - results.length} images their source marks as AI-generated were left out.`});
 }
 results = results.slice(0, input.limit);
 const review = deps.review === false ? null : (deps.review ?? ((query, list) => startImageReview(db, config, query, list)))(q, results);
 return {...found, results, providers, next_cursor: found.next_cursor ?? (results.length ? String(input.page + 1) : null),
   ...(review ? {review} : {}), ...(rewrite?.changed ? {rewrite: {corrected: rewrite.corrected}} : {})};
}

async function engineImages(db: DB, config: Config, input: ImageSearchInput): Promise<ImageSearchResponse> {
 const engines = engineList(config.SEARXNG_IMAGE_ENGINES);
 if (!config.SEARXNG_BASE_URL || !engines.length) {
   return {query: input.q, results: [], next_cursor: null,
     providers: [{provider: 'searxng', status: 'disabled', message: 'Image search is not configured on this instance.'}]};
 }
 if (!await takeBudget(db, 'discovery:searxng', config.SEARXNG_DAILY_BUDGET)) {
   return {query: input.q, results: [], next_cursor: null,
     providers: [{provider: 'searxng', status: 'budget_exhausted', message: 'The daily discovery budget has been reached.'}]};
 }

 // One request for every engine, unlike video discovery's per-engine lanes: there is no
 // streaming to feed here, and SearXNG applies timeout_limit per engine, so a slow engine
 // drops out of this response instead of holding it up.
 const url = new URL('/search', config.SEARXNG_BASE_URL);
 url.search = new URLSearchParams({
   q: input.q, format: 'json', pageno: String(input.page), safesearch: '1', engines: engines.join(','),
   timeout_limit: String(Math.max(1, config.PROVIDER_TIMEOUT_MS / 1000 - 2)),
   ...(input.language ? {language: input.language} : {}),
 }).toString();

 let payload: unknown;
 try {
   payload = await fetchJSON(url.href, {trustedOrigin: url.origin, token: config.SEARXNG_TOKEN,
     timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0});
 } catch (error) {
   if (!(error instanceof UpstreamError)) throw error;
   return {query: input.q, results: [], next_cursor: null,
     providers: [{provider: 'searxng', status: 'unavailable', message: 'Image search is unavailable right now.'}]};
 }

 const parsed = z.object({results: z.array(z.unknown()).max(1000), unresponsive_engines: z.array(z.unknown()).optional()}).parse(payload);
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

 const failed = (parsed.unresponsive_engines ?? []).flatMap(entry => {
   const name = Array.isArray(entry) ? String(entry[0] ?? '') : '';
   return name ? [{engine: name, reason: 'did not answer'}] : [];
 });
 return {query: input.q, results, next_cursor: results.length ? String(input.page + 1) : null,
   providers: [engineStatus('searxng', engines, failed)]};
}
