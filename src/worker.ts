import type { DB } from './db.js';
import type { Config } from './config.js';
import type { SourceAdapter, Result } from './types.js';
import { searchInput } from './types.js';
import { configuredProviders, JsonFeed } from './providers.js';
import {checkSource,discoverAlternatives,scheduleHealth} from './source-health.js';
import type {probeURL} from './http.js';
import { takeBudget } from './budgets.js';
import { claim, complete, fail, enqueue } from './queue.js';
import { ingest } from './catalogue.js';
import { contentHash, enrichEmbedding } from './embeddings.js';
import { canonicalize } from './urls.js';

export async function providerHealth(db:DB,provider:string,ok:boolean) {
 await db.query(`INSERT INTO provider_health(provider,failure_count,last_success_at,last_error_code)
 VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END,CASE WHEN $3 THEN NULL ELSE 'unavailable' END)
 ON CONFLICT(provider) DO UPDATE SET failure_count=CASE WHEN $3 THEN 0 ELSE provider_health.failure_count+1 END,
 last_success_at=CASE WHEN $3 THEN now() ELSE provider_health.last_success_at END,
 last_error_code=CASE WHEN $3 THEN NULL ELSE 'unavailable' END,checked_at=now()`,[provider,ok?0:1,ok]);
}
export async function workOnce(db:DB,config:Config,adapters?:SourceAdapter[],probe?:typeof probeURL) {
 const job=await claim(db); if(!job) return false;
 let collectingDomain:string|undefined;
 try {
   if(job.kind==='source_health') {
     await checkSource(db,config,job,probe);
   } else if(job.kind==='source_discovery') {
     await complete(db,job,await discoverAlternatives(db,config,job,adapters));
   } else if(job.kind==='discovery') {
     const input=searchInput.parse(job.payload);
     const providers=adapters??configuredProviders(config);
     const pages=await Promise.all(providers.slice(0,3).map(async adapter=>{
       if(!await takeBudget(db,`discovery:${adapter.name}`,config.DISCOVERY_DAILY_BUDGET)) return {
         results:[],next_cursor:null,status:{provider:adapter.name,status:'budget_exhausted',message:'The daily discovery budget has been reached.'}};
       try { const page=await adapter.search(input.q,input); await providerHealth(db,adapter.name,page.status.status==='ok'); return page; }
       catch { await providerHealth(db,adapter.name,false); return {results:[],next_cursor:null,
         status:{provider:adapter.name,status:'unavailable',message:'External discovery is unavailable. Catalogue results are still available.'}}; }
     }));
     const results:Result[]=[]; const seen=new Set<string>();
     for(const page of pages) for(const item of page.results) {
       const url=canonicalize(item.url); if(seen.has(url)) continue; seen.add(url);
       const result=await ingest(db,item,{adapter:page.status.provider,method:'search',discovered_at:new Date().toISOString()});
       if(result) {results.push(result); await enqueueEnrichment(db,config,result);}
     }
     await complete(db,job,{results,providers:pages.map(p=>p.status)});
   } else if(job.kind==='collect') {
     const source=(await db.query(`SELECT * FROM sources WHERE id=$1 AND status='active' AND adapter='json_feed' AND health_status<>'down'`,[job.payload.source_id])).rows[0];
     if(source && source.policy.metadata===true) {
       collectingDomain=source.active_domain;
       const page=await new JsonFeed().listUpdates(source);
       let collected=0;
       for(const item of page.results) {
         if(new URL(canonicalize(item.url)).hostname!==source.active_domain) continue;
         const result=await ingest(db,item,{adapter:'json_feed',method:'approved_feed',fetched_at:new Date().toISOString()});
         if(result) {collected++;await enqueueEnrichment(db,config,result);}
       }
       await db.query(`UPDATE sources SET cursor=$2,last_success_at=now(),failure_count=0,
         reliability=least(1,reliability+0.02),next_check_at=now()+($3*interval '1 hour') WHERE id=$1 AND active_domain=$4 AND feed_url=$5`,
         [source.id,page.next_cursor,page.next_cursor?1:collected?config.SOURCE_REFRESH_HOURS:Math.min(720,config.SOURCE_REFRESH_HOURS*2),source.active_domain,source.feed_url]);
       await complete(db,job,{collected});
     } else await complete(db,job,{status:'source_ineligible'});
   } else {
     await enrichEmbedding(db,config,job.payload.content_id);
     await complete(db,job,{status:config.SEMANTIC_ENABLED?'processed':'provider_not_configured'});
   }
 } catch {
   if(job.kind==='collect' && collectingDomain) await db.query(`UPDATE sources SET failure_count=failure_count+1,
     reliability=greatest(0,reliability-0.1),status=CASE WHEN failure_count>=4 THEN 'paused' ELSE status END,
     next_check_at=now()+(least(168,power(2,failure_count+1))*interval '1 hour') WHERE id=$1 AND active_domain=$2`,[job.payload.source_id,collectingDomain]);
   await fail(db,job,'processing_failed');
 }
 return true;
}
async function enqueueEnrichment(db:DB,config:Config,result:Result) {
 if(!config.SEMANTIC_ENABLED || !await takeBudget(db,'enrichment_jobs',config.EMBEDDING_DAILY_BUDGET)) return;
 if(!(await db.query('SELECT 1 FROM content WHERE id=$1',[result.id])).rows.length) return;
 await enqueue(db,'enrich',`enrich:${result.id}:${config.EMBEDDING_MODEL}:${contentHash(result.title+'\n'+(result.description??''))}`,{content_id:result.id});
}
export async function schedule(db:DB,config:Config) {
 await scheduleHealth(db,config);
 await db.transaction(async tx=>{
   const sources=(await tx.query(`SELECT * FROM sources WHERE status='active' AND adapter='json_feed' AND health_status<>'down'
     AND next_check_at<=now() ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 10`)).rows;
   for(const source of sources) {
     if(!await takeBudget(tx,'scheduled_collections',config.DISCOVERY_DAILY_BUDGET)) break;
     if(!(await tx.query(`SELECT 1 FROM jobs WHERE kind='collect' AND payload->>'source_id'=$1 AND status IN ('queued','running')`,[source.id])).rows.length) {
       await enqueue(tx,'collect',`collect:${source.id}:${new Date(source.next_check_at).toISOString()}`,{source_id:source.id});
     }
     await tx.query(`UPDATE sources SET next_check_at=now()+($2*interval '1 hour') WHERE id=$1`,[source.id,config.SOURCE_REFRESH_HOURS]);
   }
 });
 // Erase short-lived queries and provider payloads; retained catalogue metadata follows source policy.
 await db.query('DELETE FROM searches WHERE expires_at<=now()');
 await db.query(`DELETE FROM jobs WHERE status IN ('complete','failed') AND updated_at<now()-interval '1 hour'
   AND NOT EXISTS(SELECT 1 FROM searches s WHERE s.job_id=jobs.id)`);
 await db.query(`DELETE FROM budgets WHERE window_start<now()-interval '2 days'`);
 await db.query(`DELETE FROM feedback WHERE updated_at<now()-interval '90 days'`);
 await db.query(`DELETE FROM content WHERE expires_at<=now()`);
 await db.query(`DELETE FROM sources WHERE status='candidate' AND created_at<now()-interval '30 days'`);
}
