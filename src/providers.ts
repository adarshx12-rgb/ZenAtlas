import { z } from 'zod';
import type { Config } from './config.js';
import { contentInput, type SourceAdapter, type SearchInput, type DiscoveryPage, type EngineFailure, type ProviderStatus } from './types.js';
import { fetchJSON, UpstreamError } from './http.js';
import { canonicalize, publicURL } from './urls.js';

const caps = { transcripts: false, comments: false, embeds: false, accessible_media: false };
// Discovery ranking picks the final DISCOVERY_RESULTS from this larger pool, so one site's top hits cannot crowd out the rest.
const SEARXNG_CANDIDATES = 100;
// Optional provider metadata is best effort: an unusable value becomes null instead of discarding the result.
function mediaURL(value: unknown) {
 if (typeof value !== 'string' || !value) return null;
 try { const url = publicURL(value.startsWith('//') ? `https:${value}` : value).href; return url.length <= 2048 ? url : null; } catch { return null; }
}
function isoDate(value: unknown) {
 if (typeof value !== 'string' || !value) return null;
 // SearXNG omits the zone for some engines; treat those timestamps as UTC rather than server-local time.
 const date = new Date(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}Z` : value);
 return Number.isFinite(date.getTime()) && date.getTime() <= Date.now() + 86400000 ? date.toISOString() : null;
}
function seconds(value: unknown) {
 const total = typeof value === 'number' ? value :
   typeof value === 'string' && /^\d{1,3}(:\d{1,2}){0,2}$/.test(value) ? value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) : NaN;
 return Number.isFinite(total) && total > 0 && total <= 604800 ? total : null;
}
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
function normaliseRows(rows:unknown[],keys:{url:string;description:string},limit:number){
 const items=[];
 for(const raw of rows.slice(0,limit))try{
   const row=z.record(z.string(),z.unknown()).parse(raw);
   items.push(contentInput.parse({url:canonicalize(z.string().parse(row[keys.url])),title:row.title,description:row[keys.description]??null}));
 }catch{/* Preserve valid results when one upstream entry is malformed. */}
 return items;
}

export class GoogleSearch implements SourceAdapter {
 name='google';capabilities=caps;
 constructor(private config:Config,private transport=fetchJSON){}
 async search(query:string,_filters:SearchInput,cursor='1'):Promise<DiscoveryPage>{
   const start=z.coerce.number().int().min(1).max(91).parse(cursor);
   const url=new URL('https://customsearch.googleapis.com/customsearch/v1');
   url.search=new URLSearchParams({q:query,cx:this.config.GOOGLE_SEARCH_ENGINE_ID,key:this.config.GOOGLE_SEARCH_API_KEY,
     num:String(Math.min(10,this.config.DISCOVERY_RESULTS)),start:String(start),safe:'active'}).toString();
   const data=z.object({items:z.array(z.unknown()).max(100).optional(),queries:z.object({nextPage:z.array(z.object({startIndex:z.number().int()})).optional()}).optional()})
     .parse(await this.transport(url.href,{trustedOrigin:url.origin,timeoutMs:this.config.PROVIDER_TIMEOUT_MS,redirects:0}));
   return {results:normaliseRows(data.items??[],{url:'link',description:'snippet'},this.config.DISCOVERY_RESULTS),
     next_cursor:data.queries?.nextPage?.[0]?.startIndex?String(data.queries.nextPage[0].startIndex):null,
     status:{provider:this.name,status:'ok',message:'Google discovery completed.'}};
 }
}
export class BraveSearch implements SourceAdapter {
 name='brave';capabilities=caps;
 constructor(private config:Config,private transport=fetchJSON,private target:'videos'|'web'='web'){}
 // Video searches use Brave's video index, which carries duration, creator, date and thumbnail.
 forTarget(target:'videos'|'web'){return new BraveSearch(this.config,this.transport,target);}
 async search(query:string,_filters:SearchInput,cursor='0'):Promise<DiscoveryPage>{
   const offset=z.coerce.number().int().min(0).max(9).parse(cursor);
   const url=new URL(`https://api.search.brave.com/res/v1/${this.target==='videos'?'videos':'web'}/search`);
   url.search=new URLSearchParams({q:query,count:String(Math.min(20,this.config.DISCOVERY_RESULTS)),offset:String(offset),safesearch:'moderate',text_decorations:'false'}).toString();
   const data=z.object({web:z.object({results:z.array(z.unknown()).max(100)}).optional(),results:z.array(z.unknown()).max(100).optional(),
     query:z.object({more_results_available:z.boolean().optional()}).optional()})
     .parse(await this.transport(url.href,{trustedOrigin:url.origin,headers:{'X-Subscription-Token':this.config.BRAVE_SEARCH_API_KEY},timeoutMs:this.config.PROVIDER_TIMEOUT_MS,redirects:0}));
   const results=this.target==='videos'?videoRows(data.results??[],this.config.DISCOVERY_RESULTS)
     :normaliseRows(data.web?.results??[],{url:'url',description:'description'},this.config.DISCOVERY_RESULTS);
   return {results,next_cursor:data.query?.more_results_available&&offset<9?String(offset+1):null,
     status:{provider:this.name,status:'ok',message:'Brave discovery completed.'}};
 }
}
function videoRows(rows:unknown[],limit:number){
 const items=[];
 for(const raw of rows.slice(0,limit))try{
   const row=z.looseObject({url:z.string(),title:z.string()}).parse(raw) as Record<string,any>;
   const video=row.video&&typeof row.video==='object'?row.video:{};
   items.push(contentInput.parse({url:canonicalize(row.url),title:row.title,description:text(row.description,10000),
     creator:text(video.creator??video.author?.name,300),published_at:isoDate(row.page_age),duration:seconds(video.duration),
     thumbnail:mediaURL(row.thumbnail?.src)}));
 }catch{/* Preserve valid results when one upstream entry is malformed. */}
 return items;
}
export function configuredProviders(config:Config,purpose:'content'|'sources'='content'):SourceAdapter[]{
 const providers:SourceAdapter[]=[];
 if(config.GOOGLE_SEARCH_API_KEY && config.GOOGLE_SEARCH_ENGINE_ID)providers.push(new GoogleSearch(config));
 if(config.BRAVE_SEARCH_API_KEY)providers.push(new BraveSearch(config));
 if(config.SEARXNG_BASE_URL)providers.push(new SearXNG(purpose==='sources'?{...config,SEARXNG_ENGINES:config.SEARXNG_SOURCE_ENGINES}:config));
 return providers;
}

const engineList = (engines: string) => [...new Set(engines.split(',').map(e => e.trim()).filter(Boolean))];
const engineName = (engine: string) => engine.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function failureReason(reason: string) {
 return /captcha/i.test(reason) ? 'blocked by a CAPTCHA' : /too many requests|rate.?limit|429/i.test(reason) ? 'rate-limited'
   : /timeout|timed out/i.test(reason) ? 'timed out' : /access denied|forbidden|\b40[23]\b/i.test(reason) ? 'access denied' : 'returned an error';
}
// A metasearch where most engines answered is a normal search: the status names the engines that did not, without flagging it.
export function engineStatus(provider: string, asked: string[], failed: EngineFailure[]): ProviderStatus {
 if (!failed.length) return {provider, status: 'ok', message: 'Discovery completed.'};
 if (provider === 'searxng' && failed.length === asked.length && failed.every(f => f.reason.startsWith('SearXNG service unreachable')))
   return {provider, status: 'unavailable', message: 'Cannot connect to the SearXNG service. Check that it is running at the configured address.'};
 const answered = asked.length - failed.length;
 return {provider, status: answered * 2 >= asked.length ? 'ok' : 'partial',
   message: `${answered} of ${asked.length} search engines answered; ${failed.map(f => `${engineName(f.engine)} (${f.reason})`).join(', ')} did not.`};
}

// Shared by video, web, document and image searches in this process. SearXNG itself also enforces upstream suspensions.
const lanes = new Map<string,Promise<void>>();
const nextRequests = new Map<string,number>();
const cooldowns = new Map<string,{until: number; reason: string}>();
function inLane<T>(key: string, task: () => Promise<T>): Promise<T> {
 const run = (lanes.get(key) ?? Promise.resolve()).then(task);
 const done = run.then(() => {}, () => {});
 lanes.set(key, done);
 void done.then(() => { if (lanes.get(key) === done) lanes.delete(key); });
 return run;
}

interface SearXNGPage {results: unknown[]; engines: {asked: string[]; failed: EngineFailure[]}; status: ProviderStatus}
interface SearXNGOptions {
 engines: string[]; query: string; page?: string; language?: string; safeSearch?: '1'|'2'; deadline?: number;
 onPage?: (page: SearXNGPage) => void; maxResultsPerEngine?: number;
}
const failedPage = (engine: string, reason: string): SearXNGPage => {
 const failed = [{engine, reason}];
 return {results: [], engines: {asked: [engine], failed}, status: engineStatus('searxng', [engine], failed)};
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// No immediate retries after an upstream refusal. Queued queries recheck the cooldown before sending anything.
// A deadline includes lane waiting and pacing, not just HTTP time, so busy/blocked engines cannot hold up Brave.
export async function searchSearXNG(config: Config, options: SearXNGOptions, transport = fetchJSON): Promise<SearXNGPage> {
 const engines = [...new Set(options.engines.map(e => e.trim()).filter(Boolean))];
 if (!engines.length) throw new UpstreamError('not_configured');
 const endpoint = new URL('/search', config.SEARXNG_BASE_URL);
 const deadline = Math.min(options.deadline ?? Infinity, Date.now() + config.SEARXNG_SEARCH_TIMEOUT_MS);
 const pages = await Promise.all(engines.map(async engine => {
   const key = `${endpoint.href}|${engine}`;
   const blocked = () => {
     const pause = cooldowns.get(key);
     if (pause && pause.until > Date.now()) return failedPage(engine, `${pause.reason}; cooling down until ${new Date(pause.until).toISOString()}`);
     if (pause) cooldowns.delete(key);
     return null;
   };
   const cached = blocked();
   if (cached) return cached;
   const expired = () => failedPage(engine, 'search deadline reached');
   if (Date.now() >= deadline) return expired();
   const work = inLane(key, async (): Promise<SearXNGPage> => {
     const paused = blocked();
     if (paused) return paused;
     const wait = Math.max(0, (nextRequests.get(key) ?? 0) - Date.now());
     if (Date.now() + wait >= deadline) return expired();
     if (wait) await sleep(wait);
     if (Date.now() >= deadline) return expired();
     const timeout = Math.max(1, Math.min(config.PROVIDER_TIMEOUT_MS, deadline - Date.now()));
     const url = new URL(endpoint);
     url.search = new URLSearchParams({q: options.query, format: 'json', pageno: options.page ?? '1',
       safesearch: options.safeSearch ?? '1', engines: engine,
       timeout_limit: String(Math.max(0.1, timeout / 1000 - 2)),
       ...(options.language ? {language: options.language} : {})}).toString();
     let reason: string | undefined;
     let rows: unknown[] = [];
     try {
       const parsed = z.object({results: z.array(z.unknown()).max(1000), unresponsive_engines: z.array(z.unknown()).optional()})
         .parse(await transport(url.href, {trustedOrigin: url.origin, token: config.SEARXNG_TOKEN, timeoutMs: timeout, redirects: 0}));
       rows = parsed.results.slice(0, options.maxResultsPerEngine ?? 1000);
       const failure = parsed.unresponsive_engines?.find(e => Array.isArray(e) && e[0] === engine)
         ?? parsed.unresponsive_engines?.[0];
       if (failure) reason = failureReason(Array.isArray(failure) ? String(failure[1] ?? '') : String(failure));
     } catch (error) {
       reason = error instanceof UpstreamError
         ? error.status === 403 || error.status === 402 ? 'access denied'
           : error.code === 'rate_limited' || error.status === 429 ? 'rate-limited'
           : error.code === 'network_error' || error.code === 'dns_failure' ? 'SearXNG service unreachable'
           : error.code === 'timeout' ? 'timed out' : 'returned an error'
         : 'returned an error';
     }
     nextRequests.set(key, Date.now() + config.SEARXNG_MIN_INTERVAL_MS);
     if (reason) {
       const seconds = /CAPTCHA|access denied/.test(reason) ? config.SEARXNG_BLOCK_COOLDOWN_SECONDS
         : reason === 'rate-limited' ? config.SEARXNG_RATE_COOLDOWN_SECONDS : 30;
       cooldowns.set(key, {reason, until: Date.now() + seconds * 1000});
     }
     const failed = reason ? [{engine, reason}] : [];
     return {results: rows, engines: {asked: [engine], failed}, status: engineStatus('searxng', [engine], failed)};
   });
   // Expired queued tasks stay inert when their lane finally becomes free.
   let timer: NodeJS.Timeout | undefined;
   try {
     const page = await Promise.race([work, new Promise<SearXNGPage>(resolve => {
       timer = setTimeout(() => resolve(expired()), Math.max(0, deadline - Date.now()));
     })]);
     options.onPage?.(page);
     return page;
   } finally { clearTimeout(timer); }
 }));
 const failed = pages.flatMap(p => p.engines.failed);
 const results = Array.from({length: Math.max(0, ...pages.map(p => p.results.length))}, (_, i) =>
   pages.flatMap(p => i < p.results.length ? [p.results[i]] : [])).flat();
 return {results, engines: {asked: engines, failed}, status: engineStatus('searxng', engines, failed)};
}

export class SearXNG implements SourceAdapter {
 name = 'searxng'; capabilities = caps;
 constructor(private config: Config, private transport = fetchJSON) {}
 get engines() { return engineList(this.config.SEARXNG_ENGINES); }
 // standard: the engines every search uses; extra: the ones only deep dives add; all: both.
 forTarget(target: 'videos'|'web', set: 'standard'|'extra'|'all' = 'standard') {
   const [standard, extra] = target === 'web' ? [this.config.SEARXNG_WEB_ENGINES, this.config.SEARXNG_DEEP_WEB_ENGINES]
     : [this.config.SEARXNG_ENGINES, this.config.SEARXNG_DEEP_ENGINES];
   const engines = set === 'standard' ? standard : set === 'extra' ? extra : `${standard},${extra}`;
   return new SearXNG({...this.config, SEARXNG_ENGINES: engineList(engines).join(',')}, this.transport);
 }
 // Asks each engine separately so a slow or blocked engine cannot hold back the others; onPage receives each engine's
 // answer as it arrives. Engines whose turn comes after the deadline are not asked.
 async search(query: string, filters: SearchInput, cursor = '1', options: {onPage?: (page: DiscoveryPage) => void; deadline?: number} = {}): Promise<DiscoveryPage> {
   if (!/^\d{1,2}$/.test(cursor)) throw new Error('invalid_provider_cursor');
   const engines = this.engines;
   if (!engines.length) throw new UpstreamError('not_configured');
   const page = await searchSearXNG(this.config, {query, engines, page: cursor, language: filters.language, deadline: options.deadline, maxResultsPerEngine: SEARXNG_CANDIDATES,
     onPage: page => options.onPage?.(this.normalise(page, cursor))}, this.transport);
   return this.normalise(page, cursor);
 }
 private normalise(page: SearXNGPage, cursor: string): DiscoveryPage {
   const results = [];
   // Each engine gets the same candidate allowance, both in streamed pages and the combined response.
   for (const raw of page.results.slice(0, SEARXNG_CANDIDATES * page.engines.asked.length)) {
     try {
       const row = z.looseObject({url:z.string(),title:z.string()}).parse(raw);
       results.push(contentInput.parse({url:canonicalize(row.url),title:row.title,description:text(row.content,10000),
         creator:text(row.author,300),published_at:isoDate(row.publishedDate),duration:seconds(row.length),
         thumbnail:mediaURL(row.thumbnail || row.thumbnail_src || row.img_src)}));
     } catch { /* A malformed entry must not discard other providers' valid results. */ }
   }
   return {results,next_cursor:results.length ? String(Number(cursor)+1) : null,
     engines: page.engines, status: page.status};
 }
}

// A supported, explicitly approved JSON feed contract; no arbitrary page scraping.
export class JsonFeed implements SourceAdapter {
 name = 'json_feed'; capabilities = caps;
 async search(): Promise<DiscoveryPage> { return {results:[],next_cursor:null,status:{provider:this.name,status:'disabled',message:'This adapter collects approved feeds.'}}; }
 async listUpdates(source: {feed_url:string;cursor:string|null}): Promise<DiscoveryPage> {
   const url = new URL(source.feed_url);
   if (source.cursor) url.searchParams.set('cursor',source.cursor);
   const data = z.object({items:z.array(contentInput).max(100),next_cursor:z.string().max(1000).nullable().default(null)}).parse(await fetchJSON(url.href));
   return {results:data.items,next_cursor:data.next_cursor,status:{provider:this.name,status:'ok',message:'Feed checked.'}};
 }
}
