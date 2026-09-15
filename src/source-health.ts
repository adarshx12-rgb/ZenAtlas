import {z} from 'zod';
import type {DB} from './db.js';
import type {Config} from './config.js';
import {publicURL} from './urls.js';
import {probeURL,UpstreamError,type ProbeResponse} from './http.js';
import {configuredProviders} from './providers.js';
import {searchInput,type SourceAdapter} from './types.js';
import {takeBudget} from './budgets.js';
import {enqueue,complete} from './queue.js';

export const alternativeInput=z.object({url:z.string().url().max(2048),status:z.enum(['verified','rejected','candidate']),
 feed_url:z.string().url().max(2048).nullable().default(null),review_note:z.string().min(10).max(2000),
 evidence_url:z.string().url().max(2048).optional()}).strict();

export async function addSource(db:DB,url:string,name?:string){
 const domain=publicURL(url).hostname;
 const label=z.string().min(1).max(300).parse(name??domain);
 const existing=(await db.query(`SELECT s.id,s.domain,s.active_domain,s.status FROM sources s WHERE domain=$1 OR active_domain=$1
   OR EXISTS(SELECT 1 FROM source_alternatives a WHERE a.source_id=s.id AND a.domain=$1 AND a.status='verified') LIMIT 1`,[domain])).rows[0];
 if(existing)return existing;
 return (await db.query(`INSERT INTO sources(domain,display_name,provenance) VALUES($1,$2,'{"method":"admin_source_submission"}')
   ON CONFLICT(domain) DO UPDATE SET domain=excluded.domain RETURNING id,domain,active_domain,status`,[domain,label])).rows[0];
}

export async function setAlternative(db:DB,sourceId:string,raw:unknown){
 const input=alternativeInput.parse(raw);const target=publicURL(input.url);
 if(target.protocol!=='https:')throw Error('Alternative must use HTTPS');
 if(input.evidence_url)publicURL(input.evidence_url);
 if(input.feed_url && publicURL(input.feed_url).hostname!==target.hostname)throw Error('Feed must belong to the alternative domain');
 return db.transaction(async tx=>{
   const source=(await tx.query('SELECT * FROM sources WHERE id=$1 FOR UPDATE',[sourceId])).rows[0];
   if(!source)throw Error('Unknown source');
   if(source.active_domain===target.hostname)throw Error('Alternative must differ from the active domain');
   if((await tx.query('SELECT 1 FROM sources WHERE id<>$1 AND (domain=$2 OR active_domain=$2)',[sourceId,target.hostname])).rows.length)throw Error('Domain already belongs to another source');
   const row=(await tx.query(`INSERT INTO source_alternatives(source_id,domain,status,feed_url,evidence) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(source_id,domain) DO UPDATE SET status=$3,feed_url=$4,evidence=$5 RETURNING *`,[sourceId,target.hostname,input.status,input.feed_url,
       JSON.stringify({method:'administrator_review',review_note:input.review_note,evidence_url:input.evidence_url??null,reviewed_at:new Date().toISOString()})])).rows[0];
   await tx.query('UPDATE sources SET health_next_at=now() WHERE id=$1',[sourceId]);
   return row;
 });
}

async function candidate(db:DB,sourceId:string,domain:string,evidence:unknown){
 publicURL(`https://${domain}/`);
 await db.transaction(async tx=>{
   const source=(await tx.query('SELECT * FROM sources WHERE id=$1 FOR UPDATE',[sourceId])).rows[0];
   if(!source || source.status==='rejected' || [source.domain,source.active_domain].includes(domain))return;
   if((await tx.query('SELECT 1 FROM sources WHERE domain=$1 OR active_domain=$1',[domain])).rows.length)return;
   if((await tx.query('SELECT count(*)::int AS count FROM source_alternatives WHERE source_id=$1',[sourceId])).rows[0].count>=20)return;
   await tx.query(`INSERT INTO source_alternatives(source_id,domain,evidence) VALUES($1,$2,$3) ON CONFLICT(source_id,domain) DO NOTHING`,[sourceId,domain,JSON.stringify(evidence)]);
 });
}

type Probe=(url:string,timeoutMs?:number)=>Promise<ProbeResponse>;
type Observation={state:'healthy'|'failure'|'blocked'|'budget';code:string;redirect_domain?:string};
async function observe(db:DB,config:Config,domain:string,probe:Probe,url=`https://${domain}/`):Promise<Observation>{
 if(!await takeBudget(db,'source_health_probes',config.SOURCE_HEALTH_DAILY_BUDGET))return {state:'budget',code:'budget_exhausted'};
 try{
   const response=await probe(url,config.PROVIDER_TIMEOUT_MS);
   const target=publicURL(response.url);
   if(target.hostname!==domain)return {state:'failure',code:'cross_domain_redirect',redirect_domain:target.hostname};
   if([401,403,429].includes(response.status))return {state:'blocked',code:`http_${response.status}`};
   return response.status>=200&&response.status<300?{state:'healthy',code:`http_${response.status}`}:{state:'failure',code:`http_${response.status}`};
 }catch(error){
   const code=error instanceof UpstreamError?error.code:'network_error';
   return {state:['unsafe_url','unsafe_destination','unsafe_redirect'].includes(code)?'blocked':'failure',code};
 }
}

export async function checkSource(db:DB,config:Config,job:any,probe:Probe=probeURL){
 const source=(await db.query("SELECT * FROM sources WHERE id=$1 AND status<>'rejected'",[job.payload.source_id])).rows[0];
 if(!source){await complete(db,job,{status:'source_ineligible'});return;}
 if((await db.query("SELECT 1 FROM source_health_events WHERE job_id=$1 AND kind='check'",[job.id])).rows.length){await complete(db,job,{status:'already_checked'});return;}
 const observation=await observe(db,config,source.active_domain,probe);
 if(observation.redirect_domain)await candidate(db,source.id,observation.redirect_domain,{method:'observed_redirect',from:source.active_domain,observed_at:new Date().toISOString()});
 const failures=observation.state==='failure'?source.health_failures+1:0;
 const down=observation.state==='failure' && failures>=config.SOURCE_HEALTH_FAILURES;
 const alternatives:any[]=[];let replacement:any=null;
 if(down && source.status==='active'){
   const rows=(await db.query(`SELECT * FROM source_alternatives WHERE source_id=$1 AND status='verified' AND domain<>$2
     ORDER BY checked_at NULLS FIRST,domain LIMIT 3`,[source.id,source.active_domain])).rows;
   for(const row of rows){
     const health=await observe(db,config,row.domain,probe);
     alternatives.push({...row,health});
     if(health.state!=='healthy')continue;
     if(source.adapter==='json_feed'){
       if(!row.feed_url)continue; // A domain change does not establish a feed path/contract.
       const feed=await observe(db,config,row.domain,probe,row.feed_url);
       if(feed.state!=='healthy')continue;
     }
     replacement=row;break;
   }
 }
 await db.transaction(async tx=>{
   const current=(await tx.query('SELECT * FROM sources WHERE id=$1 FOR UPDATE',[source.id])).rows[0];
   const lease=(await tx.query("SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",[job.id,job.lease_token])).rows[0];
   if(!lease)return;
   if(!current || current.status==='rejected' || current.active_domain!==source.active_domain || current.health_checked_at?.getTime()!==source.health_checked_at?.getTime()){
     await complete(tx,job,{status:'superseded'});return;
   }
   if(observation.state==='budget'){await complete(tx,job,{status:'budget_exhausted'});return;}
   await tx.query(`UPDATE sources SET health_status=$2,health_failures=$3,health_checked_at=now(),health_code=$4,
     health_next_at=now()+($5*interval '1 minute') WHERE id=$1`,[source.id,
     observation.state==='healthy'?'healthy':observation.state==='blocked'?'blocked':down?'down':'degraded',failures,observation.code,
     observation.state==='failure'?config.SOURCE_HEALTH_RETRY_MINUTES:config.SOURCE_HEALTH_HOURS*60]);
   await tx.query(`INSERT INTO source_health_events(source_id,kind,from_domain,code,job_id) VALUES($1,'check',$2,$3,$4)`,[source.id,source.active_domain,observation.code,job.id]);
   for(const row of alternatives)await tx.query('UPDATE source_alternatives SET checked_at=now(),last_health=$2 WHERE id=$1',[row.id,row.health.code]);
   // Recheck approval and domain ownership after probes; an administrator may have revoked the alternative meanwhile.
   const approved=replacement?(await tx.query("SELECT * FROM source_alternatives WHERE id=$1 AND status='verified' FOR UPDATE",[replacement.id])).rows[0]:null;
   const taken=replacement?(await tx.query('SELECT 1 FROM sources WHERE id<>$1 AND (domain=$2 OR active_domain=$2)',[source.id,replacement.domain])).rows.length:0;
   if(approved && !taken && current.status==='active' && current.adapter===source.adapter && approved.feed_url===replacement.feed_url){
     await tx.query(`INSERT INTO source_alternatives(source_id,domain,status,feed_url,evidence) VALUES($1,$2,'verified',$3,$4)
       ON CONFLICT(source_id,domain) DO NOTHING`,[source.id,source.active_domain,source.feed_url,JSON.stringify({method:'previous_active_endpoint'})]);
     await tx.query(`UPDATE sources SET active_domain=$2,feed_url=$3,cursor=NULL,health_status='healthy',health_failures=0,
       health_code='verified_alternative',health_next_at=now()+($4*interval '1 hour'),next_check_at=now(),failure_count=0 WHERE id=$1`,
       [source.id,replacement.domain,source.adapter==='json_feed'?replacement.feed_url:source.feed_url,config.SOURCE_HEALTH_HOURS]);
     await tx.query(`INSERT INTO source_health_events(source_id,kind,from_domain,to_domain,code,job_id)
       VALUES($1,'switch',$2,$3,'verified_alternative',$4)`,[source.id,source.active_domain,replacement.domain,job.id]);
     // Original content URLs and evidence remain untouched. Only actual content on the active domain is eligible.
     if(configuredProviders(config).length && await takeBudget(tx,'discovery_jobs',config.DISCOVERY_DAILY_BUDGET)){
       await enqueue(tx,'discovery',`replacement-content:${source.id}:${replacement.domain}:${new Date().toISOString().slice(0,10)}`,
         searchInput.parse({q:`site:${replacement.domain}`,mode:'refresh',source:source.id}));
     }
     await complete(tx,job,{status:'replaced',from:source.active_domain,to:replacement.domain});
   }else{
     if(down && current.status==='active' && new Date(current.alternatives_next_search_at).getTime()<=Date.now()
       && await takeBudget(tx,'source_alternative_jobs',config.DISCOVERY_DAILY_BUDGET)){
       await enqueue(tx,'source_discovery',`source-discovery:${source.id}:${new Date().toISOString().slice(0,10)}`,{source_id:source.id});
       await tx.query("UPDATE sources SET alternatives_next_search_at=now()+interval '1 day' WHERE id=$1",[source.id]);
     }
     await complete(tx,job,{status:down?'down':observation.state});
   }
 });
}

export async function discoverAlternatives(db:DB,config:Config,job:any,adapters?:SourceAdapter[]){
 const source=(await db.query("SELECT * FROM sources WHERE id=$1 AND status='active' AND health_status='down'",[job.payload.source_id])).rows[0];
 if(!source)return {status:'source_ineligible'};
 const input=searchInput.parse({q:`${source.domain} official website new domain`,mode:'refresh'});
 const providers=adapters??configuredProviders(config,'sources');
 const pages=await Promise.all(providers.slice(0,3).map(async provider=>{
   if(!await takeBudget(db,`discovery:${provider.name}`,config.DISCOVERY_DAILY_BUDGET))return {provider:provider.name,status:'budget_exhausted',results:[]};
   try{const page=await provider.search(input.q,input);return {provider:provider.name,status:page.status.status,results:page.results};}
   catch{return {provider:provider.name,status:'unavailable',results:[]};}
 }));
 for(const page of pages)for(const item of page.results.slice(0,10)){
   try{const domain=publicURL(item.url).hostname;await candidate(db,source.id,domain,{method:'search_result',provider:page.provider,url:item.url,observed_at:new Date().toISOString()});}
   catch{/* Invalid candidate URLs cannot abort other discoveries. */}
 }
 return {status:providers.length?'review_candidates':'discovery_not_configured',providers:pages.map(p=>({provider:p.provider,status:p.status}))};
}

export async function scheduleHealth(db:DB,config:Config){
 await db.transaction(async tx=>{
   const sources=(await tx.query(`SELECT * FROM sources WHERE status<>'rejected' AND health_next_at<=now()
     ORDER BY health_next_at FOR UPDATE SKIP LOCKED LIMIT 10`)).rows;
   for(const source of sources){
     if((await tx.query("SELECT 1 FROM jobs WHERE kind='source_health' AND payload->>'source_id'=$1 AND status IN ('queued','running')",[source.id])).rows.length)continue;
     if(!await takeBudget(tx,'source_health_jobs',config.SOURCE_HEALTH_DAILY_BUDGET))break;
     await enqueue(tx,'source_health',`health:${source.id}:${new Date(source.health_next_at).toISOString()}`,{source_id:source.id});
     await tx.query("UPDATE sources SET health_next_at=now()+($2*interval '1 hour') WHERE id=$1",[source.id,config.SOURCE_HEALTH_HOURS]);
   }
 });
 await db.query("DELETE FROM source_health_events WHERE created_at<now()-interval '90 days'");
 await db.query("DELETE FROM source_alternatives WHERE status='candidate' AND created_at<now()-interval '30 days'");
}
