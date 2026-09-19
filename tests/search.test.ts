import {test} from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, testConfig } from './helpers.js';
import { SearchService } from '../src/search.js';
import { ingest, matchesFilters } from '../src/catalogue.js';
import { contentInput, searchInput, type SourceAdapter } from '../src/types.js';
import { workOnce, schedule } from '../src/worker.js';
import { enqueue, claim, complete } from '../src/queue.js';
import { importTranscript, transcriptWindows } from '../src/moments.js';
import { createApp } from '../src/app.js';
import { setSourcePolicy, removeContent } from '../src/admin.js';
import { migrate } from '../src/migrate.js';
import { signMedia } from '../src/signing.js';

test('PostgreSQL catalogue/API, ownership, filters, evidence and stable pagination',async()=>{
 const db=await database();const app=await createApp(db,testConfig);
 try{
   await migrate(db); // Versioned migrations are repeatable.
   const first=await fixture(db);await fixture(db,'Bright bedroom garden tour');
   const service=new SearchService(db,testConfig);
   const result=await service.start({q:'bright bedroom',mode:'catalogue',limit:1},'alice');
   assert.equal(result.status,'complete');assert.equal(result.results.length,1);assert.equal(result.has_more,true);
   assert.equal(result.results[0].moments.length,0);assert.equal(result.results[0].rights_status,'unknown');
   await fixture(db,'Bright bedroom additional tour');
   const page2=await service.start({q:'bright bedroom',mode:'catalogue',limit:1,cursor:result.next_cursor},'alice');
   assert.notEqual(page2.results[0].id,result.results[0].id);assert.equal(page2.has_more,false);
   await assert.rejects(service.poll(result.search_id,'bob'),/unavailable/);
   await assert.rejects(service.start({q:'different',mode:'catalogue',limit:1,cursor:result.next_cursor},'alice'),/original query/);
   assert.equal((await service.start({q:'bedroom',mode:'catalogue',language:'hi'},'alice')).results.length,0);
   // A recorded language that differs is a mismatch; a language nobody recorded is not. Search
   // providers almost never report one, so treating unknown as a mismatch made every language
   // filter return nothing at all, whichever language was asked for.
   const unknownLanguage=(await ingest(db,contentInput.parse({url:`https://videos.example.com/watch/${crypto.randomUUID()}`,
     title:'Bedroom tour of unrecorded language',description:'A bedroom tour',duration:120,availability:'available'}),{fixture:true}))!;
   assert.equal(unknownLanguage.language,null);
   const hindi=await service.start({q:'bedroom',mode:'catalogue',language:'hi'},'alice');
   assert.ok(hindi.results.some(r=>r.id===unknownLanguage.id),'an unrecorded language must pass a language filter');
   assert.ok(!hindi.results.some(r=>r.id===first.id),'a recorded language that differs stays excluded');
   // The same rule for discovery results, which are filtered in memory rather than by the query.
   assert.equal(matchesFilters({...first,language:null},{language:'hi',evidence:'any'}),true);
   assert.equal(matchesFilters(first,{language:'hi',evidence:'any'}),false);
   assert.equal(matchesFilters({...first,language:'hi'},{language:'hi',evidence:'any'}),true);
   assert.equal((await service.start({q:'bedroom',mode:'catalogue',evidence:'video_analysed'},'alice')).results.length,0);
   await importTranscript(db,{content_id:first.id,language:'en',origin:'TEST FIXTURE',content_version:'1',timing_quality:'provided',retention_permitted:true,
     segments:[{start:0,end:10,text:'The kitchen has oak cabinets.'},{start:50,end:65,text:'The bright bedroom has a balcony.'}]});
   const moments=await service.start({q:'balcony',mode:'catalogue'},'alice');
   assert.equal(moments.results[0].evidence,'transcript_supported');assert.equal(moments.results[0].moments[0].end_seconds,65);
   await assert.rejects(importTranscript(db,{content_id:first.id,language:'en',origin:'TEST FIXTURE',content_version:'2',timing_quality:'provided',retention_permitted:true,
     segments:[{start:100,end:150,text:'Invalid beyond duration'}]}));
   assert.equal((await service.start({q:'balcony',mode:'catalogue'},'alice')).results.length,1,'failed import rolls back');
   await db.query("UPDATE transcript_segments SET text='Updated source text' WHERE content_id=$1",[first.id]);
   assert.equal((await service.poll(moments.search_id,'alice')).results[0].moments.length,0,'old snapshots cannot expose stale evidence');
   await assert.rejects(db.query('UPDATE content SET duration=5 WHERE id=$1',[first.id]));
   const response=await app.inject('/api/search?q=bedroom&mode=catalogue');assert.equal(response.statusCode,200);
   const cookie=String(response.headers['set-cookie']).split(';')[0];const data=response.json();
   assert.equal((await app.inject(`/api/search/${data.search_id}`)).statusCode,404);
   assert.equal((await app.inject({url:`/api/search/${data.search_id}`,headers:{cookie}})).statusCode,200);
   assert.equal((await app.inject('/api/search?q=x&unsupported=true')).statusCode,400);
   assert.equal((await app.inject('/api/admin/sources')).statusCode,403);
   assert.equal((await app.inject('/api/thumbnail')).statusCode,400,'url is required');
   const internal='http://127.0.0.1/x.jpg';
   const badThumb=await app.inject(`/api/thumbnail?${new URLSearchParams({url:internal,sig:signMedia(testConfig,internal)})}`);
   assert.equal(badThumb.statusCode,400);assert.equal(badThumb.json().error.code,'unsafe_url');
   const feedback={method:'POST' as const,url:'/api/feedback',headers:{cookie,'x-requested-with':'CreatorSearch'},payload:{search_id:data.search_id,content_id:first.id,useful:true}};
   assert.equal((await app.inject(feedback)).statusCode,204);assert.equal((await app.inject(feedback)).statusCode,204);
   assert.equal((await db.query('SELECT * FROM feedback')).rows.length,1);
   assert.deepEqual((await app.inject('/api/feedback')).json(),[]);
   assert.equal((await app.inject({...feedback,headers:{...feedback.headers,origin:'https://attacker.example'}})).statusCode,403);
   await setSourcePolicy(db,first.source_id,{status:'rejected',metadata:false,review_note:'TEST policy revocation'});
   assert.equal((await db.query('SELECT * FROM content')).rows.length,0);
   assert.equal((await db.query('SELECT * FROM feedback')).rows.length,0);
 }finally{await app.close();await db.close();}
});

test('provider identity, metadata retention and budgets hold under repeated discovery',async()=>{
 const db=await database();
 try{
   const original=await fixture(db,'Repeated title','Known description');
   const first=await ingest(db,contentInput.parse({url:'https://videos.example.com/a',provider_id:'stable-id',title:'Repeated title',duration:90,language:'hi',rights_status:'restricted'}),{fixture:true});
   const updated=await ingest(db,contentInput.parse({url:'https://videos.example.com/b',provider_id:'stable-id',title:'Updated title'}),{fixture:true});
   assert.equal(updated!.id,first!.id);assert.equal(updated!.canonical_url,'https://videos.example.com/a');
   assert.equal(updated!.duration,90);assert.equal(updated!.language,'hi');assert.equal(updated!.rights_status,'restricted');
   assert.notEqual(first!.id,original.id,'equal titles do not deduplicate distinct clips');
   assert.equal(await removeContent(db,first!.id),true);
   assert.equal(await ingest(db,contentInput.parse({url:'https://videos.example.com/new-alias',provider_id:'stable-id',title:'Attempt to rediscover removed content'}),{fixture:true}),null);
   const disabled=new SearchService(db,{...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',DISCOVERY_DAILY_BUDGET:0});
   const result=await disabled.start({q:'Repeated',mode:'refresh'},'alice');
   assert.equal(result.status,'partial');assert.equal(result.discovery_job_id,null);
   assert.equal((await db.query('SELECT * FROM jobs')).rows.length,0);
   const semantic=new SearchService(db,{...testConfig,SEMANTIC_ENABLED:true});
   const fallback=await semantic.start({q:'Repeated',mode:'catalogue'},'alice');
   assert.ok(fallback.results.length>0);assert.equal(fallback.providers[0].provider,'embeddings');
 }finally{await db.close();}
});

test('discovery persists once, reuses durable jobs and preserves results through outages',async()=>{
 const db=await database();
 try{
   await fixture(db,'Bedroom footage','A bright bedroom');
   const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'};
   const service=new SearchService(db,config);let calls=0;
   const adapter:SourceAdapter={name:'mock',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){calls++;return {results:[contentInput.parse({url:'https://videos.example.com/watch/discovered?id=2',title:'Bright bedroom discovery',description:'Bright bedroom tour'})],next_cursor:null,status:{provider:'mock',status:'ok',message:'Mocked provider'}};}};
   const a=await service.start({q:'bedroom',mode:'auto'},'alice');const b=await service.start({q:'bedroom',mode:'auto'},'bob');
   assert.equal(a.status,'discovering');assert.equal(a.discovery_job_id,b.discovery_job_id);
   await workOnce(db,config,[adapter]);const finished=await service.poll(a.search_id,'alice');
   assert.equal(finished.results.length,2);assert.equal(finished.status,'complete');
   await service.start({q:'bedroom',mode:'refresh'},'alice');assert.equal(await workOnce(db,config,[adapter]),false);assert.equal(calls,1);
   assert.equal((await db.query('SELECT * FROM content')).rows.length,2);
   const stored=await service.start({q:'discovery',mode:'catalogue'},'alice');assert.equal(stored.results.length,1);
   const repeated=adapter.search.bind(adapter);const page=await repeated('x',searchInput.parse({q:'xx'}));
   await ingest(db,page.results[0],{mock:true});assert.equal((await db.query('SELECT * FROM content')).rows.length,2);
   const failure=await service.start({q:'bright',mode:'refresh'},'alice');
   await workOnce(db,config,[{...adapter,async search(){throw Error('SECRET upstream URL')}}]);
   const partial=await service.poll(failure.search_id,'alice');assert.equal(partial.status,'partial');assert.equal(partial.results.length,2);
   assert.ok(!JSON.stringify(partial).includes('SECRET'));
   const unknown=await ingest(db,contentInput.parse({url:'https://new.example.org/watch/1',title:'Candidate footage'}),{mock:true});
   assert.ok(unknown);assert.equal((await db.query("SELECT status FROM sources WHERE domain='new.example.org'")).rows[0].status,'candidate');
   assert.equal((await db.query('SELECT * FROM content')).rows.length,2);
 }finally{await db.close();}
});

test('leases recover after worker death, fence stale completion, and expire retained data',async()=>{
 const db=await database();
 try{
   await enqueue(db,'enrich','unique',{content_id:crypto.randomUUID()});await enqueue(db,'enrich','unique',{});
   const old=await claim(db);assert.ok(old);assert.equal(await claim(db),null);
   await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);
   const recovered=await claim(db);assert.equal(recovered.id,old.id);assert.notEqual(recovered.lease_token,old.lease_token);
   await complete(db,old,{stale:true});assert.equal((await db.query('SELECT status FROM jobs')).rows[0].status,'running');
   await complete(db,recovered,{ok:true});assert.equal((await db.query('SELECT status FROM jobs')).rows[0].status,'complete');
   const item=await fixture(db);await db.query("UPDATE content SET expires_at=now()-interval '1 second' WHERE id=$1",[item.id]);
   assert.equal((await new SearchService(db,testConfig).start({q:'bedroom',mode:'catalogue'},'alice')).results.length,0);
   await schedule(db,testConfig);assert.equal((await db.query('SELECT * FROM content')).rows.length,0);
 }finally{await db.close();}
});

test('a waiting search is claimed before background jobs that were queued earlier',async()=>{
 const db=await database();
 try{
   await enqueue(db,'source_health','health:older',{source_id:crypto.randomUUID()});
   await enqueue(db,'enrich','enrich:older',{content_id:crypto.randomUUID()});
   await db.query("UPDATE jobs SET run_after=now()-CASE kind WHEN 'source_health' THEN interval '2 minutes' ELSE interval '1 minute' END");
   const search=await enqueue(db,'discovery','discovery:newer',searchInput.parse({q:'space scenes'}));
   assert.equal((await claim(db)).id,search.id);
   assert.equal((await claim(db)).kind,'source_health','the rest keep their queue order');
 }finally{await db.close();}
});

test('full transcript chunking preserves every segment and overlapping context',()=>{
 const segments=Array.from({length:50},(_,i)=>({id:String(i),start_seconds:i*10,end_seconds:i*10+9,text:'x'.repeat(1000)}));
 const windows=transcriptWindows(segments);assert.equal(new Set(windows.flat().map(s=>s.id)).size,50);
 assert.equal(windows[0].at(-1)!.id,windows[1][1].id);
});
