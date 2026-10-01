import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {SearchService} from '../src/search.js';
import {enqueue} from '../src/queue.js';
import {reviewScenesOnce,sceneProgress,type SceneReviewPlan} from '../src/scene-verification.js';
import type {DB} from '../src/db.js';
import type {Judge} from '../src/judge.js';
import {requestSceneAnalysis} from '../src/retained-evidence.js';

const observation='A red lighthouse flashes above stormy waves.';
async function setup(db:DB,offset=0) {
 const item=await fixture(db,'Lighthouse documentary','A documentary about a lighthouse');
 await db.query(`UPDATE sources SET policy=policy||'{"video_analysis":true}' WHERE id=$1`,[item.source_id]);
 const service=new SearchService(db,testConfig);
 const initial=await service.start({q:'lighthouse',mode:'catalogue'},'alice');
 const result={...initial.results.find(r=>r.id===item.id)!,judgement:{relevance:5,reason:'Visual event unconfirmed',model:'fixture'}};
 const version=(await db.query(`INSERT INTO media_versions(content_id,version_key,media_kind,media_reference,fingerprint,duration_seconds,
   duration_source,timeline_offset_seconds,offset_basis,provenance,access_status) VALUES($1,'fixture','local_file','fixture.mp4',$2,120,
   'media_probe',$3,'fixture','{}','accessible') RETURNING id`,[item.id,'a'.repeat(64),offset])).rows[0];
 const sceneJob=(await db.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES('scene_analysis',$1,$2) RETURNING id`,
   [crypto.randomUUID(),JSON.stringify({media_version_id:version.id})])).rows[0];
 const requirement={id:'R1',text:'lighthouse flashes above stormy waves',kind:'property',evidence_kind:'visual',hardness:'hard',scope:'each',evidence:'visible lighthouse'};
 const plan:SceneReviewPlan={deadline:new Date(Date.now()+90000).toISOString(),
   context:{kind:'videos',criteria:[],requirements:[requirement as any]},contract:{requirements:[requirement]} as any,
   entries:[{content_id:item.id,job_id:sceneJob.id,result,findings:[],candidate:{key:'c1',kind:'video',title:result.title,
     site:'videos.example.com',channel:null,official:false,duration:'120',live:null,description:result.description,comments:[],moments:[],discussions:[]}}]};
 const run=crypto.randomUUID();
 const parent=(await db.query(`INSERT INTO jobs(kind,dedupe_key,payload,status,lease_token,result) VALUES('discovery',$1,$2,'complete',$3,$4) RETURNING id`,
   [crypto.randomUUID(),JSON.stringify({q:'lighthouse',tier:'ssj3'}),run,JSON.stringify({revision:1,results:[],closest:[result],dropped:[result.canonical_url],
     providers:[{provider:'judge',status:'ok'}],_scene_review:plan,verification:sceneProgress(plan)})])).rows[0];
 await db.query('UPDATE searches SET job_id=$2 WHERE id=$1',[initial.search_id,parent.id]);
 const review=await enqueue(db,'scene_review',crypto.randomUUID(),{discovery_job_id:parent.id,run_id:run});
 const finish=async()=>{
   const analysis=(await db.query(`INSERT INTO scene_analyses(media_version_id,content_id,analysis_version,model,subtitle_source,inspected_ranges,
     frame_sampling_fps,media_resolution,accepted_scenes,rejected_scenes) VALUES($1,$2,'fixture','fixture','none','[[20,30]]',1,'low',1,0) RETURNING id`,[version.id,item.id])).rows[0];
   await db.query(`INSERT INTO video_scenes(analysis_id,content_id,media_version_id,media_start_seconds,media_end_seconds,start_seconds,end_seconds,description)
     VALUES($1,$2,$3,20,30,20,30,$4)`,[analysis.id,item.id,version.id,observation]);
   await db.query(`UPDATE jobs SET status='complete',result='{"status":"complete"}' WHERE id=$1`,[sceneJob.id]);
   await db.query('UPDATE jobs SET run_after=now() WHERE id=$1',[review.id]);
 };
 return {service,initial,item,sceneJob,parent,review,finish,run};
}
const judge:Judge={async judge(_q,candidates){return {model:'fixture',verdicts:new Map(candidates.map(c=>[c.key,
 {key:c.key,relevance:9,reason:'Visible scene confirms the event',momentKeys:[],requirementChecks:[{id:'R1',status:'supported',field:'scenes',quote:observation}]}]))};}};

test('scene admission attaches and prioritises existing work, then maps local transcript time without duplicate spending',async()=>{
 const db=await database();try{
   const f=await setup(db,10);
   await db.query(`INSERT INTO transcript_segments(content_id,start_seconds,end_seconds,text,language,origin,content_version,timing_quality)
     VALUES($1,24,26,'The lighthouse flashes.','en','fixture','fixture','provided')`,[f.item.id]);
   const result={...f.initial.results.find(r=>r.id===f.item.id)!,judgement:{relevance:5,reason:'fixture',model:'fixture'}};
   const config={...testConfig,SCENE_AUTO_QUEUE:true,GEMINI_API_KEY:'fixture'};
   const options={interactive:true,deadline:new Date(Date.now()+90000).toISOString(),window:async()=>({start:20,end:50,confidence:1})};
   const [attached]=await requestSceneAnalysis(db,config,[result],'lighthouse',options);
   assert.equal(attached.job_id,f.sceneJob.id);assert.equal(attached.created,false);
   assert.equal((await db.query('SELECT priority FROM jobs WHERE id=$1',[f.sceneJob.id])).rows[0].priority,10);
   await db.query("UPDATE jobs SET status='failed' WHERE id=$1",[f.sceneJob.id]);
   const [created]=await requestSceneAnalysis(db,config,[result],'lighthouse',options);
   assert.equal(created.created,true);
   const payload=(await db.query('SELECT payload FROM jobs WHERE id=$1',[created.job_id])).rows[0].payload;
   assert.deepEqual(payload.windows.map((w:any)=>[w.start,w.end]),[[10,40]]);
   const [again]=await requestSceneAnalysis(db,config,[result],'lighthouse',options);
   assert.equal(again.job_id,created.job_id);assert.equal(again.created,false);
 }finally{await db.close();}
});

test('scene completion promotes a closest candidate in the same search with grounded timestamps and one review',async()=>{
 const db=await database();try{
   const f=await setup(db);let calls=0;
   const deps={judge:{async judge(...args:Parameters<Judge['judge']>){calls++;return judge.judge(...args);}},strong:null};
   assert.equal((await f.service.poll(f.initial.search_id,'alice')).results.length,0);
   await reviewScenesOnce(db,testConfig,deps);
   assert.equal((await db.query('SELECT attempts FROM jobs WHERE id=$1',[f.review.id])).rows[0].attempts,0,'waiting does not consume retries');
   await f.finish();await reviewScenesOnce(db,testConfig,deps);
   const updated=await f.service.poll(f.initial.search_id,'alice');
   assert.equal(updated.search_id,f.initial.search_id);assert.equal(updated.verification?.status,'complete');
   assert.equal(updated.results.length,1);assert.equal(updated.results[0].judgement?.relevance,9);
   assert.equal(updated.results[0].moments[0].start_seconds,20);assert.equal(updated.results[0].evidence,'video_analysed');
   assert.equal((await f.service.closest(f.initial.search_id,'alice')).results.length,0);
   await reviewScenesOnce(db,testConfig,deps);await f.service.poll(f.initial.search_id,'alice');assert.equal(calls,1);
   await assert.rejects(f.service.poll(f.initial.search_id,'bob'),/unavailable/);
   await db.query(`UPDATE jobs SET lease_token=$2,result=jsonb_set(result,'{revision}','99') WHERE id=$1`,[f.parent.id,crypto.randomUUID()]);
   const old=await f.service.poll(f.initial.search_id,'alice');assert.equal(old.revision,updated.revision);assert.equal(old.results.length,1);
   const g=await setup(db);
   await db.query(`UPDATE jobs SET result=jsonb_set(jsonb_set(result,'{results}',result->'closest'),'{dropped}','[]') WHERE id=$1`,[g.parent.id]);
   assert.equal((await g.service.poll(g.initial.search_id,'alice')).results[0].evidence,'metadata_match');
   await g.finish();await reviewScenesOnce(db,testConfig,{judge,strong:null});
   assert.equal((await g.service.poll(g.initial.search_id,'alice')).results[0].evidence,'video_analysed','existing catalogue cards update their evidence label too');
 }finally{await db.close();}
});

test('deferred and timed-out scene jobs settle visibly without consuming judge calls',async()=>{
 const db=await database();try{
   const f=await setup(db);
   await db.query(`UPDATE jobs SET error_code='budget_exhausted',run_after=now()+interval '1 day' WHERE id=$1`,[f.sceneJob.id]);
   await reviewScenesOnce(db,testConfig,{judge:{async judge(){throw new Error('must not judge');}},strong:null});
   const response=await f.service.poll(f.initial.search_id,'alice');
   assert.equal(response.verification?.status,'partial');assert.equal(response.verification?.items[0].status,'budget_deferred');
   const g=await setup(db);
   await db.query(`UPDATE jobs SET result=jsonb_set(result,'{_scene_review,deadline}',$2::jsonb) WHERE id=$1`,[g.parent.id,JSON.stringify(new Date(0).toISOString())]);
   await reviewScenesOnce(db,testConfig,{judge,strong:null});
   assert.equal((await g.service.poll(g.initial.search_id,'alice')).verification?.items[0].status,'timed_out');
 }finally{await db.close();}
});

test('cancelled subscriptions and revoked scene permission cannot publish a verified match',async()=>{
 const db=await database();try{
   const f=await setup(db);await f.finish();
   await db.query('UPDATE searches SET cancelled=true WHERE id=$1',[f.initial.search_id]);
   await reviewScenesOnce(db,testConfig,{judge,strong:null});
   assert.equal((await db.query('SELECT result FROM jobs WHERE id=$1',[f.review.id])).rows[0].result.status,'cancelled');
   const g=await setup(db);await g.finish();
   await db.query(`UPDATE sources SET policy=policy||'{"video_analysis":false}' WHERE id=$1`,[g.item.source_id]);
   await reviewScenesOnce(db,testConfig,{judge,strong:null});
   const response=await g.service.poll(g.initial.search_id,'alice');
   assert.equal(response.verification?.items[0].status,'unavailable');assert.equal(response.results.length,0);
 }finally{await db.close();}
});

test('an early request needs no judgement; without the early option an unjudged video is not sent',async()=>{
 const db=await database();try{
   const f=await setup(db);
   const unjudged={...f.initial.results.find(r=>r.id===f.item.id)!,judgement:null} as any;
   const config={...testConfig,SCENE_AUTO_QUEUE:true,GEMINI_API_KEY:'fixture'};
   const options={interactive:true,deadline:new Date(Date.now()+90000).toISOString(),window:async()=>null};
   assert.deepEqual(await requestSceneAnalysis(db,config,[unjudged],'lighthouse',options),[]);
   const [early]=await requestSceneAnalysis(db,config,[unjudged],'lighthouse',{...options,early:true});
   assert.equal(early.job_id,f.sceneJob.id);
 }finally{await db.close();}
});
