import type { ImageResult } from './images.js';

// Where an image comes from decides its place. Stock previews carry watermarks and repin sites (Pinterest) re-host other
// people's pictures, so both follow the pages that published an image themselves. The focus site (IMAGE_FOCUS_SITE) leads
// SearXNG's share.

const STOCK_HOSTS = /(?:^|\.)(?:istockphoto\.com|gettyimages\.[a-z.]+|shutterstock\.com|alamy\.com|dreamstime\.com|123rf\.com|depositphotos\.com|stock\.adobe\.com|vecteezy\.com|freepik\.com|canstockphoto\.com|bigstockphoto\.com|agefotostock\.com|stockfresh\.com|colourbox\.com|yayimages\.com|pond5\.com|storyblocks\.com|megapixl\.com|stocksy\.com)$/i;
const REPIN_HOSTS = /(?:^|\.)(?:pinterest\.[a-z.]+|pinimg\.com|artofit\.org|inspiredpencil\.com|pngtree\.com|cleanpng\.com|pngwing\.com|pngegg\.com|kindpng\.com|pngitem\.com|klipartz\.com|t\.me|aidph\.org|ar\.inspiredpencil\.com)$/i;
const SHOP_HOSTS = /(?:^|\.)(?:redbubble\.com|society6\.com|teepublic\.com|zazzle\.[a-z.]+|displate\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|aliexpress\.[a-z]+|temu\.com|etsy\.com|walmart\.com|shein\.com|wish\.com|moryarty\.com|1999\.co\.jp|japan-figure\.com|desenio\.[a-z.]+|juniqe\.[a-z.]+|posterlounge\.[a-z.]+|fineartamerica\.com|cafepress\.com|spreadshirt\.[a-z.]+)$/i;
const WALLPAPER_HOSTS = /(?:^|\.)(?:wallpapers\.com|alphacoders\.com|backiee\.com|wallpaperaccess\.com|wallpapercave\.com|wallpaperflare\.com|hdqwalls\.com|wallhaven\.cc|wallpapersden\.com|wallpaperbat\.com|peakpx\.com|wallpapersafari\.com|uhdpaper\.com)$/i;
const host = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
// Stock previews and repins: copies of a picture someone else published (they lose to the original among duplicates).
export const isCopy = (image: ImageResult) => STOCK_HOSTS.test(host(image.page_url)) || REPIN_HOSTS.test(host(image.page_url));

// A weak source: a stock preview (watermarked), a repin or scraper site, a shop's product mockup, a wallpaper farm, or a
// picture too small to look at. Each kind is fine when the request asks for it ("stock photo", "buy", "wallpaper").
const MIN_SIDE = 300;
export function weakSource(image: ImageResult, query = ''): boolean {
 const h = host(image.page_url), q = query.toLowerCase();
 if (image.width && image.height && Math.min(image.width, image.height) < MIN_SIDE) return true;
 if (STOCK_HOSTS.test(h)) return !/\bstock\b|royalty|licen[cs]/.test(q);
 if (SHOP_HOSTS.test(h)) return !/\b(?:buy|shop|price|merch|for sale|figure|figurine|product|t-?shirt|mug)s?\b/.test(q);
 if (WALLPAPER_HOSTS.test(h)) return !/wallpaper|background|desktop|phone lock ?screen/.test(q);
 return REPIN_HOSTS.test(h);
}
// Strong sources first, weak ones after; order is kept within each.
export const strongFirst = (images: ImageResult[], query: string) =>
 [...images.filter(i => !weakSource(i, query)), ...images.filter(i => weakSource(i, query))];

// Judged images in page order: a weak source counts WEAK_PENALTY points below its relevance, and a site's images after its
// first PER_HOST go after the rest of the page, so one site does not fill it.
const WEAK_PENALTY = 2, PER_HOST = 3;
export function pageOrder<T extends {image: ImageResult; relevance: number; i: number}>(rows: T[], query: string): T[] {
 const sorted = rows.map(r => ({r, s: r.relevance - (weakSource(r.image, query) ? WEAK_PENALTY : 0)}))
   .sort((a, b) => b.s - a.s || Number(isCopy(a.r.image)) - Number(isCopy(b.r.image)) || a.r.i - b.r.i).map(x => x.r);
 const count = new Map<string, number>(), first: T[] = [], later: T[] = [];
 for (const r of sorted) {
   const h = host(r.image.page_url).replace(/^www\./, ''), n = (count.get(h) ?? 0) + 1;
   count.set(h, n);
   (n > PER_HOST ? later : first).push(r);
 }
 return [...first, ...later];
}
export const onSite = (image: ImageResult, site: string) => !!site && [image.page_url, image.image_url].some(u => {
 const h = host(u);
 return h === site || h.endsWith(`.${site}`);
});
// The word a search uses to name the site: "picsart" for picsart.com.
export const siteWord = (site: string) => site.split('.').slice(-2)[0] ?? site;

// Focus-site images first, then originals, then weak sources; search order is kept within each.
export function bySource(images: ImageResult[], focus = '', query = ''): ImageResult[] {
 const rank = (image: ImageResult) => onSite(image, focus) ? 0 : weakSource(image, query) ? 2 : 1;
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
