import type { ImageResult } from './images.js';

// Where an image comes from decides its place. Stock previews carry watermarks and repin sites (Pinterest) re-host other
// people's pictures, so both follow the pages that published an image themselves. The focus site (IMAGE_FOCUS_SITE) leads
// SearXNG's share.

const COPY_HOSTS = /(?:^|\.)(?:pinterest\.[a-z.]+|pinimg\.com|istockphoto\.com|gettyimages\.[a-z.]+|shutterstock\.com|alamy\.com|dreamstime\.com|123rf\.com|depositphotos\.com|stock\.adobe\.com|vecteezy\.com|freepik\.com|canstockphoto\.com|bigstockphoto\.com|agefotostock\.com|stockfresh\.com|colourbox\.com)$/i;
const host = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
export const isCopy = (image: ImageResult) => COPY_HOSTS.test(host(image.page_url));
export const onSite = (image: ImageResult, site: string) => !!site && [image.page_url, image.image_url].some(u => {
 const h = host(u);
 return h === site || h.endsWith(`.${site}`);
});
// The word a search uses to name the site: "picsart" for picsart.com.
export const siteWord = (site: string) => site.split('.').slice(-2)[0] ?? site;

// Focus-site images first, then originals, then copies; search order is kept within each.
export function bySource(images: ImageResult[], focus = ''): ImageResult[] {
 const rank = (image: ImageResult) => onSite(image, focus) ? 0 : isCopy(image) ? 2 : 1;
 return images.map((image, i) => ({image, i, r: rank(image)})).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.image);
}

// Taken in turn, so neither list buries the other; an image both found keeps its first place.
export function interleaveImages(...lists: ImageResult[][]): ImageResult[] {
 const seen = new Set<string>(), out: ImageResult[] = [];
 for (let i = 0; i < Math.max(0, ...lists.map(l => l.length)); i++) for (const list of lists) {
   const r = list[i];
   if (r && !seen.has(r.image_url)) { seen.add(r.image_url); out.push(r); }
 }
 return out;
}

// A page of `limit` images, `share` percent from `a` and the rest from `b`, spread evenly through the page. Whichever list
// runs short leaves its places to the other. An image in both lists counts for `a`.
export function mergeShares(a: ImageResult[], b: ImageResult[], share: number, limit: number): ImageResult[] {
 const inA = new Set(a.map(r => r.image_url));
 const others = b.filter(r => !inA.has(r.image_url));
 const na = Math.min(a.length, Math.max(limit - others.length, Math.round(limit * share / 100)));
 const nb = Math.min(others.length, limit - na);
 const out: ImageResult[] = [];
 for (let i = 0, j = 0; i < na || j < nb;) out.push(j >= nb || (i < na && i * nb <= j * na) ? a[i++]! : others[j++]!);
 return out;
}

// How much of the query an image's caption names: the share of the query's distinctive words (a shared five-letter stem
// counts, so "poster" matches "posters") found in the title. Generic words ("art", "style", "photo") are not counted.
const GENERIC = new Set(['the', 'and', 'with', 'for', 'art', 'style', 'design', 'image', 'images', 'photo', 'photos', 'picture', 'pictures']);
const queryWords = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2 && !GENERIC.has(w));
export function captionMatch(query: string, title: string): number {
 const wanted = queryWords(query), have = queryWords(title);
 return wanted.length ? wanted.filter(w => have.some(t => t.startsWith(w.slice(0, 5)))).length / wanted.length : 1;
}

// Judged share of good images per SearXNG engine (output/searxng-image-quality-*.json); an engine not measured counts as 0.5.
const ENGINE_QUALITY: Record<string, number> = {'bing images': 0.96, 'pinterest': 0.81, 'yandex images': 0.77, 'flickr': 0.53};
// SearXNG's images, best first: the focus site leads, then engine quality plus how fully the caption names the query.
// Images from `strict` engines (and the focus site) are kept only when their caption names every word of the query.
export function rankSearxng(images: ImageResult[], query: string, focus: string, strict: Set<string>): ImageResult[] {
 return images.map((image, i) => ({image, i, match: captionMatch(query, image.title), focused: onSite(image, focus)}))
   .filter(x => !(x.focused || strict.has(x.image.engine)) || x.match >= 1)
   .map(x => ({...x, score: (x.focused ? 10 : 0) + (ENGINE_QUALITY[x.image.engine] ?? 0.5) + x.match * 0.2}))
   .sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.image);
}
