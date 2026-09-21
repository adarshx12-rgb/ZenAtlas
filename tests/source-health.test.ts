import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {addSource,setAlternative,checkSource,discoverAlternatives,scheduleHealth,nextCheckMinutes} from '../src/source-health.js';
import {claim,enqueue} from '../src/queue.js';
import {UpstreamError,type ProbeResponse} from '../src/http.js';
import {SearchService} from '../src/search.js';
import {ingest} from '../src/catalogue.js';
import {contentInput,searchInput,type SourceAdapter} from '../src/types.js';
import {GoogleSearch,BraveSearch,configuredProviders} from '../src/providers.js';
import {workOnce} from '../src/worker.js';
import {createApp} from '../src/app.js';

const healthy=async(url:string):Promise<ProbeResponse>=>({status:200,url,redirects:[]});
async function runHealth(db:any,id:string,probe:typeof healthy){
 await enqueue(db,'source_health',`test:${crypto.randomUUID()}`,{source_id:id});
 // Health jobs are selected explicitly because an earlier down check can also enqueue a source-discovery job.
 const row=(await db.query("SELECT id FROM jobs WHERE kind='source_health' AND status='queued' ORDER BY created_at LIMIT 1")).rows[0];
 await db.query("UPDATE jobs SET status='running',lease_token=gen_random_uuid(),attempts=attempts+1,lease_until=now()+interval '90 seconds' WHERE id=$1",[row.id]);
 const job=(await db.query('SELECT * FROM jobs WHERE id=$1',[row.id])).rows[0];
 await checkSource(db,testConfig,job,probe);return job;
}

test('repeated outages replace only a verified working domain, preserve identity and hide old URLs',async()=>{
 const db=await database();
 try{
   const item=await fixture(db);const service=new SearchService(db,testConfig);
   const before=await service.start({q:'bedroom',mode:'catalogue'},'alice');
   await setAlternative(db,item.source_id,{url:'https://mirror.example.org',status:'verified',review_note:'TEST: source owner confirms this domain is its official mirror.'});
   const probe=async(url:string)=>{if(new URL(url).hostname==='videos.example.com')throw new UpstreamError('network_error');return healthy(url);};
   await runHealth(db,item.source_id,probe);await runHealth(db,item.source_id,probe);
   let source=(await db.query('SELECT * FROM sources WHERE id=$1',[item.source_id])).rows[0];
   assert.equal(source.active_domain,'videos.example.com');assert.equal(source.health_status,'degraded');
   await runHealth(db,item.source_id,probe);
   source=(await db.query('SELECT * FROM sources WHERE id=$1',[item.source_id])).rows[0];
   assert.equal(source.active_domain,'mirror.example.org');assert.equal(source.domain,'videos.example.com');assert.equal(source.health_status,'healthy');
   assert.equal((await service.poll(before.search_id,'alice')).results.length,0,'old snapshots hide unavailable domain URLs');
   assert.equal((await db.query('SELECT canonical_url FROM content WHERE id=$1',[item.id])).rows[0].canonical_url,item.canonical_url,'no fabricated path rewrite');
   assert.equal((await db.query("SELECT * FROM source_health_events WHERE kind='switch'")).rows.length,1);
   const added=await ingest(db,contentInput.parse({url:'https://mirror.example.org/real-content/42',title:'Bright bedroom actual replacement listing'}),{fixture:true});
   assert.equal(added!.source_id,item.source_id);assert.equal((await service.start({q:'bedroom',mode:'catalogue'},'alice')).results.length,1);
   assert.equal((await addSource(db,'https://mirror.example.org')).id,item.source_id,'mirror is not a new duplicate source');
 }finally{await db.close();}
});

test('temporary errors recover; blocking/rate limits do not establish an outage; candidates never auto-promote',async()=>{
 const db=await database();
 try{
   const item=await fixture(db);
   await setAlternative(db,item.source_id,{url:'https://videos.example.net',status:'candidate',review_note:'TEST: similarly named search result is unverified.'});
   await runHealth(db,item.source_id,async()=>{throw new UpstreamError('timeout');});
   await runHealth(db,item.source_id,healthy);
   assert.equal((await db.query('SELECT health_failures FROM sources WHERE id=$1',[item.source_id])).rows[0].health_failures,0);
   for(let i=0;i<3;i++)await runHealth(db,item.source_id,async url=>({url,status:403,redirects:[]}));
   assert.equal((await db.query('SELECT health_status FROM sources WHERE id=$1',[item.source_id])).rows[0].health_status,'blocked');
   for(let i=0;i<3;i++)await runHealth(db,item.source_id,async url=>({url,status:503,redirects:[]}));
   const source=(await db.query('SELECT * FROM sources WHERE id=$1',[item.source_id])).rows[0];
   assert.equal(source.health_status,'down');assert.equal(source.active_domain,'videos.example.com');
   assert.equal((await db.query("SELECT * FROM jobs WHERE kind='source_discovery'")).rows.length,1);
   await db.query("DELETE FROM jobs WHERE kind='source_discovery'");
   await runHealth(db,item.source_id,async url=>({url,status:503,redirects:[]}));
   assert.equal((await db.query("SELECT * FROM jobs WHERE kind='source_discovery'")).rows.length,0,'discovery cooldown survives job cleanup');
   assert.equal((await new SearchService(db,testConfig).start({q:'bedroom',mode:'catalogue'},'alice')).results.length,0);
   await runHealth(db,item.source_id,healthy);
   assert.equal((await new SearchService(db,testConfig).start({q:'bedroom',mode:'catalogue'},'alice')).results.length,1);
 }finally{await db.close();}
});

test('feed failover requires an explicit healthy feed; known provider IDs use returned new URLs',async()=>{
 const db=await database();
 try{
   const item=await fixture(db);await db.query("UPDATE content SET provider_id='stable-42' WHERE id=$1",[item.id]);
   await db.query("UPDATE sources SET adapter='json_feed',feed_url='https://videos.example.com/feed',health_failures=2 WHERE id=$1",[item.source_id]);
   await setAlternative(db,item.source_id,{url:'https://mirror.example.org',status:'verified',review_note:'TEST official alternative, feed not yet configured'});
   const probe=async(url:string)=>new URL(url).hostname==='videos.example.com'?{url,status:503,redirects:[]}:healthy(url);
   await runHealth(db,item.source_id,probe);
   assert.equal((await db.query('SELECT active_domain FROM sources WHERE id=$1',[item.source_id])).rows[0].active_domain,'videos.example.com');
   await setAlternative(db,item.source_id,{url:'https://mirror.example.org',feed_url:'https://mirror.example.org/new-feed',status:'verified',review_note:'TEST approved feed and official alternative confirmed'});
   await runHealth(db,item.source_id,probe);
   const source=(await db.query('SELECT * FROM sources WHERE id=$1',[item.source_id])).rows[0];
   assert.equal(source.active_domain,'mirror.example.org');assert.equal(source.feed_url,'https://mirror.example.org/new-feed');assert.equal(source.cursor,null);
   const updated=await ingest(db,contentInput.parse({url:'https://mirror.example.org/entirely-different-path',provider_id:'stable-42',title:'Bright bedroom new feed entry'}),{fixture:true});
   assert.equal(updated!.id,item.id);assert.equal(updated!.canonical_url,'https://mirror.example.org/entirely-different-path');
 }finally{await db.close();}
});

test('durable health scheduling includes link-only candidates, deduplicates work and fences stale workers',async()=>{
 const db=await database();
 try{
   const source=await addSource(db,'https://health.example.org');
   await scheduleHealth(db,testConfig);await scheduleHealth(db,testConfig);
   assert.equal((await db.query("SELECT * FROM jobs WHERE kind='source_health'")).rows.length,1);
   const old=await claim(db);await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);
   const recovered=await claim(db);
   await checkSource(db,testConfig,old,healthy);
   assert.equal((await db.query('SELECT health_checked_at FROM sources WHERE id=$1',[source.id])).rows[0].health_checked_at,null);
   await checkSource(db,testConfig,recovered,healthy);
   assert.equal((await db.query('SELECT health_status FROM sources WHERE id=$1',[source.id])).rows[0].health_status,'healthy');
   await checkSource(db,testConfig,recovered,healthy);
   assert.equal((await db.query('SELECT * FROM source_health_events')).rows.length,1);
 }finally{await db.close();}
});

test('approved sources are watched closely, unreviewed candidates on a slow cadence whatever the outcome',()=>{
 const config={...testConfig,SOURCE_HEALTH_HOURS:6,SOURCE_HEALTH_RETRY_MINUTES:15,SOURCE_HEALTH_CANDIDATE_HOURS:168};
 assert.equal(nextCheckMinutes(config,'active','healthy'),6*60);
 assert.equal(nextCheckMinutes(config,'active','blocked'),6*60);
 assert.equal(nextCheckMinutes(config,'active','failure'),15,'an approved source that fails is retried soon');
 for(const state of ['healthy','blocked','failure'] as const)
   assert.equal(nextCheckMinutes(config,'candidate',state),168*60,`a candidate is only looked at weekly (${state}), so a dead domain is not probed every 15 minutes forever`);
});

test('a failing candidate waits a week for its next probe, while a failing approved source is retried soon',async()=>{
 const db=await database();
 try{
   const candidate=await addSource(db,'https://unreviewed.example.org');
   const approved=await fixture(db);
   const failing=async(url:string):Promise<ProbeResponse>=>({url,status:503,redirects:[]});
   await runHealth(db,candidate.id,failing);await runHealth(db,approved.source_id,failing);
   const wait=async(id:string)=>Number((await db.query('SELECT extract(epoch FROM health_next_at-now())/3600 AS hours FROM sources WHERE id=$1',[id])).rows[0].hours);
   assert.ok(await wait(candidate.id)>167,'candidate: about 168 hours');
   assert.ok(await wait(approved.source_id)<1,'approved source: minutes');
 }finally{await db.close();}
});

test('when the probe budget is short, approved sources are scheduled before older-due candidates',async()=>{
 const db=await database();
 try{
   const candidate=await addSource(db,'https://older-due.example.org');
   const approved=await fixture(db);
   await db.query("UPDATE sources SET health_next_at=now()-interval '3 days' WHERE id=$1",[candidate.id]);
   await db.query("UPDATE sources SET health_next_at=now()-interval '1 hour' WHERE id=$1",[approved.source_id]);
   await scheduleHealth(db,{...testConfig,SOURCE_HEALTH_DAILY_BUDGET:1});
   const queued=(await db.query("SELECT payload->>'source_id' AS id FROM jobs WHERE kind='source_health'")).rows.map(r=>r.id);
   assert.deepEqual(queued,[approved.source_id],'the one probe of the day goes to the approved source, not the candidate that has waited longer');
 }finally{await db.close();}
});

test('alternative discovery records reviewed candidates from independent providers and isolates failures',async()=>{
 const db=await database();
 try{
   const item=await fixture(db);await db.query("UPDATE sources SET health_status='down' WHERE id=$1",[item.source_id]);
   const adapter:SourceAdapter={name:'mock-google',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},async search(){return {
     results:[contentInput.parse({url:'https://mirror.example.org',title:'Claimed official replacement'})],next_cursor:null,status:{provider:'mock-google',status:'ok',message:'fixture'}};}};
   const result=await discoverAlternatives(db,testConfig,{payload:{source_id:item.source_id}},[adapter,{...adapter,name:'mock-outage',async search(){throw Error('private-key');}}]);
   assert.equal(result.status,'review_candidates');
   const alternatives=(await db.query('SELECT * FROM source_alternatives')).rows;
   assert.equal(alternatives.length,1);assert.equal(alternatives[0].status,'candidate');
   assert.equal((await db.query('SELECT active_domain FROM sources WHERE id=$1',[item.source_id])).rows[0].active_domain,'videos.example.com');
   assert.ok(!JSON.stringify(result).includes('private-key'));
   await assert.rejects(setAlternative(db,item.source_id,{url:'http://127.0.0.1',status:'verified',review_note:'TEST invalid private alternative'}));
   await assert.rejects(setAlternative(db,item.source_id,{url:'https://mirror.example.org',feed_url:'https://different.example.org/feed',status:'verified',review_note:'TEST mismatched feed origin'}));
 }finally{await db.close();}
});

test('Google and Brave adapters use documented APIs and discovery runs without SearXNG',async()=>{
 const config={...testConfig,GOOGLE_SEARCH_API_KEY:'test-key',GOOGLE_SEARCH_ENGINE_ID:'test-engine',BRAVE_SEARCH_API_KEY:'test-brave'};
 const requests:any[]=[];const input=searchInput.parse({q:'"official site" -fake'});
 const google=new GoogleSearch(config,async(url,options)=>{requests.push({url,options});return {items:[{link:'https://example.org/video/1',title:'Google result',snippet:'Description'},{link:'javascript:alert(1)',title:'Bad'}],queries:{nextPage:[{startIndex:11}]}};});
 const g=await google.search(input.q,input);assert.equal(g.results.length,1);assert.equal(g.next_cursor,'11');
 assert.equal(new URL(requests[0].url).hostname,'customsearch.googleapis.com');assert.equal(new URL(requests[0].url).searchParams.get('q'),input.q);
 const brave=new BraveSearch(config,async(url,options)=>{requests.push({url,options});return {web:{results:[{url:'https://example.org/video/2',title:'Brave result',description:'Description'}]},query:{more_results_available:true}};});
 assert.equal((await brave.search(input.q,input)).next_cursor,'1');assert.equal(requests[1].options.headers['X-Subscription-Token'],'test-brave');
 assert.deepEqual(configuredProviders(config).map(p=>p.name),['google','brave']);
 const db=await database();
 try{
   const service=new SearchService(db,config);const started=await service.start({q:'official site',mode:'auto'},'alice');
   assert.equal(started.status,'discovering');await workOnce(db,config,[google,brave]);
   const done=await service.poll(started.search_id,'alice');assert.equal(done.status,'complete');assert.equal(done.results.length,2);
 }finally{await db.close();}
});

test('source and alternative management require administrative access',async()=>{
 const db=await database();const app=await createApp(db,testConfig);
 try{
   const headers={'x-requested-with':'CreatorSearch'};
   assert.equal((await app.inject({method:'POST',url:'/api/admin/sources',headers,payload:{url:'https://site.example.org'}})).statusCode,403);
   const auth={...headers,authorization:`Bearer ${testConfig.ADMIN_TOKEN}`};
   const response=await app.inject({method:'POST',url:'/api/admin/sources',headers:auth,payload:{url:'https://site.example.org',name:'Test source'}});
   assert.equal(response.statusCode,200);const source=response.json();
   assert.equal((await app.inject(`/api/admin/sources/${source.id}/alternatives`)).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:`/api/admin/sources/${source.id}/alternatives`,headers:auth,payload:{url:'https://site.example.net',status:'verified',review_note:'TEST approved source-owner mirror'}})).statusCode,200);
 }finally{await app.close();await db.close();}
});
