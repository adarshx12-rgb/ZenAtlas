import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { fetchImage } from './http.js';
import { makeJudge, visualReference, TANGENTIAL, type Judge, type JudgeCandidate, type JudgeContext } from './judge.js';
import { cascadeOptions, cascadeReview, makeStrongJudge } from './cascade.js';
import type { ImageResult } from './images.js';
import type { ImageMime } from './model-client.js';
import { planContract, judgeRequirements, type ContractDeps } from './search-contract.js';
import { makeJevJudge } from './jev-judge.js';
import { makeScreener, screeningOrder, type Screener } from './screener.js';
import { contentInput } from './types.js';
import { missingRequirements } from './cascade.js';
import { PageChecker, pageTools, type PageCheck } from './pages.js';
import { collapseDuplicates, differenceHash } from './image-duplicates.js';
import { pageOrder, strongFirst } from './image-sources.js';

// The Images tab's review, run in the background like the Web tab's: the judge sees each image's thumbnail (the judge
// models take images) with its title and host as context, and removes what the image does not show. The cascade's Strong
// judge re-checks interpretation disputes. Missing pixels or provenance first trigger bounded evidence collection.

export type ReviewedImage = ImageResult & {judgement?: {relevance: number; reason: string}; unseen?: true;
 verification?: 'verified'|'uncertain'; unmet_requirements?: string[]; ai_status?: 'source_marked'|'unknown'};
// stage: where the job is, for the page's progress line. next_cursor and rewrite arrive with the results.
export interface ImageReviewState { status: 'running'|'complete'; stage: 'searching'|'checking'|'done'; results: ReviewedImage[]; removed: number;
 providers: ProviderStatus[]; next_cursor: string|null; rewrite?: {corrected: string} }
export interface ImageReviewDeps extends ContractDeps { judge?: Judge; strong?: Judge|null; screener?: Screener; pages?: PageCheck; thumbnail?: (url: string) => Promise<{contentType: string; data: Buffer}>; log?: (line: Record<string, unknown>) => void }

// The best config.IMAGE_JUDGE_POOL images (after screening) are judged. DUPLICATE_SPARE more thumbnails are fetched so
// that pictures collapsed as copies are replaced in the judged pool.
const DUPLICATE_SPARE = 12, BATCH = 6, THUMB_MAX = 400 * 1024;
export function imageMime(data: Buffer): ImageMime|null {
 if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
 if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
 if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
 if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return 'image/gif';
 return null;
}
const CRITERIA = ['An image whose visible content shows what the request describes. Judge from the image itself (its screenshot); the title and host are context, not proof',
 'Text, labels or a chart inside the image count when they are readable in the image',
 'Watermarked stock previews, illustrations and AI-generated images match only when the request allows them',
 'An image of a different work, person, place or thing than the request names does not match, even when it looks similar'];

// onlyJudged: the page shows judged images only, so images beyond the judged pool are left out rather than appended.
export async function reviewImages(db: DB, config: Config, query: string, images: ImageResult[], deps: ImageReviewDeps & {judge: Judge; onlyJudged?: boolean}):
 Promise<{results: ReviewedImage[]; removed: number; providers: ProviderStatus[]}> {
 const providers: ProviderStatus[] = [];
 const REVIEW_POOL = config.IMAGE_JUDGE_POOL;
 const contract = await planContract(db, config, query, 'images', deps);
 const screener = 'screener' in deps ? deps.screener : makeScreener(db, config);
 let ordered = images;
 if (screener && images.length > REVIEW_POOL) {
   try {
     const leads = images.map((image, position) => ({item: contentInput.parse({url: image.image_url, title: image.title}), provider: image.engine, position, image}));
     const screened = await screener.screen(query, leads, {requirements: judgeRequirements(contract), formats: ['image'], search_date: contract.search_date});
     ordered = screeningOrder(leads, screened.promising).map(c => c.image);
   } catch { providers.push({provider: 'jev_screener', status: 'unavailable', message: 'Images were checked in search order.'}); }
 }
 // Weak sources (stock previews, repins, shops, wallpaper farms, tiny pictures) are judged only where originals run short.
 ordered = strongFirst(ordered, query);
 const fetchThumb = deps.thumbnail ?? (url => fetchImage(url, {timeoutMs: 4000, maxBytes: THUMB_MAX}));
 const thumb = async (url: string) => {
   const got = await fetchThumb(url).catch(() => null);
   const mime = got && imageMime(got.data);
   return got && mime && got.data.length <= THUMB_MAX ? {data: got.data, mime} : null;
 };
 // Copies of one picture are collapsed before judging, so the pool holds REVIEW_POOL different pictures where it can.
 const window = ordered.slice(0, REVIEW_POOL + DUPLICATE_SPARE);
 const thumbs = await Promise.all(window.map(image => thumb(image.thumbnail)));
 const hashes = await Promise.all(thumbs.map(t => t ? differenceHash(t.data) : null));
 const {kept: unique, dropped: duplicates} = collapseDuplicates(window.map((image, i) => ({...image, thumb: thumbs[i]})), hashes);
 const pool = unique.slice(0, REVIEW_POOL).map(({thumb: _, ...image}) => image);
 const rest = [...unique.slice(REVIEW_POOL).map(({thumb: _, ...image}) => image), ...ordered.slice(window.length)];
 const shots = new Map<string, Buffer>();
 const visuals = new Map<string, NonNullable<JudgeCandidate['visual']>>();
 const keep = (key: string, got: {data: Buffer; mime: ImageMime}) => { shots.set(key, got.data); visuals.set(key, visualReference(got.data, got.mime)); };
 unique.slice(0, REVIEW_POOL).forEach((image, i) => { if (image.thumb) keep(`i${i + 1}`, image.thumb); });
 const load = async (url: string, key: string, signal?: AbortSignal) => {
   const got = await thumb(url);
   if (!got || signal?.aborted) return false;
   keep(key, got); return true;
 };
 const candidates: JudgeCandidate[] = pool.map((image, i) => {
   const key = `i${i + 1}`, seen = shots.has(key);
   return {key, kind: 'website', site: image.source_name, url: image.page_url, title: image.title, channel: null, official: false, duration: null, live: null,
     description: image.license ? `Licence: ${image.license.name}${image.license.creator ? ` by ${image.license.creator}` : ''}` : null,
     provenance: [image.license ? `Licence: ${image.license.name}. Licence URL: ${image.license.url}. Creator: ${image.license.creator ?? 'unknown'}. Attribution: ${image.license.attribution ?? 'unknown'}.` : '',
       image.ai_generated ? 'The source explicitly labels this image AI-generated.' : ''].filter(Boolean).join(' '),
     visual: visuals.get(key),
     facts: contract.requirements.filter(r => r.kind === 'format' && r.formats?.includes('image')).map(r =>
       ({id: r.id, status: seen ? 'supported' as const : 'unknown' as const, field: 'facts', quote: `${r.id}: ${seen ? 'Inspected image pixels' : 'Image unavailable'}`})),
     comments: [], moments: [], discussions: [],
     ...(seen ? {page: {status: 'checked' as const, title: image.title, description: null, text: null, libraries: [], screenshot: true}} : {})};
 });
 const context: JudgeContext = {kind: 'websites', criteria: CRITERIA, requirements: judgeRequirements(contract), search_date: contract.search_date};
 // Jev can check textual provenance; image properties always proceed to the model that sees the pixels.
 const judge = makeJevJudge(db, config, deps.judge, {settle: false}) ?? deps.judge;
 const done = await Promise.allSettled(Array.from({length: Math.ceil(candidates.length / BATCH)}, (_, b) => candidates.slice(b * BATCH, (b + 1) * BATCH))
   .map(batch => judge.judge(query, batch, context, shots)));
 const verdicts = new Map(done.flatMap(d => d.status === 'fulfilled' ? [...d.value.verdicts] : []));
 const jev = new Map(done.flatMap(d => d.status === 'fulfilled' ? [...d.value.jev ?? []] : []));
 if (!verdicts.size) {
   providers.push({provider: 'judge', status: 'unavailable', message: 'Images could not be checked right now; they are shown in search order.'});
   return {results: [...pool, ...rest] as ReviewedImage[], removed: 0, providers};
 }
 const strong = 'strong' in deps ? deps.strong : makeStrongJudge(db, config);
 let provenancePages = deps.pages;
 const final = strong ? await cascadeReview(query, candidates, verdicts, jev, context, shots, strong, {...cascadeOptions(config), log: deps.log,
   inspection: {judge, inspect: async (c, missing, signal) => {
     const image = pool[candidates.findIndex(x => x.key === c.key)];
     if (!image) return null;
     let next = c;
     const needs = context.requirements!.filter(r => missing.includes(r.id));
     if ((!c.visual || needs.some(r => r.evidence_kind === 'visual')) && image.image_url !== image.thumbnail && await load(image.image_url, c.key, signal))
       next = {...next, visual: visuals.get(c.key), page: {...c.page, status: 'checked', title: image.title, description: c.page?.description ?? null, text: c.page?.text ?? null, libraries: [], screenshot: true},
         facts: c.facts?.map(f => ({...f, status: 'supported', quote: `${f.id}: Inspected image pixels`}))};
     if (needs.some(r => r.evidence_kind === 'provenance') && !c.page?.text && !signal.aborted) {
       provenancePages ??= new PageChecker(config, undefined, {...pageTools(config), renders: 0});
       const page = await provenancePages.check(image.page_url).catch(() => null);
       if (page?.status === 'checked' && page.text && !signal.aborted)
         next = {...next, page: {status: 'checked', title: page.title, description: page.description, text: page.text, libraries: [], screenshot: !!next.visual}};
     }
     return signal.aborted || next === c ? null : next;
   }}}) : null;
 if (final) providers.push(...final.providers);
 const scored = pool.map((image, i) => ({image, i, v: (final?.verdicts ?? verdicts).get(`i${i + 1}`), seen: shots.has(`i${i + 1}`)}));
 // Weak sources rank below originals that match as well or nearly as well, and no site fills the page (pageOrder).
 const kept = pageOrder(scored.filter(s => s.v && s.v.relevance > TANGENTIAL).map(s => ({...s, relevance: s.v!.relevance})), query);
 const unjudged = scored.filter(s => !s.v), removed = scored.length - kept.length - unjudged.length;
 providers.push({provider: 'judge', status: 'ok', message: `${pool.length} images were checked by looking at them (${shots.size} seen); ${removed} did not match.`});
 (deps.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`)))({event: 'image_review', tier: config.TIER, collected: images.length, judged: pool.length, seen: shots.size, removed, duplicates});
 const out = (s: typeof scored[number]): ReviewedImage => {
   const candidate = (final?.candidates ?? candidates)[s.i];
   const missing = s.v ? missingRequirements(candidate, s.v, context.requirements) : context.requirements!.map(r => r.id);
   return {...s.image, ...(s.v ? {judgement: {relevance: s.v.relevance, reason: s.v.reason}} : {}), ...(s.seen ? {} : {unseen: true as const}),
     verification: missing.length || !s.seen || (s.v?.relevance ?? 0) <= 5 ? 'uncertain' : 'verified',
     unmet_requirements: context.requirements!.filter(r => missing.includes(r.id)).map(r => r.text), ai_status: s.image.ai_generated ? 'source_marked' : 'unknown'};
 };
 return {results: [...kept.map(out), ...unjudged.map(out), ...(deps.onlyJudged ? [] : rest.map(image => ({...image, verification: 'uncertain' as const,
   unseen: true as const, ai_status: image.ai_generated ? 'source_marked' as const : 'unknown' as const})))], removed, providers};
}

// Jobs wait here by token for the page to poll, for ten minutes.
const reviews = new Map<string, {state: ImageReviewState; expires: number}>();
const REVIEW_MS = 10 * 60_000, MAX_REVIEWS = 200, MAX_RUNNING = 6;
let running = 0;
export function imageReviewState(token: string): ImageReviewState|null {
 const review = reviews.get(token);
 return review && review.expires >= Date.now() ? review.state : null;
}

// The Images job: collect (plan, searches, pool), then review, and only then show results. null when there is no judge,
// so the search answers with the collected images itself. When the server is busy or the review fails, the collected
// images are shown in search order with a notice: a search always ends with results when any were found.
export function startImageJob(db: DB, config: Config, query: string, limit: number,
 collect: () => Promise<{plan: {corrected: string; changed: boolean}; images: ImageResult[]; providers: ProviderStatus[]; next_cursor: string|null}>,
 deps: ImageReviewDeps = {}): string|null {
 if (!config.IMAGE_REVIEW_ENABLED) return null;
 const judge = 'judge' in deps ? deps.judge : makeJudge(db, config);
 if (!judge) return null;
 const now = Date.now();
 for (const [token, r] of reviews) if (r.expires < now || reviews.size >= MAX_REVIEWS) reviews.delete(token);
 const token = randomUUID();
 const state: ImageReviewState = {status: 'running', stage: 'searching', results: [], removed: 0, providers: [], next_cursor: null};
 reviews.set(token, {state, expires: now + REVIEW_MS});
 const busy = running >= MAX_RUNNING;
 running++;
 void (async () => {
   const found = await collect();
   Object.assign(state, {providers: found.providers, next_cursor: found.next_cursor, ...(found.plan.changed ? {rewrite: {corrected: found.plan.corrected}} : {})});
   if (!found.images.length) return;
   if (busy) {
     state.results = found.images.slice(0, limit);
     state.providers.push({provider: 'image_review', status: 'unavailable', message: 'The server is busy; images were not checked.'});
     return;
   }
   state.stage = 'checking';
   try {
     const out = await reviewImages(db, config, found.plan.corrected, found.images, {...deps, judge, onlyJudged: true});
     Object.assign(state, {results: out.results.slice(0, limit), removed: out.removed, providers: [...found.providers, ...out.providers]});
   } catch {
     state.results = found.images.slice(0, limit);
     state.providers.push({provider: 'image_review', status: 'unavailable', message: 'Image checking stopped early; images are shown in search order.'});
   }
 })().catch(() => state.providers.push({provider: 'image_search', status: 'unavailable', message: 'Image search failed; try again.'}))
   .finally(() => { running--; state.status = 'complete'; state.stage = 'done'; });
 return token;
}
