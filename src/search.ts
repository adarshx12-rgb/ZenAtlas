import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { searchInput, type Result, type SearchInput, type SearchResponse, type ProviderStatus, type SceneAnalysisStatus } from './types.js';
import { activeScene, sceneAnalysisStatus } from './scenes.js';
import { retrieve } from './retrieval.js';
import { matchesFilters } from './catalogue.js';
import { RANKING_VERSION } from './ranking.js';
import { takeBudget } from './budgets.js';
import { configuredProviders } from './providers.js';

export class ApiError extends Error { constructor(public statusCode:number, public code:string, message:string) { super(message); } }
export function queryKey(input: SearchInput) {
 return createHash('sha256').update(JSON.stringify([input.q,input.language,input.source,input.after,input.evidence])).digest('hex');
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
   if (input.mode !== 'catalogue' && (input.mode==='refresh' || local.strong<this.config.COVERAGE_MIN_RESULTS
     || local.strongSources<this.config.COVERAGE_MIN_SOURCES)) {
     if (!configuredProviders(this.config).length) providers.push({provider:'discovery',status:'disabled',message:'External discovery is not configured.'});
     else if (!await takeBudget(this.db,`discovery-user:${owner}`,20,'day')) {
       providers.push({provider:'discovery',status:'budget_exhausted',message:'Your daily discovery limit has been reached.'});
     } else {
       const cached=(await this.db.query(`SELECT * FROM jobs WHERE dedupe_key=$1 AND
         (status IN ('queued','running') OR updated_at>=now()-($2*interval '1 second'))`,
         [`discovery:${queryKey(input)}`,this.config.DISCOVERY_CACHE_SECONDS])).rows[0];
       if(cached) job=cached;
       else if(!await takeBudget(this.db,'discovery_jobs',this.config.DISCOVERY_DAILY_BUDGET)) {
         providers.push({provider:'discovery',status:'budget_exhausted',message:'The daily discovery job budget has been reached.'});
       } else {
       // One durable job per normalized query/filter set. Reuse both running work and recent completed results.
       job = (await this.db.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES('discovery',$1,$2)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN 'queued' ELSE jobs.status END,
         attempts=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN 0 ELSE jobs.attempts END,
         result=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN NULL ELSE jobs.result END,
         run_after=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN now() ELSE jobs.run_after END,
         updated_at=CASE WHEN jobs.status IN ('complete','failed') AND jobs.updated_at<now()-($3*interval '1 second') THEN now() ELSE jobs.updated_at END
       RETURNING *`,[`discovery:${queryKey(input)}`,JSON.stringify(input),this.config.DISCOVERY_CACHE_SECONDS])).rows[0];
       }
     }
   }
   const snapshot = (await this.db.query(`INSERT INTO searches(owner,query,filters,ranking_version,results,job_id,provider_status,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8*interval '1 second')) RETURNING *`,
     [owner,input.q,JSON.stringify(input),RANKING_VERSION,JSON.stringify(local.results),job?.id??null,
       JSON.stringify(providers),this.config.SEARCH_TTL_SECONDS])).rows[0];
   return this.page(snapshot,0);
 }
 async owned(id: string, owner: string) {
   const row = (await this.db.query('SELECT * FROM searches WHERE id=$1 AND owner=$2 AND expires_at>now()',[id,owner])).rows[0];
   if (!row) throw new ApiError(404,'search_not_found','This search is unavailable or has expired.');
   return row;
 }
 async poll(id:string,owner:string) { return this.page(await this.owned(id,owner),0); }
 async cancel(id:string,owner:string) {
   await this.owned(id,owner);
   await this.db.query('UPDATE searches SET cancelled=true WHERE id=$1 AND owner=$2',[id,owner]);
   // A shared collection job may still be needed by other searches; cancellation stops this subscription.
   return {status:'cancelled'};
 }
 private async page(initial:any, offset:number): Promise<SearchResponse> {
   let snapshot = initial;
   let job = snapshot.job_id ? (await this.db.query('SELECT status,result FROM jobs WHERE id=$1',[snapshot.job_id])).rows[0] : null;
   if (job?.status==='complete' && !snapshot.discovery_applied && !snapshot.cancelled) {
     snapshot = await this.db.transaction(async tx=>{
       const current = (await tx.query('SELECT * FROM searches WHERE id=$1 FOR UPDATE',[snapshot.id])).rows[0];
       if (current.discovery_applied || current.cancelled) return current;
       const results: Result[] = current.results;
       const seen = new Set(results.map(r=>r.canonical_url));
       // Frozen local order; append provider-ranked unique discoveries so existing pages never shift.
       for (const item of (job.result?.results??[]) as Result[]) {
         if (matchesFilters(item,current.filters) && !seen.has(item.canonical_url)) { results.push(item); seen.add(item.canonical_url); }
       }
       return (await tx.query(`UPDATE searches SET results=$2,provider_status=$3,discovery_applied=true WHERE id=$1 RETURNING *`,
         [current.id,JSON.stringify(results.slice(0,250)),JSON.stringify([...current.provider_status,...(job.result?.providers??[])])])).rows[0];
     });
   }
   const providers: ProviderStatus[] = [...snapshot.provider_status];
   if (job?.status==='failed') providers.push({provider:'discovery',status:'unavailable',message:'External discovery failed. Catalogue results are still available.'});
   if (job && ['running','queued'].includes(job.status) && Date.now()-new Date(snapshot.created_at).getTime()>120000) {
     providers.push({provider:'discovery',status:'unavailable',message:'Discovery is delayed. Try again later.'});
   }
   const all: Result[] = snapshot.results;
   const slice = all.slice(offset,offset+snapshot.filters.limit);
   // Honour revocation/deletion even within an otherwise immutable search snapshot.
   const allowed = slice.length ? (await this.db.query(`SELECT c.id FROM content c JOIN sources s ON s.id=c.source_id
     WHERE c.id=ANY($1::uuid[]) AND s.status='active' AND (s.policy->>'metadata')::boolean=true
     AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
     AND c.availability<>'unavailable' AND c.expires_at>now()`,[slice.map(r=>r.id)])).rows.map(r=>r.id) : [];
   const candidateSources = slice.length ? (await this.db.query(`SELECT id FROM sources WHERE id=ANY($1::uuid[]) AND status='candidate' AND health_status<>'down'`,[slice.map(r=>r.source_id)])).rows.map(r=>r.id) : [];
   const momentIds=slice.flatMap(r=>r.moments.map(m=>m.id));
   const activeMoments=momentIds.length?(await this.db.query(`SELECT m.id FROM moments m JOIN content c ON c.id=m.content_id
     JOIN sources s ON s.id=c.source_id WHERE m.id=ANY($1::uuid[]) AND m.status='active'
     AND (m.evidence_type<>'transcript_supported' OR (s.policy->>'transcripts')::boolean=true)
     AND (m.evidence_type<>'viewer_timestamp' OR (s.policy->>'viewer_signals')::boolean=true)
     UNION ALL SELECT v.id FROM video_scenes v JOIN content c ON c.id=v.content_id JOIN sources s ON s.id=c.source_id
     WHERE v.id=ANY($1::uuid[]) AND ${activeScene}`,[momentIds])).rows.map(r=>r.id):[];
   const analyses = new Map<string,SceneAnalysisStatus>(slice.length?(await this.db.query(`SELECT mv.content_id,mv.version_key,mv.analysis_status,mv.analysis_code
     FROM media_versions mv JOIN content c ON c.id=mv.content_id JOIN sources s ON s.id=c.source_id
     WHERE mv.content_id=ANY($1::uuid[]) AND mv.status='current' AND (s.policy->>'video_analysis')::boolean=true`,
     [slice.map(r=>r.id)])).rows.map(r=>[r.content_id,sceneAnalysisStatus(r)]):[]);
   const results = slice.filter(r=>allowed.includes(r.id) || r.origin==='discovery' && candidateSources.includes(r.source_id))
     .map(r=>{const moments=r.moments.filter(m=>activeMoments.includes(m.id));
       return {...r,moments,evidence:moments[0]?.evidence_type??'metadata_match' as const,scene_analysis:analyses.get(r.id)??null};})
     .filter(r=>matchesFilters(r,snapshot.filters));
   const more = offset+snapshot.filters.limit<all.length;
   return {query:snapshot.query,search_id:snapshot.id,status:snapshot.cancelled?'cancelled':
     job && ['queued','running'].includes(job.status) && Date.now()-new Date(snapshot.created_at).getTime()<=120000?'discovering':
     providers.some(p=>['partial','unavailable','budget_exhausted','disabled'].includes(p.status))?'partial':
     'complete',
     results,has_more:more,next_cursor:more?encodeCursor(this.config,snapshot.id,offset+snapshot.filters.limit):null,
     discovery_job_id:snapshot.job_id,providers,ranking_version:snapshot.ranking_version};
 }
}
