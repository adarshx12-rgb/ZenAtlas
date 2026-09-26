import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { ProviderStatus } from './types.js';
import { fetchJSON } from './http.js';
import { takeBudget } from './budgets.js';
import { publicURL } from './urls.js';
import { engineStatus } from './providers.js';
import { accessKind, accessLabel } from './access.js';
import { previewToken } from './doc-preview.js';
import { verifyDocuments, type VerifiedDoc } from './doc-review.js';
import { startHunt } from './doc-hunt.js';
import { findDocuments, type SourceFindings } from './doc-sources.js';
import { viewerOf } from './doc-viewers.js';
import { refreshBlocklists, unsafeLink } from './safety.js';
import { startWebReview } from './web-review.js';
import { walledSite, walledToken } from './walled.js';
import type { PeekResponse } from './http.js';

// Web and document search are discovery-only, like image search: results come straight from the engines and never
// enter the catalogue. Brave answers first; SearXNG fills in when Brave is missing, fails or finds too little.
// Shadow libraries (data/access-sources.json) are dropped here as everywhere else. Documents are then verified (spam,
// dead links and pages posing as files removed), and a document hunt starts (src/doc-hunt.ts): on the first page Jev looks
// inside the websites the search found, then everything found is reviewed. The page polls /api/docs/hunt with its token.

const DOCUMENT_TYPES = {
 pdf: ['pdf'], word: ['doc', 'docx', 'odt', 'rtf'], slides: ['ppt', 'pptx', 'odp', 'key'],
 sheets: ['xls', 'xlsx', 'ods', 'csv'], ebook: ['epub'],
} as const;
type DocumentGroup = keyof typeof DOCUMENT_TYPES;
const ALL_EXTENSIONS: readonly string[] = Object.values(DOCUMENT_TYPES).flat();
// Hosts that serve PDFs from extension-less paths such as arxiv.org/pdf/2401.00001.
const PDF_PATHS: Record<string, RegExp> = {'arxiv.org': /^\/pdf(\/|$)/, 'openreview.net': /^\/pdf\/?$/};

export const webSearchInput = z.object({
 q: z.string().transform(v => v.normalize('NFC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(400)),
 kind: z.enum(['web', 'docs']).default('web'),
 doc_type: z.enum(['any', ...Object.keys(DOCUMENT_TYPES) as [DocumentGroup, ...DocumentGroup[]]]).default('any'),
 language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
 page: z.coerce.number().int().min(1).max(10).default(1),
}).strict();
export type WebSearchInput = z.infer<typeof webSearchInput>;

export interface WebResult {
 id: string; title: string; url: string; source_name: string; snippet: string | null;
 published: string | null; doc_type: string | null; access: string | null; engine: string;
 // Signed permission for /api/doc to fetch and show this document; null when it cannot be previewed here.
 preview: string | null;
 // Documents only: 'checked' when the file was confirmed to be a document, 'blocked' when its site refused the check.
 check?: 'checked' | 'blocked';
 // doc_type 'viewer': the site that shows the document in its own reader (Scribd, SlideShare, Google Docs...).
 viewer?: string;
 // Set by a relevance review (the Docs hunt, the Web review).
 judgement?: {relevance: number; reason: string};
 // A login-walled site's result: opens in the login-free preview (/api/walled with this token).
 walled?: {site: string; host: string; token: string};
}
// hunt: a token for /api/docs/hunt, which reports documents found inside websites and the review of every document.
// review (web only): a token for /api/web/review, which removes pages that do not match and ranks the rest.
export interface WebSearchResponse { query: string; results: WebResult[]; providers: ProviderStatus[]; next_cursor: string | null; hunt?: string | null; review?: string }

// The file type a URL serves, from its path alone: a query string such as ?file=x.pdf names a viewer page, not a document.
export function documentType(url: string): string | null {
 try {
   const u = new URL(url), host = u.hostname.toLowerCase().replace(/^www\./, '');
   const ext = /\.([a-z0-9]{2,4})$/i.exec(decodeURIComponent(u.pathname))?.[1]?.toLowerCase();
   if (ext && ALL_EXTENSIONS.includes(ext)) return ext;
   return PDF_PATHS[host]?.test(u.pathname) ? 'pdf' : null;
 } catch { return null; }
}

// Some links to a document open a viewer page around it; point at the file itself so one click opens the document.
export function directFile(url: string) {
 const github = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.split(/[?#]/)[0]);
 return github ? `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}` : url;
}

const plain = (value: unknown, max: number) => {
 if (typeof value !== 'string') return null;
 const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
 const text = value.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
   const code = e[0] !== '#' ? null : e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
   return code === null ? named[e.toLowerCase()] ?? m : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
 })
   .replace(/\s+/g, ' ').trim();
 return text ? text.slice(0, max) : null;
};
const isoDate = (value: unknown) => { const d = typeof value === 'string' ? new Date(value) : null; return d && !isNaN(+d) ? d.toISOString() : null; };

type Row = {url: string; title: unknown; snippet: unknown; published: unknown; engine: string};
type Deps = {transport: typeof fetchJSON; budget: (db: DB, key: string, limit: number) => Promise<boolean>;
 peek?: (url: string, options: {timeoutMs: number}) => Promise<PeekResponse>;
 hunt?: (query: string, docs: VerifiedDoc[], explore: boolean, sites: WebResult[]) => string;
 sources?: (db: DB, config: Config, query: string) => Promise<SourceFindings>;
 // false: no relevance review (the Docs hunt's own web search).
 review?: false | ((query: string, results: WebResult[]) => string | null)};

export async function searchWeb(db: DB, config: Config, input: WebSearchInput,
 deps: Deps = {transport: fetchJSON, budget: takeBudget}): Promise<WebSearchResponse> {
 const docs = input.kind === 'docs';
 const wanted: readonly string[] = docs ? (input.doc_type === 'any' ? ALL_EXTENSIONS : DOCUMENT_TYPES[input.doc_type]) : [];
 // Engines honour filetype: but an OR'd list drifts towards PDF, so the type filter narrows the query too.
 const query = docs ? `${input.q} (${wanted.filter(e => e !== 'csv').map(e => `filetype:${e}`).join(' OR ')})` : input.q;
 const providers: ProviderStatus[] = [];
 const results: WebResult[] = [];
 const seen = new Set<string>();
 let more = false, unsafe = 0;
 // Documents are also looked for directly in free-document sources, alongside the engines (first page only).
 const sourcesTask = docs && input.page === 1 ? (deps.sources ?? findDocuments)(db, config, input.q).catch((): SourceFindings => ({docs: [], sites: [], providers: []})) : null;
 if (docs) void refreshBlocklists(config).catch(() => {});

 const keep = (rows: Row[]) => {
   for (const row of rows) {
     let url: string;
     try { url = publicURL(directFile(row.url)).href; } catch { continue; }
     if (url.length > 2048 || seen.has(url)) continue;
     const kind = accessKind(url);
     if (kind === 'unauthorized') continue;
     // Documents: a file of a wanted type, or a viewer page of one (Scribd, SlideShare...); never a malware, phishing or
     // explicit link.
     const viewer = docs && !documentType(url) ? viewerOf(url) : null;
     const type = documentType(url) ?? (viewer ? 'viewer' : null);
     if (docs && (!type || (viewer ? input.doc_type !== 'any' && viewer.group !== input.doc_type : !wanted.includes(type)))) continue;
     if (docs && unsafeLink(url, typeof row.title === 'string' ? row.title : '')) { unsafe++; continue; }
     seen.add(url);
     const host = new URL(url).hostname.replace(/^www\./, '');
     const walled = !docs && config.WALLED_PREVIEW_ENABLED ? walledSite(url) : null;
     results.push({id: createHash('sha1').update(url).digest('hex'), url, source_name: host,
       title: plain(row.title, 300) ?? host, snippet: plain(row.snippet, 600), published: isoDate(row.published),
       doc_type: type, access: accessLabel(kind), engine: row.engine, ...(viewer ? {viewer: viewer.name} : {}),
       ...(walled ? {walled: {...walled, token: walledToken(config.SESSION_SECRET, url)}} : {}),
       preview: type && type !== 'epub' && type !== 'viewer' && (type === 'pdf' || config.DOC_PREVIEW_CONVERTER) ? previewToken(config.SESSION_SECRET, url) : null});
   }
 };

 if (config.BRAVE_SEARCH_API_KEY) {
   if (!await deps.budget(db, 'discovery:brave', config.BRAVE_DAILY_BUDGET)) {
     providers.push({provider: 'brave', status: 'budget_exhausted', message: 'The daily Brave budget has been reached.'});
   } else try {
     const url = new URL('https://api.search.brave.com/res/v1/web/search');
     url.search = new URLSearchParams({q: query, count: '20', offset: String(input.page - 1), safesearch: docs ? 'strict' : 'moderate',
       text_decorations: 'false', ...(input.language ? {search_lang: input.language.split('-')[0]} : {})}).toString();
     const data = z.object({web: z.object({results: z.array(z.unknown()).max(100)}).optional(),
       query: z.object({more_results_available: z.boolean().optional()}).optional()})
       .parse(await deps.transport(url.href, {trustedOrigin: url.origin, headers: {'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY},
         timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0}));
     keep((data.web?.results ?? []).flatMap(raw => {
       const r = z.looseObject({url: z.string()}).safeParse(raw);
       return r.success ? [{url: r.data.url, title: r.data.title, snippet: r.data.description, published: r.data.page_age, engine: 'brave'}] : [];
     }));
     more = data.query?.more_results_available === true;
     providers.push({provider: 'brave', status: 'ok', message: 'Brave search completed.'});
   } catch {
     providers.push({provider: 'brave', status: 'unavailable', message: 'Brave did not answer; other engines were asked.'});
   }
 }

 if (config.SEARXNG_BASE_URL && results.length < config.BRAVE_MIN_RESULTS) {
   const engines = [...new Set(config.SEARXNG_WEB_ENGINES.split(',').map(e => e.trim()).filter(Boolean))];
   if (!await deps.budget(db, 'discovery:searxng', config.SEARXNG_DAILY_BUDGET)) {
     providers.push({provider: 'searxng', status: 'budget_exhausted', message: 'The daily discovery budget has been reached.'});
   } else try {
     const url = new URL('/search', config.SEARXNG_BASE_URL);
     url.search = new URLSearchParams({q: query, format: 'json', pageno: String(input.page), safesearch: docs ? '2' : '1', engines: engines.join(','),
       timeout_limit: String(Math.max(1, config.PROVIDER_TIMEOUT_MS / 1000 - 2)), ...(input.language ? {language: input.language} : {})}).toString();
     const data = z.object({results: z.array(z.unknown()).max(1000), unresponsive_engines: z.array(z.unknown()).optional()})
       .parse(await deps.transport(url.href, {trustedOrigin: url.origin, token: config.SEARXNG_TOKEN, timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0}));
     const before = results.length;
     keep(data.results.flatMap(raw => {
       const r = z.looseObject({url: z.string()}).safeParse(raw);
       return r.success ? [{url: r.data.url, title: r.data.title, snippet: r.data.content, published: r.data.publishedDate,
         engine: typeof r.data.engine === 'string' ? r.data.engine.slice(0, 60) : 'searxng'}] : [];
     }));
     more ||= results.length > before;
     const failed = (data.unresponsive_engines ?? []).flatMap(e => Array.isArray(e) && e[0] ? [{engine: String(e[0]), reason: 'did not answer'}] : []);
     providers.push(engineStatus('searxng', engines, failed));
   } catch {
     providers.push({provider: 'searxng', status: 'unavailable', message: 'Web search engines are unavailable right now.'});
   }
 }

 if (!providers.length) providers.push({provider: 'web', status: 'disabled', message: 'Web search is not configured on this instance.'});
 const next_cursor = more && input.page < 10 ? String(input.page + 1) : null;
 if (!docs) {
   const review = deps.review === false ? null : (deps.review ?? ((q, list) => startWebReview(db, config, q, list)))(input.q, results);
   return {query: input.q, results, providers, next_cursor, ...(review ? {review} : {})};
 }
 const found = await sourcesTask;
 if (found) {
   const before = results.length;
   keep(found.docs);
   const answered = found.providers.filter(p => p.status === 'ok').length;
   if (found.providers.length) providers.push({provider: 'doc_sources', status: answered ? 'ok' : 'unavailable', message: answered
     ? `${results.length - before} documents and ${found.sites.length} places to look came from ${answered} free-document sources.`
     : 'Free-document sources did not answer; web search results only.'});
 }
 if (unsafe) providers.push({provider: 'safety', status: 'ok', message: `${unsafe} unsafe links (malware, phishing or explicit) were left out.`});
 const verified = await verifyDocuments(results, config, deps.peek);
 const {spam, dead, not_document} = verified.removed, removed = spam + dead + not_document;
 if (results.length) providers.push({provider: 'document_check', status: 'ok', message: removed
   ? `${removed} links were removed: ${dead} dead or unreachable, ${not_document} not actually documents, ${spam} spam.`
   : 'Every document link was checked.'});
 // The first page also explores the websites the search found, even when it found no document files itself.
 const explore = input.page === 1 && config.DOC_HUNT_ENABLED;
 const sites = (found?.sites ?? []).flatMap(r => { try { const url = publicURL(r.url).href;
   return unsafeLink(url) || accessKind(url) === 'unauthorized' ? [] : [{id: url, url, title: plain(r.title, 300) ?? url, source_name: new URL(url).hostname,
     snippet: plain(r.snippet, 600), published: isoDate(r.published), doc_type: null, access: null, engine: r.engine, preview: null}]; } catch { return []; } });
 const hunt = verified.results.length || explore
   ? (deps.hunt ?? ((q, list, e, s) => startHunt(db, config, q, list, e, {}, s)))(input.q, verified.results, explore, sites) : null;
 return {query: input.q, results: verified.results.map(({bytes: _bytes, ...d}) => d), providers, next_cursor, hunt};
}
