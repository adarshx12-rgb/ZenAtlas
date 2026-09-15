import { z } from 'zod';
import type { Config } from './config.js';
import { contentInput, type SourceAdapter, type SearchInput, type DiscoveryPage } from './types.js';
import { fetchJSON, UpstreamError } from './http.js';
import { canonicalize } from './urls.js';

const caps = { transcripts: false, comments: false, embeds: false, accessible_media: false };
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
 constructor(private config:Config,private transport=fetchJSON){}
 async search(query:string,_filters:SearchInput,cursor='0'):Promise<DiscoveryPage>{
   const offset=z.coerce.number().int().min(0).max(9).parse(cursor);
   const url=new URL('https://api.search.brave.com/res/v1/web/search');
   url.search=new URLSearchParams({q:query,count:String(Math.min(20,this.config.DISCOVERY_RESULTS)),offset:String(offset),safesearch:'moderate',text_decorations:'false'}).toString();
   const data=z.object({web:z.object({results:z.array(z.unknown()).max(100)}).optional(),query:z.object({more_results_available:z.boolean().optional()}).optional()})
     .parse(await this.transport(url.href,{trustedOrigin:url.origin,headers:{'X-Subscription-Token':this.config.BRAVE_SEARCH_API_KEY},timeoutMs:this.config.PROVIDER_TIMEOUT_MS,redirects:0}));
   return {results:normaliseRows(data.web?.results??[],{url:'url',description:'description'},this.config.DISCOVERY_RESULTS),
     next_cursor:data.query?.more_results_available&&offset<9?String(offset+1):null,
     status:{provider:this.name,status:'ok',message:'Brave discovery completed.'}};
 }
}
export function configuredProviders(config:Config,purpose:'content'|'sources'='content'):SourceAdapter[]{
 const providers:SourceAdapter[]=[];
 if(config.GOOGLE_SEARCH_API_KEY && config.GOOGLE_SEARCH_ENGINE_ID)providers.push(new GoogleSearch(config));
 if(config.BRAVE_SEARCH_API_KEY)providers.push(new BraveSearch(config));
 if(config.SEARXNG_BASE_URL)providers.push(new SearXNG(purpose==='sources'?{...config,SEARXNG_CATEGORIES:'general',SEARXNG_ENGINES:config.SEARXNG_SOURCE_ENGINES}:config));
 return providers;
}
export class SearXNG implements SourceAdapter {
 name = 'searxng'; capabilities = caps;
 constructor(private config: Config, private transport = fetchJSON) {}
 async search(query: string, filters: SearchInput, cursor = '1'): Promise<DiscoveryPage> {
   if (!/^\d{1,2}$/.test(cursor)) throw new Error('invalid_provider_cursor');
   const url = new URL('/search', this.config.SEARXNG_BASE_URL);
   url.search = new URLSearchParams({q: query, format:'json', pageno:cursor, safesearch:'1',
     categories:this.config.SEARXNG_CATEGORIES, engines:this.config.SEARXNG_ENGINES,
     ...(filters.language ? {language:filters.language} : {})}).toString();
   let payload: any;
   for (let attempt = 0; attempt < 2; attempt++) {
     try {
       payload = await this.transport(url.href, { trustedOrigin:url.origin, token:this.config.SEARXNG_TOKEN,
         timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects:0 }); break;
     } catch (error) {
       if (attempt || error instanceof UpstreamError && ['unsafe_url','rate_limited','malformed_response','unsupported_content'].includes(error.code)) throw error;
       await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 100));
     }
   }
   const parsed = z.object({results:z.array(z.unknown()).max(1000), unresponsive_engines:z.array(z.unknown()).optional()}).parse(payload);
   const results = [];
   for (const raw of parsed.results.slice(0, this.config.DISCOVERY_RESULTS)) {
     try {
       const row = z.object({url:z.string(),title:z.string(),content:z.string().optional()}).parse(raw);
       results.push(contentInput.parse({url:canonicalize(row.url),title:row.title,description:row.content ?? null}));
     } catch { /* A malformed entry must not discard other providers' valid results. */ }
   }
   const partial = !!parsed.unresponsive_engines?.length;
   return {results,next_cursor:results.length ? String(Number(cursor)+1) : null,
     status:{provider:this.name,status:partial?'partial':'ok',message:partial?'Some discovery engines are unavailable.':'Discovery completed.'}};
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
