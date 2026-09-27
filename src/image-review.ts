import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { fetchImage } from './http.js';
import { makeJudge, TANGENTIAL, type Judge, type JudgeCandidate, type JudgeContext } from './judge.js';
import { cascadeOptions, cascadeReview, makeStrongJudge } from './cascade.js';
import type { ImageResult } from './images.js';

// The Images tab's review, run in the background like the Web tab's: the judge sees each image's thumbnail (the judge
// models take images) with its title and host as context, and removes what the image does not show. The cascade's Strong
// judge re-checks uncertain verdicts with the same thumbnails. An image whose thumbnail could not be fetched as a JPEG is
// judged on its title and host alone and marked unseen.

export type ReviewedImage = ImageResult & {judgement?: {relevance: number; reason: string}; unseen?: true};
export interface ImageReviewState { status: 'running'|'complete'; results: ReviewedImage[]; removed: number; providers: ProviderStatus[] }
export interface ImageReviewDeps { judge?: Judge; strong?: Judge|null; thumbnail?: (url: string) => Promise<{contentType: string; data: Buffer}>; log?: (line: Record<string, unknown>) => void }

// The top of a results page is what gets judged; the rest keeps its search order after the judged ones.
const REVIEW_POOL = 24, BATCH = 6, THUMB_MAX = 400 * 1024;
const CRITERIA = ['An image whose visible content shows what the request describes. Judge from the image itself (its screenshot); the title and host are context, not proof',
 'Text, labels or a chart inside the image count when they are readable in the image',
 'Watermarked stock previews, illustrations and AI-generated images match only when the request allows them'];

export async function reviewImages(db: DB, config: Config, query: string, images: ImageResult[], deps: ImageReviewDeps & {judge: Judge}):
 Promise<{results: ReviewedImage[]; removed: number; providers: ProviderStatus[]}> {
 const providers: ProviderStatus[] = [];
 const pool = images.slice(0, REVIEW_POOL), rest = images.slice(REVIEW_POOL);
 const fetchThumb = deps.thumbnail ?? (url => fetchImage(url, {timeoutMs: 4000, maxBytes: THUMB_MAX}));
 const shots = new Map<string, Buffer>();
 await Promise.all(pool.map(async (image, i) => {
   const got = await fetchThumb(image.thumbnail).catch(() => null);
   // The judge clients send images as JPEG; other formats are judged without their picture.
   if (got && got.contentType === 'image/jpeg' && got.data.length <= THUMB_MAX) shots.set(`i${i + 1}`, got.data);
 }));
 const candidates: JudgeCandidate[] = pool.map((image, i) => {
   const key = `i${i + 1}`, seen = shots.has(key);
   return {key, kind: 'website', site: image.source_name, url: image.page_url, title: image.title, channel: null, official: false, duration: null, live: null,
     description: image.license ? `Licence: ${image.license.name}${image.license.creator ? ` by ${image.license.creator}` : ''}` : null,
     comments: [], moments: [], discussions: [],
     ...(seen ? {page: {status: 'checked' as const, title: image.title, description: null, text: null, libraries: [], screenshot: true}} : {})};
 });
 const context: JudgeContext = {kind: 'websites', criteria: CRITERIA};
 const done = await Promise.allSettled(Array.from({length: Math.ceil(candidates.length / BATCH)}, (_, b) => candidates.slice(b * BATCH, (b + 1) * BATCH))
   .map(batch => deps.judge.judge(query, batch, context, shots)));
 const verdicts = new Map(done.flatMap(d => d.status === 'fulfilled' ? [...d.value.verdicts] : []));
 if (!verdicts.size) {
   providers.push({provider: 'judge', status: 'unavailable', message: 'Images could not be checked right now; they are shown in search order.'});
   return {results: images as ReviewedImage[], removed: 0, providers};
 }
 const strong = 'strong' in deps ? deps.strong : makeStrongJudge(db, config);
 const final = strong ? await cascadeReview(query, candidates, verdicts, undefined, context, shots, strong, {...cascadeOptions(config), log: deps.log}) : null;
 if (final) providers.push(...final.providers);
 const scored = pool.map((image, i) => ({image, i, v: (final?.verdicts ?? verdicts).get(`i${i + 1}`), seen: shots.has(`i${i + 1}`)}));
 const kept = scored.filter(s => s.v && s.v.relevance > TANGENTIAL).sort((a, b) => b.v!.relevance - a.v!.relevance || a.i - b.i);
 const unjudged = scored.filter(s => !s.v), removed = scored.length - kept.length - unjudged.length;
 providers.push({provider: 'judge', status: 'ok', message: `${pool.length} images were checked by looking at them (${shots.size} seen); ${removed} did not match.`});
 (deps.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`)))({event: 'image_review', tier: config.TIER, judged: pool.length, seen: shots.size, removed});
 const out = (s: typeof scored[number]): ReviewedImage => ({...s.image, ...(s.v ? {judgement: {relevance: s.v.relevance, reason: s.v.reason}} : {}), ...(s.seen ? {} : {unseen: true as const})});
 return {results: [...kept.map(out), ...unjudged.map(out), ...rest], removed, providers};
}

// Reviews wait here by token for the page to poll, for ten minutes.
const reviews = new Map<string, {state: ImageReviewState; expires: number}>();
const REVIEW_MS = 10 * 60_000, MAX_REVIEWS = 200, MAX_RUNNING = 4;
let running = 0;
export function imageReviewState(token: string): ImageReviewState|null {
 const review = reviews.get(token);
 return review && review.expires >= Date.now() ? review.state : null;
}

export function startImageReview(db: DB, config: Config, query: string, images: ImageResult[], deps: ImageReviewDeps = {}): string|null {
 if (!config.IMAGE_REVIEW_ENABLED || !images.length) return null;
 const judge = 'judge' in deps ? deps.judge : makeJudge(db, config);
 if (!judge) return null;
 const now = Date.now();
 for (const [token, r] of reviews) if (r.expires < now || reviews.size >= MAX_REVIEWS) reviews.delete(token);
 const token = randomUUID();
 const state: ImageReviewState = {status: 'running', results: images, removed: 0, providers: []};
 reviews.set(token, {state, expires: now + REVIEW_MS});
 if (running >= MAX_RUNNING) {
   state.status = 'complete';
   state.providers.push({provider: 'image_review', status: 'unavailable', message: 'The server is busy; images were not checked.'});
   return token;
 }
 running++;
 void reviewImages(db, config, query, images, {...deps, judge})
   .then(out => Object.assign(state, {results: out.results, removed: out.removed, providers: out.providers}))
   .catch(() => state.providers.push({provider: 'image_review', status: 'unavailable', message: 'Image checking stopped early; images are shown in search order.'}))
   .finally(() => { running--; state.status = 'complete'; });
 return token;
}
