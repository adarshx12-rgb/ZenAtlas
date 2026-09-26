import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {createApp} from '../src/app.js';
import {workOnce} from '../src/worker.js';
import {removeContent} from '../src/admin.js';
import {contentInput,type SourceAdapter} from '../src/types.js';
import type {Judge} from '../src/judge.js';
import {applySignals} from '../src/signals.js';

test('closest matches load separately, respect ownership and deletion, and support feedback without entering main results',async()=>{
 const db=await database();
 const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'};
 const app=await createApp(db,config);
 try {
  const items=await Promise.all(['Strong','Uncertain','Tangential','Mismatch','Unrelated'].map(name=>fixture(db,`Reaction ${name}`)));
  const scores=[8,5,4,4,2];
  const adapter:SourceAdapter={name:'fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
   async search(){return {results:items.map(r=>contentInput.parse({url:r.canonical_url,title:r.title})),next_cursor:null,
    status:{provider:'fixture',status:'ok',message:'Fixture'}};}};
  const judge:Judge={async judge(_q,candidates){return {model:'fixture',verdicts:new Map(candidates.map(c=>{
   const index=items.findIndex(r=>r.title===c.title);
   return [c.key,{key:c.key,relevance:scores[index],reason:'Fixture evidence',momentKeys:[],
    ...(index===3?{intentChecks:[{dimension:'relationship' as const,status:'mismatch' as const,field:'title' as const,quote:c.title}]}:{})}];
  }))};}};
  const start=await app.inject('/api/search?q=reaction&mode=refresh');
  const cookie=String(start.headers['set-cookie']).split(';')[0],headers={cookie};
  const id=start.json().search_id,url=`/api/search/${id}/closest`;
  assert.equal((await app.inject({url,headers})).json().status,'pending');
  assert.equal((await app.inject(url)).statusCode,404,'other sessions cannot read the extra results');
  await workOnce(db,config,[adapter],undefined,{judge});
  const normal=(await app.inject({url:`/api/search/${id}`,headers})).json();
  assert.deepEqual(normal.ranked.map((r:any)=>r.title),['Reaction Strong']);
  assert.equal('closest' in normal,false,'main response never includes optional results');
  const extra=(await app.inject({url,headers})).json();
  assert.equal(extra.status,'ready');
  assert.deepEqual(extra.results.map((r:any)=>r.title),['Reaction Uncertain','Reaction Tangential']);
  assert.ok(extra.results.every((r:any)=>r.badges.includes('Closest match')&&r.moments.length===0));
  const feedback={method:'POST' as const,url:`/api/search/${id}/feedback`,headers:{cookie,'x-requested-with':'CreatorSearch'},
   payload:{url:items[1].canonical_url,useful:true}};
  assert.equal((await app.inject(feedback)).statusCode,204);
  assert.equal((await app.inject({...feedback,payload:{url:items[3].canonical_url,useful:true}})).statusCode,403);
  assert.deepEqual((await app.inject({url:`/api/search/${id}`,headers})).json().ranked,normal.ranked,'opening the extra tab cannot change main results');
  await db.query("UPDATE content SET availability='unavailable' WHERE id=$1",[items[1].id]);
  assert.deepEqual((await app.inject({url,headers})).json().results.map((r:any)=>r.title),['Reaction Tangential']);
  await app.inject({method:'DELETE',url:`/api/search/${id}`,headers:{cookie,'x-requested-with':'CreatorSearch'}});
  assert.equal((await app.inject({url,headers})).json().status,'cancelled');
  const catalogue=(await app.inject({url:'/api/search?q=reaction&mode=catalogue',headers})).json();
  assert.equal((await app.inject({url:`/api/search/${catalogue.search_id}/closest`,headers})).json().status,'unavailable');
  await db.query("UPDATE searches SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
  assert.equal((await app.inject({url,headers})).statusCode,404);
  await removeContent(db,items[2].id);
  assert.equal((await app.inject({url:`/api/search/${catalogue.search_id}/closest`,headers})).statusCode,404,'content deletion invalidates retained searches');
 } finally {await app.close();await db.close();}
});

test('closest suggestions are bounded and cannot include unchecked or explicitly mismatched candidates',async()=>{
 const db=await database();
 try {
  const item=await fixture(db,'Reaction lead');
  const candidates=Array.from({length:25},(_,i)=>({...item,id:crypto.randomUUID(),title:`Reaction ${i}`}));
  const judge:Judge={async judge(_q,items){return {model:'fixture',verdicts:new Map(items.map(c=>[c.key,
   {key:c.key,relevance:5,reason:'Uncertain',momentKeys:[]}]))};}};
  const out=await applySignals(db,testConfig,'reaction',candidates,{judge});
  assert.deepEqual(out.results,[]);assert.equal(out.closest.length,20);
  const failed=await applySignals(db,testConfig,'reaction',[item],{judge:{async judge(){throw Error('fixture outage');}}});
  assert.deepEqual(failed.results,[]);assert.deepEqual(failed.closest,[]);
 } finally {await db.close();}
});

test('when no candidate video has been watched, the search says what stays unverified instead of implying a miss',async()=>{
 const db=await database();
 try {
  const item=await fixture(db,'Seatpost removal with heat');
  const judge:Judge={async judge(_q,items){return {model:'fixture',verdicts:new Map(items.map(c=>[c.key,
   {key:c.key,relevance:5,reason:'Uncertain: the removal is not confirmed',momentKeys:[]}]))};}};
  const out=await applySignals(db,testConfig,'seatpost heat removal',[item],{judge});
  assert.deepEqual(out.results,[]);assert.equal(out.closest.length,1);
  const note=out.providers.find(p=>p.provider==='video_inspection');
  assert.equal(note?.status,'ok','information, not a failed service: the search itself is complete');
  assert.match(note!.message,/not been watched|unverified/i);
  const verified=await applySignals(db,testConfig,'seatpost heat removal',[item],{judge:{async judge(_q,items){return {model:'fixture',
   verdicts:new Map(items.map(c=>[c.key,{key:c.key,relevance:9,reason:'Clear',momentKeys:[]}]))};}}});
  assert.equal(verified.providers.some(p=>p.provider==='video_inspection'),false,'a verified match needs no warning');
 } finally {await db.close();}
});
