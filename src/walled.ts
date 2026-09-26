import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON } from './http.js';
import { takeBudget } from './budgets.js';
import { PageChecker, pageTools, type PageCheck } from './pages.js';

// The login-free preview. Results from sites that put content behind a login wall (data/login-walled.json) open in a
// window on our page showing the content the engine found. The wall on the site itself is never touched: content comes
// only from the sites' official public endpoints (oEmbed, the Reddit API with our own app keys) or from what the engine
// may read anyway (page text under robots.txt, else the search snippet). Links in the preview and "Continue to site" go
// to the real site, whose login rules apply. Only URLs the engine returned can be previewed (signed tokens).

export interface WalledPreview {
 url: string; host: string; site: string;
 // complete: the official source gave the content itself; partial previews show what could be read, or the snippet.
 complete: boolean; source: 'oembed'|'api'|'page'|'snippet';
 title: string|null; author: string|null; author_url: string|null; published: string|null; text: string|null;
 links: {url: string; text: string}[]; comments: {author: string; text: string}[];
}
export type WalledDeps = {transport?: typeof fetchJSON; pages?: PageCheck};

const HOSTS: Record<string, string> = JSON.parse(readFileSync(new URL('../data/login-walled.json', import.meta.url), 'utf8')).hosts;
// The listed domain the URL's host belongs to (subdomains included), with its display name.
export function walledSite(url: string): {host: string; site: string}|null {
 let host: string;
 try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
 const listed = Object.keys(HOSTS).find(h => host === h || host.endsWith(`.${h}`));
 return listed ? {host, site: HOSTS[listed]} : null;
}

export function walledToken(secret: string, url: string) {
 return createHmac('sha256', secret).update(`walled-preview:${url}`).digest('base64url').slice(0, 32);
}
export function validWalledToken(secret: string, url: string, token: string) {
 const expected = Buffer.from(walledToken(secret, url)), given = Buffer.from(token);
 return expected.length === given.length && timingSafeEqual(expected, given);
}

// A page whose readable text is only an invitation to sign in has nothing to preview.
const LOGIN = /\b(?:log ?in|sign ?in|sign ?up|create an account)\b.{0,60}?\b(?:to (?:continue|see|view|read|access)|with (?:google|facebook|apple|email))\b/i;
export const loginPrompt = (text: string) => LOGIN.test(text);

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…'};
const decode = (s: string) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
 const code = e[0] !== '#' ? null : e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
 return code === null ? ENTITIES[e.toLowerCase()] ?? m : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const plain = (html: string) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const clip = (s: string|null|undefined, max: number) => s?.trim() ? s.trim().slice(0, max) : null;
const webLink = (href: string) => { try { const u = new URL(decode(href)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
function anchors(html: string) {
 return [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
   .flatMap(([, href, inner]) => { const url = webLink(href), text = plain(inner); return url && text ? [{url, text: text.slice(0, 200)}] : []; });
}

const oembedReply = z.looseObject({html: z.string().max(100_000).optional(), title: z.string().max(1000).optional(),
 author_name: z.string().max(300).optional(), author_url: z.string().max(1000).optional()});

// A tweet: text and links from the oEmbed blockquote's paragraph; the date is the last link after it.
async function tweet(url: string, config: Config, transport: typeof fetchJSON): Promise<Partial<WalledPreview>|null> {
 if (!/\/status(?:es)?\/\d+/.test(new URL(url).pathname)) return null;
 const api = `https://publish.x.com/oembed?${new URLSearchParams({url, omit_script: 'true', dnt: 'true'})}`;
 const reply = oembedReply.parse(await transport(api, {timeoutMs: config.PAGE_TIMEOUT_MS, redirects: 1}));
 const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(reply.html ?? '');
 if (!paragraph) return null;
 const after = (reply.html ?? '').slice(paragraph.index + paragraph[0].length);
 return {complete: true, source: 'oembed', text: clip(plain(paragraph[1]), 4000), links: anchors(paragraph[1]),
   author: clip(reply.author_name, 200), author_url: reply.author_url ? webLink(reply.author_url) : null, published: anchors(after).at(-1)?.text ?? null};
}

// Reddit: the official API with app-only OAuth when this instance has Reddit app keys; otherwise oEmbed, which names the
// post and its community but not its text.
let redditToken: {value: string; expires: number}|null = null;
const listing = z.array(z.object({data: z.object({children: z.array(z.object({kind: z.string().optional(), data: z.looseObject({})}))})})).min(1);
async function redditPost(url: string, config: Config, transport: typeof fetchJSON): Promise<Partial<WalledPreview>|null> {
 const id = /\/comments\/([a-z0-9]{1,12})(?:\/|$)/i.exec(new URL(url).pathname)?.[1];
 if (!id) return null;
 if (config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET) {
   if (!redditToken || redditToken.expires < Date.now()) {
     const reply = z.object({access_token: z.string(), expires_in: z.number()}).parse(await transport('https://www.reddit.com/api/v1/access_token', {
       method: 'POST', body: 'grant_type=client_credentials', trustedOrigin: 'https://www.reddit.com', redirects: 0, timeoutMs: config.PAGE_TIMEOUT_MS,
       headers: {Authorization: `Basic ${Buffer.from(`${config.REDDIT_CLIENT_ID}:${config.REDDIT_CLIENT_SECRET}`).toString('base64')}`,
         'Content-Type': 'application/x-www-form-urlencoded'}}));
     redditToken = {value: reply.access_token, expires: Date.now() + (reply.expires_in - 60) * 1000};
   }
   const [post, replies] = listing.parse(await transport(`https://oauth.reddit.com/comments/${id}?limit=5&depth=1&raw_json=1`, {
     trustedOrigin: 'https://oauth.reddit.com', token: redditToken.value, redirects: 0, timeoutMs: config.PAGE_TIMEOUT_MS}));
   const p = post.data.children[0]?.data as {title?: string; selftext?: string; author?: string; created_utc?: number; url?: string};
   if (!p?.title) return null;
   const link = p.url ? webLink(p.url) : null;
   return {complete: true, source: 'api', title: clip(p.title, 300), text: clip(p.selftext, 4000), author: clip(p.author, 100),
     author_url: p.author ? `https://www.reddit.com/user/${encodeURIComponent(p.author)}/` : null,
     published: p.created_utc ? new Date(p.created_utc * 1000).toISOString().slice(0, 10) : null,
     links: link && !/reddit\.com\/r\//.test(link) ? [{url: link, text: new URL(link).hostname}] : [],
     comments: (replies?.data.children ?? []).filter(c => c.kind === 't1').slice(0, 5).flatMap(c => {
       const d = c.data as {author?: string; body?: string};
       return d.body?.trim() ? [{author: d.author ?? 'someone', text: d.body.trim().slice(0, 600)}] : [];
     })};
 }
 const reply = oembedReply.parse(await transport(`https://www.reddit.com/oembed?${new URLSearchParams({url})}`, {timeoutMs: config.PAGE_TIMEOUT_MS, redirects: 1}));
 const title = anchors(reply.html ?? '')[0]?.text ?? null;
 return title ? {complete: false, source: 'oembed', title, author: clip(reply.author_name, 100)} : null;
}

// Pinterest pins and TikTok videos: their oEmbed gives the title (the pin's or video's caption) and its author.
async function oembedTitle(endpoint: string, url: string, config: Config, transport: typeof fetchJSON): Promise<Partial<WalledPreview>|null> {
 const reply = oembedReply.parse(await transport(`${endpoint}?${new URLSearchParams({url})}`, {timeoutMs: config.PAGE_TIMEOUT_MS, redirects: 1}));
 return reply.title?.trim() ? {complete: true, source: 'oembed', title: clip(plain(reply.title), 500), author: clip(reply.author_name, 200),
   author_url: reply.author_url ? webLink(reply.author_url) : null} : null;
}

async function official(url: string, host: string, config: Config, transport: typeof fetchJSON) {
 if (/(^|\.)(x|twitter)\.com$/.test(host)) return tweet(url, config, transport);
 if (/(^|\.)reddit\.com$/.test(host)) return redditPost(url, config, transport);
 if (/(^|\.)pinterest\.com$/.test(host) && /\/pin\//.test(url)) return oembedTitle('https://www.pinterest.com/oembed.json', url, config, transport);
 if (/(^|\.)tiktok\.com$/.test(host) && /\/video\//.test(url)) return oembedTitle('https://www.tiktok.com/oembed', url, config, transport);
 return null;
}

const cache = new Map<string, {preview: WalledPreview; expires: number}>();
const CACHE_MS = 30 * 60_000, CACHE_MAX = 500;
export function clearWalledCache() { cache.clear(); redditToken = null; }

export async function walledPreview(db: DB, config: Config, url: string, deps: WalledDeps = {}): Promise<WalledPreview> {
 const site = walledSite(url) ?? {host: new URL(url).hostname, site: new URL(url).hostname};
 const base: WalledPreview = {url, ...site, complete: false, source: 'snippet', title: null, author: null, author_url: null, published: null,
   text: null, links: [], comments: []};
 const hit = cache.get(url);
 if (hit && hit.expires > Date.now()) return hit.preview;
 if (!await takeBudget(db, 'walled_preview', config.WALLED_PREVIEW_DAILY_BUDGET)) return base;
 let preview = base;
 const found = await official(url, site.host, config, deps.transport ?? fetchJSON).catch(() => null);
 if (found) preview = {...base, ...found};
 // Everything else, and official sources that gave only a title: the page text, when the site lets it be read and it
 // is more than a login prompt.
 if (!preview.complete && !preview.text) {
   const pages = deps.pages ?? new PageChecker(config, undefined, {...pageTools(config), renders: 0});
   const page = await pages.check(url).catch(() => null);
   if (page?.status === 'checked' && page.text && page.text.length >= 80 && !loginPrompt(page.text))
     preview = {...preview, source: preview.source === 'snippet' ? 'page' : preview.source, title: preview.title ?? clip(page.title, 300), text: clip(page.text, 2000)};
 }
 if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
 cache.set(url, {preview, expires: Date.now() + CACHE_MS});
 return preview;
}
