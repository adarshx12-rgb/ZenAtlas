import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {importTranscript} from '../src/moments.js';
import {applySignals} from '../src/signals.js';
import type {Judge} from '../src/judge.js';

const SPEECH=[{start:40,end:55,text:"Today I want to tell you three stories from my life. That's it. No big deal. Just three stories."},
 {start:55.85,end:62,text:'The first story is about connecting the dots.'},
 {start:62,end:70,text:'I dropped out of Reed College after the first 6 months.'}];

async function speech(db:any){
 const item=await fixture(db,'Steve Jobs 2005 Stanford Commencement Address','Stanford University commencement speech');
 await importTranscript(db,{content_id:item.id,language:'en',origin:'fixture',content_version:'v1',timing_quality:'provided',retention_permitted:true,segments:SPEECH});
 return item;
}
const judging=(quote:string,field='transcripts'):Judge=>({async judge(_q,cs){return {model:'fixture',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:9,reason:'Quotes the moment',momentKeys:[],
 intentChecks:(['subject','intent','relationship','format'] as const).map(dimension=>({dimension,status:'supported' as const,field:field as any,quote}))}]))};}});

test('a transcript passage the judge quoted becomes a timestamped moment at the caption line where the quote starts',async()=>{
 const db=await database();
 try {
  const item=await speech(db);
  const out=await applySignals(db,testConfig,'the part where he talks about connecting the dots',[item],{judge:judging('The first story is about connecting the dots.'),council:null});
  const moments=out.results[0].moments.filter(m=>m.analysis_version==='judge-quote-v1');
  assert.equal(moments.length,1);
  assert.equal(moments[0].start_seconds,55.85);
  assert.equal(moments[0].evidence_type,'transcript_supported');
  assert.equal(moments[0].summary,'The first story is about connecting the dots.');
 } finally {await db.close();}
});

test('no timestamp is invented: a quote from another field, or one not found in the captions, adds no moment',async()=>{
 const db=await database();
 try {
  const item=await speech(db);
  for(const judge of [judging('Steve Jobs 2005 Stanford Commencement Address','title'),judging('connecting the dots is the second story')]){
   const out=await applySignals(db,testConfig,'connecting the dots',[item],{judge,council:null});
   assert.deepEqual((out.results[0]?.moments??[]).filter(m=>m.analysis_version==='judge-quote-v1'),[]);
  }
 } finally {await db.close();}
});

async function video(db:any,id:string){
 const {ingest}=await import('../src/catalogue.js');const {contentInput}=await import('../src/types.js');
 await db.query(`INSERT INTO sources(domain,display_name,status,policy,provenance) VALUES('www.youtube.com','YouTube','active',
   '{"metadata":true,"transcripts":true,"retention_days":30}','{"fixture":true}') ON CONFLICT(domain) DO NOTHING`);
 return (await ingest(db,contentInput.parse({url:`https://www.youtube.com/watch?v=${id}`,title:'Steve Jobs Stanford commencement speech',
   description:'Full speech',language:'en',duration:900,availability:'available'}),{fixture:true}))!;
}

test('a moment query fetches captions during the search, so the same search can return the transcript timestamp',async()=>{
 const db=await database();
 try {
  const item=await video(db,'UF8uR6Z6KLc');
  const asked:string[]=[];
  const captions=async(id:string,_lang:string|null,via:'youtube'|'supadata')=>{asked.push(`${id}:${via}`);
   return {status:'ok' as const,kind:'youtube_unknown' as const,language:'en',track:'en',segments:SPEECH};};
  const config={...testConfig,YOUTUBE_CAPTIONS:true,CAPTIONS_PYTHON:'python',SUPADATA_API_KEY:'k',SUPADATA_DAILY_BUDGET:10};
  const out=await applySignals(db,config,"the part in Steve Jobs' Stanford speech where he talks about connecting the dots",[item],
   {judge:judging('The first story is about connecting the dots.'),council:null,captions});
  assert.deepEqual(asked,['UF8uR6Z6KLc:supadata']);
  assert.equal(out.results[0].moments.find(m=>m.analysis_version==='judge-quote-v1')?.start_seconds,55.85);
  assert.ok(out.providers.some(p=>p.provider==='captions_now'&&/1 video/.test(p.message)));
 } finally {await db.close();}
});

test('ordinary queries do not wait for captions',async()=>{
 const db=await database();
 try {
  const item=await video(db,'UF8uR6Z6KLd');
  let calls=0;const captions=async()=>{calls++;return {status:'none' as const,reason:'x'};};
  await applySignals(db,{...testConfig,YOUTUBE_CAPTIONS:true,CAPTIONS_PYTHON:'python'},'steve jobs stanford speech',[item],{judge:judging('x'),council:null,captions});
  assert.equal(calls,0);
 } finally {await db.close();}
});
