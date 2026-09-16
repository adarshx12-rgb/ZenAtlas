import {test} from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, testConfig } from './helpers.js';
import { SearchService } from '../src/search.js';
import { setSourcePolicy } from '../src/admin.js';
import { importTranscript } from '../src/moments.js';
import { claim } from '../src/queue.js';
import type { DB } from '../src/db.js';

// TEST FIXTURE rows stand in for records written by scene-worker/; they are never model output.
async function permitVideoAnalysis(db:DB,sourceId:string){
 await db.query(`UPDATE sources SET policy=policy||'{"video_analysis":true}' WHERE id=$1`,[sourceId]);
}
async function mediaVersion(db:DB,contentId:string,key:string,offset=10,duration=100){
 return (await db.query(`INSERT INTO media_versions(content_id,version_key,media_kind,media_reference,fingerprint,duration_seconds,
   duration_source,timeline_offset_seconds,offset_basis,provenance,analysis_status)
   VALUES($1,$2,'local_file',$3,$4,$5,'media_probe',$6,'TEST FIXTURE offset','{"fixture":true}','complete') RETURNING *`,
   [contentId,key,`fixtures/${key}.mp4`,'a'.repeat(64),duration,offset])).rows[0];
}
async function sceneAnalysis(db:DB,version:any,subtitleSource='none'){
 return (await db.query(`INSERT INTO scene_analyses(media_version_id,content_id,analysis_version,model,subtitle_source,inspected_ranges,
   frame_sampling_fps,media_resolution,accepted_scenes,rejected_scenes) VALUES($1,$2,'TEST FIXTURE analysis','test-fixture-model',$3,
   '[[10,110]]',1,'low',1,0) RETURNING *`,[version.id,version.content_id,subtitleSource])).rows[0];
}
async function scene(db:DB,analysis:any,mediaStart:number,mediaEnd:number,description:string,offset=10,refs:string[]=[]){
 return (await db.query(`INSERT INTO video_scenes(analysis_id,content_id,media_version_id,media_start_seconds,media_end_seconds,
   start_seconds,end_seconds,description,tags,transcript_segment_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
   [analysis.id,analysis.content_id,analysis.media_version_id,mediaStart,mediaEnd,mediaStart+offset,mediaEnd+offset,description,['fixture'],refs])).rows[0];
}

test('analysed scenes are searchable with version identity and timeline offsets',async()=>{
 const db=await database();
 try{
   const item=await fixture(db,'Harbour documentary','A documentary filmed at a harbour');
   const service=new SearchService(db,testConfig);
   const version=await mediaVersion(db,item.id,'harbour-2026-master');
   const saved=await scene(db,await sceneAnalysis(db,version),15,40,'A red lighthouse flashes above stormy waves.');
   assert.equal((await service.start({q:'lighthouse',mode:'catalogue'},'alice')).results.length,0,'sources must permit video analysis');

   await permitVideoAnalysis(db,item.source_id);
   const found=await service.start({q:'lighthouse',mode:'catalogue'},'alice');
   assert.equal(found.results.length,1);
   const [moment]=found.results[0].moments;
   assert.equal(moment.id,saved.id);assert.equal(moment.evidence_type,'video_analysed');assert.equal(found.results[0].evidence,'video_analysed');
   assert.equal(moment.start_seconds,25);assert.equal(moment.end_seconds,50);
   assert.deepEqual(moment.scene,{media_version:'harbour-2026-master',media_start_seconds:15,media_end_seconds:40,timeline_offset_seconds:10,
     model:'test-fixture-model',tags:['fixture'],dialogue:null,dialogue_source:null});
   assert.equal(found.results[0].scene_analysis?.status,'complete');
   assert.equal((await service.start({q:'lighthouse',mode:'catalogue',evidence:'video_analysed'},'alice')).results.length,1);
   assert.equal((await service.start({q:'lighthouse',mode:'catalogue',evidence:'transcript_supported'},'alice')).results.length,0);

   await db.query(`UPDATE media_versions SET access_status='inaccessible',access_code='restricted',analysis_status='inaccessible',analysis_code='restricted' WHERE id=$1`,[version.id]);
   assert.match((await service.poll(found.search_id,'alice')).results[0].scene_analysis!.message,/private or restricted/);

   await db.query(`UPDATE media_versions SET status='superseded' WHERE id=$1`,[version.id]);
   assert.equal((await db.query('SELECT status FROM video_scenes WHERE id=$1',[saved.id])).rows[0].status,'stale');
   assert.equal((await service.poll(found.search_id,'alice')).results[0].moments.length,0,'snapshots drop scenes from superseded versions');
   assert.equal((await service.start({q:'lighthouse',mode:'catalogue'},'alice')).results.length,0);
   await assert.rejects(db.query(`UPDATE media_versions SET status='current' WHERE id=$1`,[version.id]),/cannot be reactivated/);
 }finally{await db.close();}
});

test('database rejects misaligned scene timing and protects version identity',async()=>{
 const db=await database();
 try{
   const item=await fixture(db,'Harbour documentary');await permitVideoAnalysis(db,item.source_id);
   const version=await mediaVersion(db,item.id,'master');const analysis=await sceneAnalysis(db,version);
   await assert.rejects(scene(db,analysis,15,40,'Scene stored without its offset',0),/offset/);
   await assert.rejects(scene(db,analysis,90,101,'Scene beyond the media file'),/media version duration/);
   await assert.rejects(db.query('UPDATE media_versions SET timeline_offset_seconds=0 WHERE id=$1',[version.id]),/immutable/);
   const kept=await scene(db,analysis,50,90,'A crane lifts containers onto the quay.');
   await assert.rejects(db.query('UPDATE video_scenes SET description=$2 WHERE id=$1',[kept.id,'Rewritten description']),/immutable/);
   await assert.rejects(db.query('UPDATE content SET duration=60 WHERE id=$1',[item.id]),/retained scenes/);

   const other=await fixture(db,'Second harbour clip');
   const late=await mediaVersion(db,other.id,'late',30,100);
   await assert.rejects(scene(db,await sceneAnalysis(db,late),80,95,'Scene past the content end',30),/content duration/);
   await assert.rejects(db.query(`INSERT INTO media_versions(content_id,version_key,media_kind,media_reference,fingerprint,duration_seconds,
     duration_source,timeline_offset_seconds,offset_basis,provenance) VALUES($1,'youtube','youtube','https://www.youtube.com/watch?v=abcdefghijk',
     'abcdefghijk',120,'content_metadata',0,'TEST FIXTURE','{}')`,[item.id]),/canonical URL/);

   await importTranscript(db,{content_id:item.id,language:'en',origin:'TEST FIXTURE',content_version:'master',timing_quality:'provided',
     retention_permitted:true,segments:[{start:60,end:70,text:'The crane lifts a container.'}]});
   const segment=(await db.query('SELECT id FROM transcript_segments WHERE content_id=$1',[item.id])).rows[0].id;
   await assert.rejects(scene(db,analysis,20,30,'Scene citing a segment outside its range',10,[segment]),/transcript evidence/);
   const quoted=await scene(db,analysis,45,55,'Crane operator signals the driver.',10,[segment]);
   await importTranscript(db,{content_id:item.id,language:'en',origin:'TEST FIXTURE',content_version:'master',timing_quality:'provided',
     retention_permitted:true,segments:[{start:60,end:70,text:'Replaced transcript text.'}]});
   assert.equal((await db.query('SELECT status FROM video_scenes WHERE id=$1',[quoted.id])).rows[0].status,'stale','replaced subtitles stale scenes that quoted them');
   assert.equal((await db.query('SELECT status FROM video_scenes WHERE id=$1',[kept.id])).rows[0].status,'active');
 }finally{await db.close();}
});

test('source policy revocation removes analyses and Node never claims scene jobs',async()=>{
 const db=await database();
 try{
   const item=await fixture(db,'Harbour documentary');await permitVideoAnalysis(db,item.source_id);
   const version=await mediaVersion(db,item.id,'master');
   await scene(db,await sceneAnalysis(db,version,'sidecar_file'),15,40,'A lighthouse keeper climbs the stairs.');
   const service=new SearchService(db,testConfig);
   assert.equal((await service.start({q:'lighthouse',mode:'catalogue'},'alice')).results.length,1);
   await setSourcePolicy(db,item.source_id,{status:'active',metadata:true,transcripts:false,video_analysis:true,review_note:'TEST FIXTURE transcript revocation'});
   assert.equal((await db.query('SELECT * FROM scene_analyses')).rows.length,0,'subtitle-assisted analyses follow transcript permission');
   assert.deepEqual((await db.query('SELECT analysis_status,analysis_code FROM media_versions')).rows,[{analysis_status:'pending',analysis_code:'policy_changed'}]);
   assert.equal((await service.start({q:'lighthouse',mode:'catalogue'},'alice')).results.length,0);

   await scene(db,await sceneAnalysis(db,version),15,40,'A lighthouse lamp turns slowly.');
   await setSourcePolicy(db,item.source_id,{status:'active',metadata:true,video_analysis:false,review_note:'TEST FIXTURE video analysis revocation'});
   assert.equal((await db.query('SELECT * FROM video_scenes')).rows.length,0);

   await db.query(`INSERT INTO jobs(kind,dedupe_key,payload,attempts) VALUES('scene_analysis','scene:test','{}',3)`);
   assert.equal(await claim(db),null);
   assert.equal((await db.query(`SELECT status FROM jobs WHERE kind='scene_analysis'`)).rows[0].status,'queued','Node leaves scene job retries to the Python worker');
 }finally{await db.close();}
});
