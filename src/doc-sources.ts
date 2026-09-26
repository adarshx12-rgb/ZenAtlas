import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { fetchJSON, fetchText } from './http.js';
import { takeBudget } from './budgets.js';
import { VIEWER_SITES } from './doc-viewers.js';

// Free-document sources the Docs tab searches directly, beside Brave and SearXNG: open research (arXiv, Semantic
// Scholar, Zenodo, DOAJ), free books and texts (Google Books full view, Internet Archive), user-upload document viewers
// (Scribd, SlideShare, Academia.edu...) and institutional repositories (OpenStax, LibreTexts, UN, WHO, World Bank,
// government and university sites). docs are candidate documents for verification; sites are web pages the document
// hunt (src/doc-hunt.ts) looks inside, such as a journal article's landing page or a repository's record.

export interface SourceRow { url: string; title: unknown; snippet: unknown; published: unknown; engine: string }
export interface SourceFindings { docs: SourceRow[]; sites: SourceRow[]; providers: ProviderStatus[] }
type Deps = {json: typeof fetchJSON; text: typeof fetchText; budget: (db: DB, key: string, limit: number) => Promise<boolean>};

const REPOSITORY_SITES = ['openstax.org', 'libretexts.org', 'un.org', 'who.int', 'worldbank.org', 'imf.org', 'oecd.org', 'gov', 'gov.in', 'nic.in', 'ac.in', 'edu'];
const words = (q: string) => q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 8) ?? [];

export async function findDocuments(db: DB, config: Config, query: string, deps: Deps = {json: fetchJSON, text: fetchText, budget: takeBudget}): Promise<SourceFindings> {
 const out: SourceFindings = {docs: [], sites: [], providers: []};
 if (!config.DOC_SOURCES_ENABLED) return out;
 const opts = (origin: string) => ({trustedOrigin: origin, timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0, maxBytes: 4 * 1024 * 1024});
 const sources: [string, () => Promise<{docs?: SourceRow[]; sites?: SourceRow[]}>][] = [
   ['arxiv', async () => {
     const url = new URL('https://export.arxiv.org/api/query');
     url.search = new URLSearchParams({search_query: words(query).map(w => `all:${w}`).join(' AND '), max_results: '8'}).toString();
     const xml = (await deps.text(url.href, {...opts(url.origin), accept: 'application/atom+xml', contentTypes: ['application/atom+xml', 'application/xml', 'text/xml']})).text;
     return {docs: [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, e]) => {
       const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/.exec(e)?.[1];
       return id ? [{url: `https://arxiv.org/pdf/${id}`, title: tag(e, 'title'), snippet: tag(e, 'summary'), published: tag(e, 'published'), engine: 'arxiv'}] : [];
     })};
   }],
   ['semantic_scholar', async () => {
     const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
     url.search = new URLSearchParams({query, limit: '10', fields: 'title,year,abstract,url,openAccessPdf'}).toString();
     const data = z.object({data: z.array(z.object({title: z.string(), year: z.number().nullable().optional(), abstract: z.string().nullable().optional(),
       url: z.string().optional(), openAccessPdf: z.object({url: z.string()}).nullable().optional()})).default([])})
       .parse(await deps.json(url.href, {...opts(url.origin), headers: config.SEMANTIC_SCHOLAR_API_KEY ? {'x-api-key': config.SEMANTIC_SCHOLAR_API_KEY} : {}}));
     return {docs: data.data.flatMap(p => p.openAccessPdf?.url ? [{url: p.openAccessPdf.url, title: p.title, snippet: p.abstract ?? null,
       published: p.year ? `${p.year}-01-01` : null, engine: 'semantic_scholar'}] : [])};
   }],
   ['zenodo', async () => {
     const url = new URL('https://zenodo.org/api/records');
     // Every word required: Zenodo's default ORs them, which matches any record sharing one word.
     url.search = new URLSearchParams({q: words(query).map(w => `+${w}`).join(' '), size: '8'}).toString();
     const data = z.object({hits: z.object({hits: z.array(z.object({id: z.union([z.number(), z.string()]), metadata: z.object({title: z.string(),
       publication_date: z.string().optional(), description: z.string().optional()}), files: z.array(z.object({key: z.string()})).default([])}))})})
       .parse(await deps.json(url.href, opts(url.origin)));
     // File links are rewritten to the /files/<name> form, whose path shows the file type.
     return {docs: data.hits.hits.flatMap(h => h.files.slice(0, 2).map(f => ({url: `https://zenodo.org/records/${h.id}/files/${encodeURIComponent(f.key)}?download=1`,
       title: h.metadata.title, snippet: h.metadata.description ?? null, published: h.metadata.publication_date ?? null, engine: 'zenodo'})))};
   }],
   ['doaj', async () => {
     const url = new URL(`https://doaj.org/api/search/articles/${encodeURIComponent(query)}`);
     url.search = new URLSearchParams({pageSize: '8'}).toString();
     const data = z.object({results: z.array(z.object({bibjson: z.object({title: z.string(), year: z.string().optional(), abstract: z.string().optional(),
       link: z.array(z.object({type: z.string().optional(), url: z.string()})).default([])})})).default([])}).parse(await deps.json(url.href, opts(url.origin)));
     // Full text sits behind the article's landing page: a place for the hunt to look, not a file.
     return {sites: data.results.flatMap(r => r.bibjson.link.filter(l => l.type === 'fulltext').slice(0, 1).map(l => ({url: l.url,
       title: r.bibjson.title, snippet: r.bibjson.abstract ?? null, published: r.bibjson.year ? `${r.bibjson.year}-01-01` : null, engine: 'doaj'})))};
   }],
   ['google_books', async () => {
     const url = new URL('https://www.googleapis.com/books/v1/volumes');
     url.search = new URLSearchParams({q: query, filter: 'free-ebooks', maxResults: '8', printType: 'books'}).toString();
     const data = z.object({items: z.array(z.object({volumeInfo: z.object({title: z.string(), description: z.string().optional(),
       publishedDate: z.string().optional(), previewLink: z.string().optional()})})).default([])}).parse(await deps.json(url.href, opts(url.origin)));
     return {docs: data.items.flatMap(i => i.volumeInfo.previewLink ? [{url: i.volumeInfo.previewLink.replace(/^http:/, 'https:'), title: i.volumeInfo.title,
       snippet: i.volumeInfo.description ?? null, published: i.volumeInfo.publishedDate ?? null, engine: 'google_books'}] : [])};
   }],
   ['internet_archive', async () => {
     const url = new URL('https://archive.org/advancedsearch.php');
     // Titles only: the default also searches full text, where scanned archives match almost any word.
     url.search = new URLSearchParams([['q', `title:(${words(query).join(' AND ')}) AND mediatype:texts`], ['fl[]', 'identifier'], ['fl[]', 'title'],
       ['fl[]', 'description'], ['fl[]', 'date'], ['rows', '8'], ['output', 'json']]).toString();
     const text = z.union([z.string(), z.array(z.string())]).optional().transform(v => Array.isArray(v) ? v.join(' ') : v ?? null);
     const data = z.object({response: z.object({docs: z.array(z.object({identifier: z.string(), title: text, description: text, date: z.string().optional()}))})})
       .parse(await deps.json(url.href, opts(url.origin)));
     return {docs: data.response.docs.map(d => ({url: `https://archive.org/details/${d.identifier}`, title: d.title ?? d.identifier,
       snippet: d.description, published: d.date ?? null, engine: 'internet_archive'}))};
   }],
   ['document_sites', async () => ({docs: await searxng(`${query} (${VIEWER_SITES.map(s => `site:${s}`).join(' OR ')})`)})],
   ['repositories', async () => ({sites: await searxng(`${query} (${REPOSITORY_SITES.map(s => `site:${s}`).join(' OR ')})`)})],
 ];
 async function searxng(q: string): Promise<SourceRow[]> {
   if (!config.SEARXNG_BASE_URL) return [];
   if (!await deps.budget(db, 'discovery:searxng', config.SEARXNG_DAILY_BUDGET)) throw new Error('budget_exhausted');
   const url = new URL('/search', config.SEARXNG_BASE_URL);
   url.search = new URLSearchParams({q, format: 'json', safesearch: '2', engines: config.SEARXNG_WEB_ENGINES,
     timeout_limit: String(Math.max(1, config.PROVIDER_TIMEOUT_MS / 1000 - 2))}).toString();
   const data = z.object({results: z.array(z.looseObject({url: z.string()})).max(1000)})
     .parse(await deps.json(url.href, {trustedOrigin: url.origin, token: config.SEARXNG_TOKEN, timeoutMs: config.PROVIDER_TIMEOUT_MS, redirects: 0}));
   return data.results.slice(0, 20).map(r => ({url: r.url, title: r.title, snippet: r.content, published: r.publishedDate, engine: 'searxng'}));
 }

 await Promise.all(sources.map(async ([name, run]) => {
   if (!await deps.budget(db, 'doc_sources', config.DOC_SOURCES_DAILY_BUDGET)) {
     out.providers.push({provider: name, status: 'budget_exhausted', message: `The daily ${name.replace('_', ' ')} limit has been reached.`}); return;
   }
   try {
     const found = await run();
     out.docs.push(...found.docs ?? []); out.sites.push(...found.sites ?? []);
     out.providers.push({provider: name, status: 'ok', message: `${(found.docs?.length ?? 0) + (found.sites?.length ?? 0)} results from ${name.replace('_', ' ')}.`});
   } catch { out.providers.push({provider: name, status: 'unavailable', message: `${name.replace('_', ' ')} did not answer.`}); }
 }));
 return out;
}

function tag(xml: string, name: string): string|null {
 const raw = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
 return raw ? raw.replace(/\s+/g, ' ').trim() : null;
}
