import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { searchInput, type Result, type SearchInput, type SearchResponse, type ClosestMatchesResponse, type ProviderStatus, type SceneAnalysisStatus } from './types.js';
import { activeScene, sceneAnalysisStatus } from './scenes.js';
import { retrieve } from './retrieval.js';
import { matchesFilters } from './catalogue.js';
import { RANKING_VERSION } from './ranking.js';
import { takeBudget } from './budgets.js';
import { configuredProviders } from './providers.js';
import { configuredArchives } from './specialists.js';
import { contractSchema } from './requirements.js';

// How long a search reports that discovery is still running before calling it delayed: the checks and AI ranking
// can take up to three minutes after a deep dive's search time.
const CHECKING_WINDOW_MS = 180000;

export class ApiError extends Error { constructor(public statusCode:number, public code:string, message:string) { super(message); } }
export function queryKey(input: SearchInput) {
 const key = [RANKING_VERSION,input.q,input.language,input.source,input.after,input.evidence];
 return createHash('sha256').update(JSON.stringify(input.depth==='deep' ? [...key,'deep'] : key)).digest('hex');
}
function encodeCursor(config: Config, id: string, offset: number) {
 const body = `${id}.${offset}`;
 return `${body}.${createHmac('sha256',config.SESSION_SECRET).update(body).digest('base64url')}`;
}
function decodeCursor(config: Config, cursor: string) {
 const [id,offset,mac,...extra] = cursor.split('.');
 const expected = encodeCursor(config,id,Number(offset)).split('.')[2];
 if (extra.length || !/^[0-9a-f-]{36}$/.test(id??'') || !/^\d{1,3}$/.test(offset??'') ||
   !mac || !/^[A-Za-z0-9_-]{43}$/.test(mac) || !timingSafeEqual(Buffer.from(mac),Buffer.from(expected))) {
   throw new ApiError(400,'invalid_cursor','This page cursor is invalid.');
 }
 return {id,offset:Number(offset)};
}

const withDetails = (item: Result, found: Result): Result => ({...item,
 duration: item.duration ?? found.duration, published_at: item.published_at ?? found.published_at, creator: item.creator ?? found.creator,
 badges: found.badges ?? item.badges, judgement: found.judgement ?? item.judgement,
 evidence_coverage: found.evidence_coverage ?? item.evidence_coverage,
 ...(found.requirements ? {requirements: found.requirements, uncertainties: found.uncertainties} : {}),
 moments: [...item.moments, ...found.moments.filter(m => !item.moments.some(o => o.id === m.id))].sort((a, b) => a.start_seconds - b.start_seconds),
 ...(found.preview && found.id === item.id ? {preview: true} : {})});

// Completion replaces provisional ordering across quick, deep and catalogue results. A slower
// source can take the first position. Once judging was attempted, only its accepted pool remains.
function merge(existing: Result[], found: Result[], filters: SearchInput, final: {dropped: string[]; deep: boolean; checked:boolean}|null) {
 const results = [...existing];
 const at = new Map(results.map((r, i) => [r.canonical_url, i]));
 for (const item of found) {
   if (!matchesFilters(item, filters)) continue;
   const i = at.get(item.canonical_url);
   if (i === undefined) { at.set(item.canonical_url, results.length); results.push(item); }
   else if (final) results[i] = results[i].origin === 'catalogue' ? {...withDetails(results[i], item), judgement: item.judgement ?? null} : item;
 }
 if (!final) return results;
 const dropped = new Set(final.dropped);
 const rank = new Map(found.map((r, i) => [r.canonical_url, i]));
 return results.filter(r => !dropped.has(r.canonical_url) && (!final.checked || rank.has(r.canonical_url))).sort((a, b) =>
   (b.judgement?.relevance ?? -1) - (a.judgement?.relevance ?? -1) ||
   (rank.get(a.canonical_url) ?? found.length) - (rank.get(b.canonical_url) ?? found.length));
}

export class SearchService {
 constructor(public db: DB, public config: Config) {}
 async start(raw: unknown, owner: string): Promise<SearchResponse> {
   const input = searchInput.parse(raw);
   if (input.cursor) {
     const cursor = decodeCursor(this.config,input.cursor);
     const snapshot = await this.owned(cursor.id,owner);
     if (queryKey(snapshot.filters)!==queryKey(input) || snapshot.filters.limit!==input.limit || snapshot.filters.mode!==input.mode) {
       throw new ApiError(400,'cursor_mismatch','Keep the original query and filters when paging.');
     }
     return this.page(snapshot,cursor.offset);
   }
   const local = await retrieve(this.db,this.config,input,owner);
   let job: any = null; const providers = [...local.providers];
   // Discovery costs a shared daily job and provider budget, so auto mode spends it only when the catalogue is thin.
   if (input.mode !== 'catalogue' && (input.mode==='refresh' || input.depth==='deep' || local.strong<this.config.COVERAGE_MIN_RESULTS
     || local.strongSources<this.config.COVERAGE_MIN_SOURCES)) {
     const discovery = await this.discover(input,owner);
     job = discovery.job; providers.push(...discovery.providers);
   }
   return this.page(await this.save(owner,input,local.results,job,providers),0);
 }
 // Continues a quick search as a deep one: a new snapshot keeps everything already found and follows a deep job.
 async deepen(id: string, owner: string): Promise<SearchResponse> {
   const {snapshot} = await this.refresh(await this.owned(id,owner));
   const filters = searchInput.parse(snapshot.filters);
   if (filters.depth === 'deep') return this.page(snapshot,0);
   if (filters.mode === 'catalogue') throw new ApiError(400,'discovery_disabled','Catalogue-only searches do not look beyond the catalogue. Choose a mode with discovery to dig deeper.');
   const input: SearchInput = {...filters,depth:'deep'};
   const {job,providers} = await this.discover(input,owner);
   return this.page(await this.save(owner,input,snapshot.results,job,providers),0);
 }
 async owned(id: string, owner: string) {
   const row = (await this.db.query('SELECT * FROM searches WHERE id=$1 AND owner=$2 AND expires_at>now()',[id,owner])).rows[0];
   if (!row) throw new ApiError(404,'search_not_found','This search is unavailable or has expired.');
   return row;
 }
 async poll(id:string,owner:string) { return this.page(await this.owned(id,owner),0); }
 async closest(id:string,owner:string):Promise<ClosestMatchesResponse> {
   const snapshot=await this.owned(id,owner);
   const response=(status:ClosestMatchesResponse['status'],message:string,results:Result[]=[]):ClosestMatchesResponse=>
     ({search_id:id,status,message,results});
   if(snapshot.cancelled) return response('cancelled','Discovery updates were stopped. Start another search to see closest matches.');
   if(!snapshot.job_id) return response('unavailable','Closest matches are available after external discovery. Try a fresh discovery search.');
   const job=(await this.db.query('SELECT status,result FROM jobs WHERE id=$1',[snapshot.job_id])).rows[0];
   if(job && ['queued','running'].includes(job.status)) return response('pending','Closest matches will be available when discovery finishes.');
   if(job?.status!=='complete') return response('unavailable','Discovery could not finish. Retry the search to see closest matches.');
   const main=new Set((job.result?.results??[]).map((r:Result)=>r.canonical_url));
   const items:Result[]=(job.result?.closest??[]).filter((r:Result)=>!main.has(r.canonical_url) &&
     r.judgement && r.judgement.relevance>=3 && r.judgement.relevance<=5 &&
     !r.judgement.intent_checks?.some(c=>c.status==='mismatch')).slice(0,20);
   const shown=await this.visible(snapshot,items);
   const results=items.flatMap(r=>shown.get(r.id)??[]);
   return response('ready',results.length?'These are partial or uncertain matches. Check the reason shown on each result.'
     :'No closest matches are available for this search.',results);
 }
 async cancel(id:string,owner:string) {
   await this.owned(id,owner);
   await this.db.query('UPDATE searches SET cancelled=true WHERE id=$1 AND owner=$2',[id,owner]);
   // A shared collection job may still be needed by other searches; cancellation stops this subscription.
   return {status:'cancelled'};
 }
 private async discover(input: SearchInput, owner: string): Promise<{job: any; providers: ProviderStatus[]}> {
   if (!configuredProviders(this.config).length && !(input.depth === 'deep' && !input.source && configuredArchives(this.config, input.q).length))
     return {job:null,providers:[{provider:'discovery',status:'disabled',message:'External discovery is not configured.'}]};
   if (!await takeBudget(this.db,`discovery-user:${owner}`,20,'day')) {
     return {job:null,providers:[{provider:'discovery',status:'budget_exhausted',message:'Your daily discovery limit has been reached.'}]};
   }
   const key = `discovery:${queryKey(input)}`;
   const cached = (await this.db.query(`SELECT * FROM jobs WHERE dedupe_key=$1 AND
     (status IN ('queued','running') OR updated_at>=now()-($2*interval '1 second'))`,[key,this.config.DISCOVERY_CACHE_SECONDS])).rows[0];
   if (cached) return {job:cached,providers:[]};
   if (!await takeBudget(this.db,'discovery_jobs',this.config.DISCOVERY_DAILY_BUDGET)) {
     return {job:null,providers:[{provider:'discovery',status:'budget_exhausted',message:'The daily discovery job budget has been reached.'}]};
   }
   // One durable job per normalized query/filter set. Reuse both running work and recent completed results.
   const job = (await this.db.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES('discovery',$1,$2)
   ON CONFLICT(dedupe_key) DO UPDATE SET
     status=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN 'queued' ELSE jobs.status END,
     attempts=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN 0 ELSE jobs.attempts END,
     result=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN NULL ELSE jobs.result END,
     run_after=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN now() ELSE jobs.run_after END,
     updated_at=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN now() ELSE jobs.updated_at END
   RETURNING *`,[key,JSON.stringify(input),this.config.DISCOVERY_CACHE_SECONDS])).rows[0];
   return {job,providers:[]};
 }
 private async save(owner: string, input: SearchInput, results: Result[], job: any, providers: ProviderStatus[]) {
   return (await this.db.query(`INSERT INTO searches(owner,query,filters,ranking_version,results,job_id,provider_status,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8*interval '1 second')) RETURNING *`,
     [owner,input.q,JSON.stringify(input),RANKING_VERSION,JSON.stringify(results),job?.id??null,
       JSON.stringify(providers),this.config.SEARCH_TTL_SECONDS])).rows[0];
 }
 private async refresh(initial: any): Promise<{snapshot: any; job: any}> {
   const job = initial.job_id ? (await this.db.query('SELECT status,result FROM jobs WHERE id=$1',[initial.job_id])).rows[0] : null;
   if (!job?.result || initial.discovery_applied || initial.cancelled) return {snapshot:initial,job};
   const final = job.status==='complete';
   const found: Result[] = job.result.results ?? [];
   const known = new Set((initial.results as Result[]).map(r=>r.canonical_url));
   if (!final && !found.some(r=>!known.has(r.canonical_url) && matchesFilters(r,initial.filters))) return {snapshot:initial,job};
   const snapshot = await this.db.transaction(async tx=>{
     const current = (await tx.query('SELECT * FROM searches WHERE id=$1 FOR UPDATE',[initial.id])).rows[0];
     if (current.discovery_applied || current.cancelled) return current;
     const results = merge(current.results,found,current.filters,
       final ? {dropped:job.result.dropped??[],deep:current.filters.depth==='deep',
         checked:(job.result.providers??[]).some((p:ProviderStatus)=>p.provider==='judge')} : null);
     const providers = final ? [...current.provider_status,...(job.result.providers??[])] : current.provider_status;
     return (await tx.query(`UPDATE searches SET results=$2,provider_status=$3,discovery_applied=$4 WHERE id=$1 RETURNING *`,
       [current.id,JSON.stringify(results.slice(0,250)),JSON.stringify(providers),final])).rows[0];
   });
   return {snapshot,job};
 }
 // Honour revocation/deletion even within an otherwise immutable search snapshot.
 private async visible(snapshot: any, items: Result[]): Promise<Map<string,Result>> {
   const ids = [...new Set(items.map(r=>r.id))];
   if (!ids.length) return new Map();
   const allowed = (await this.db.query(`SELECT c.id FROM content c JOIN sources s ON s.id=c.source_id
     WHERE c.id=ANY($1::uuid[]) AND s.status='active' AND (s.policy->>'metadata')::boolean=true
     AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
     AND c.availability<>'unavailable' AND c.expires_at>now()`,[ids])).rows.map(r=>r.id);
   const candidateSources = (await this.db.query(`SELECT id FROM sources WHERE id=ANY($1::uuid[]) AND status='candidate' AND health_status<>'down'`,
     [[...new Set(items.map(r=>r.source_id))]])).rows.map(r=>r.id);
   const momentIds=items.flatMap(r=>r.moments.map(m=>m.id));
   const activeMoments=momentIds.length?(await this.db.query(`SELECT m.id FROM moments m JOIN content c ON c.id=m.content_id
     JOIN sources s ON s.id=c.source_id WHERE m.id=ANY($1::uuid[]) AND m.status='active'
     AND (m.evidence_type<>'transcript_supported' OR (s.policy->>'transcripts')::boolean=true)
     AND (m.evidence_type<>'viewer_timestamp' OR (s.policy->>'viewer_signals')::boolean=true)
     UNION ALL SELECT v.id FROM video_scenes v JOIN content c ON c.id=v.content_id JOIN sources s ON s.id=c.source_id
     WHERE v.id=ANY($1::uuid[]) AND ${activeScene}`,[momentIds])).rows.map(r=>r.id):[];
   const analyses = new Map<string,SceneAnalysisStatus>((await this.db.query(`SELECT mv.content_id,mv.version_key,mv.analysis_status,mv.analysis_code
     FROM media_versions mv JOIN content c ON c.id=mv.content_id JOIN sources s ON s.id=c.source_id
     WHERE mv.content_id=ANY($1::uuid[]) AND mv.status='current' AND (s.policy->>'video_analysis')::boolean=true`,
     [ids])).rows.map(r=>[r.content_id,sceneAnalysisStatus(r)]));
   return new Map(items.filter(r=>allowed.includes(r.id) || r.origin==='discovery' && candidateSources.includes(r.source_id))
     .map(r=>{const moments=r.moments.filter(m=>activeMoments.includes(m.id));
       return {...r,moments,evidence:moments[0]?.evidence_type??'metadata_match' as const,scene_analysis:analyses.get(r.id)??null};})
     .filter(r=>matchesFilters(r,snapshot.filters)).map(r=>[r.id,r]));
 }
 private async page(initial:any, offset:number): Promise<SearchResponse> {
   const {snapshot,job} = await this.refresh(initial);
   const filters = snapshot.filters;
   const depth: SearchInput['depth'] = filters.depth ?? 'quick';
   const running = !!job && ['queued','running'].includes(job.status);
   const window = CHECKING_WINDOW_MS + (depth==='deep' ? this.config.DEEP_SEARCH_SECONDS*1000 : 0);
   const waiting = running && Date.now()-new Date(snapshot.created_at).getTime()<=window;
   const providers: ProviderStatus[] = [...snapshot.provider_status];
   if (job?.status==='failed') providers.push({provider:'discovery',status:'unavailable',message:'External discovery failed. Catalogue results are still available.'});
   if (running && !waiting) providers.push({provider:'discovery',status:'unavailable',message:'Discovery is delayed. Try again later.'});
   const all: Result[] = snapshot.results;
   const slice = all.slice(offset,offset+filters.limit);
   const found = all.filter(r=>r.origin!=='catalogue');
   const shown = await this.visible(snapshot,all);
   const more = offset+filters.limit<all.length;
   return {query:snapshot.query,search_id:snapshot.id,status:snapshot.cancelled?'cancelled':waiting?'discovering':
     providers.some(p=>['partial','unavailable','budget_exhausted','disabled'].includes(p.status))?'partial':'complete',
     depth,stage:waiting?(job.status==='queued'?'queued':job.result?.stage??'searching'):null,
     results:slice.flatMap(r=>shown.get(r.id)??[]),has_more:more,next_cursor:more?encodeCursor(this.config,snapshot.id,offset+filters.limit):null,
     discovered:found.flatMap(r=>shown.get(r.id)??[]),catalogue_total:all.length-found.length,
     ranked:all.flatMap(r=>shown.get(r.id)??[]),
     discovery_job_id:snapshot.job_id,providers,ranking_version:snapshot.ranking_version,
     ...(job?.status==='complete'&&job.result?.contract?{interpretation:interpretationOf(job.result.contract,job.result.unmet)}:{})};
 }
}

// The contract a discovery job worked from, reduced to what a person needs to see: the reading of the request,
// its requirements, the assumptions made instead of asking, and what could not be satisfied.
function interpretationOf(raw: unknown, unmet: unknown): SearchResponse['interpretation'] {
 const contract = contractSchema.safeParse(raw);
 if (!contract.success) return undefined;
 const c = contract.data;
 return {intent: c.intent, requirements: c.requirements.map(r => ({id: r.id, text: r.text, hardness: r.hardness, scope: r.scope})),
   assumptions: c.assumptions, ambiguities: c.ambiguities, unmet: Array.isArray(unmet) ? unmet.filter((u): u is string => typeof u === 'string') : []};
}
