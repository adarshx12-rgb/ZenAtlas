import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {rankDiscovery,type DiscoveryCandidate} from '../src/ranking.js';
import {SearXNG} from '../src/providers.js';
import {SearchService} from '../src/search.js';
import {workOnce} from '../src/worker.js';
import {createApp} from '../src/app.js';
import {contentInput,searchInput,type SourceAdapter} from '../src/types.js';
import type {Planner} from '../src/planner.js';
import type {Judge} from '../src/judge.js';

const lead=(url:string,title:string,provider='searxng',position=0,description:string|null=null):DiscoveryCandidate=>
 ({item:contentInput.parse({url,title,description}),provider,position});
const urls=(list:DiscoveryCandidate[])=>list.map(c=>c.item.url);

test('discovery ranking drops unrelated leads only when related ones exist, and stems simple plurals',()=>{
 const ranked=rankDiscovery('pasta recipe',[
   lead('https://a.example/1','Top 10 football goals',undefined,0),
   lead('https://b.example/1','Creamy garlic pasta',undefined,1),
   lead('https://c.example/1','Quick dinner ideas',undefined,2,'Easy pasta recipes for weeknights'),
 ],10);
 assert.deepEqual(urls(ranked),['https://b.example/1','https://c.example/1']);
 const unmatched=rankDiscovery('official site',[lead('https://a.example/1','Google result'),lead('https://b.example/1','Brave result',undefined,1)],10);
 assert.equal(unmatched.length,2,'provider matches survive when no lead contains the query words');
});

test('discovery ranking enforces quoted phrases and exclusions',()=>{
 const ranked=rankDiscovery('"ghost story" -fake cooking',[
   lead('https://a.example/1','A ghost story about cooks'),
   lead('https://b.example/1','Story of a ghost'),
   lead('https://c.example/1','Fake ghost story compilation'),
   lead('https://d.example/1','Ghost story for cooking fans'),
 ],10);
 assert.deepEqual(urls(ranked),['https://d.example/1','https://a.example/1']);
});

test('discovery ranking spreads results across sites and rewards agreement between providers',()=>{
 const youtube=[0,1,2].map(i=>lead(`https://www.youtube.com/watch?v=${'a'.repeat(10)}${i}`,'Big Buck Bunny full movie',undefined,i));
 const ranked=rankDiscovery('big buck bunny',[...youtube,lead('https://www.dailymotion.com/video/x1','Big Buck Bunny',undefined,3)],2);
 assert.deepEqual(urls(ranked),[youtube[0].item.url,'https://www.dailymotion.com/video/x1']);
 const agreed=rankDiscovery('sintel',[lead('https://a.example/1','Sintel',undefined,0),lead('https://b.example/1','Sintel',undefined,1),
   lead('https://b.example/1','Sintel','brave',1)],10);
 assert.deepEqual(urls(agreed),['https://b.example/1','https://a.example/1'],'a lead found by two providers outranks a single-provider one');
});

test('SearXNG keeps usable video metadata, drops unsafe values, and bounds its own deadline',async()=>{
 let observed='';
 const rows=[
   {url:'https://www.dailymotion.com/video/x1',title:'Clip',content:'',author:'',length:'1:08:37',publishedDate:'2025-07-29T05:41:45',thumbnail:'//s1.dmcdn.net/v/x1'},
   {url:'https://tube.example.org/w/1',title:'Peer',author:'fajfer',length:756,publishedDate:'2025-07-17T02:28:19.445000+00:00',thumbnail:'http://127.0.0.1/secret.png'},
   {url:'https://odysee.com/@a/b',title:'Bad values',length:'abc',publishedDate:'not a date',thumbnail:'javascript:alert(1)'},
   ...Array.from({length:120},(_,i)=>({url:`https://example.com/watch/${i}`,title:`Filler ${i}`})),
 ];
 const adapter=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',PROVIDER_TIMEOUT_MS:12000,SEARXNG_ENGINES:'youtube'},async url=>{observed=url;return {results:rows};});
 const page=await adapter.search('clip',searchInput.parse({q:'clip'}));
 const sent=new URL(observed).searchParams;
 assert.equal(sent.get('timeout_limit'),'10');assert.equal(sent.get('engines'),'youtube');
 assert.equal(sent.get('categories'),null,'a category would add every engine in it');
 assert.equal(page.results.length,100);
 const [first,second,third]=page.results;
 assert.equal(first.duration,4117);assert.equal(first.published_at,'2025-07-29T05:41:45.000Z');
 assert.equal(first.thumbnail,'https://s1.dmcdn.net/v/x1');assert.equal(first.creator,null);assert.equal(first.description,null);
 assert.equal(second.duration,756);assert.equal(second.creator,'fajfer');assert.equal(second.thumbnail,null,'private-address thumbnails are dropped');
 assert.equal(second.published_at,'2025-07-17T02:28:19.445Z');
 assert.equal(third.duration,null);assert.equal(third.published_at,null);assert.equal(third.thumbnail,null);
});

test('quick discovery shows each engine’s best leads while slower engines still search, and names engines that failed',async()=>{
 const db=await database();
 try{
   let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
   const row=(site:string,n:number)=>({url:`https://${site}.example.org/watch/${n}`,title:`Orbit launch footage ${site} ${n}`});
   const transport=async(url:string)=>{
     const engine=new URL(url).searchParams.get('engines');
     if(engine==='fast')return {results:[1,2,3,4].map(n=>row('fast',n))};
     if(engine==='slow'){await gate;return {results:[1,2,3].map(n=>row('slow',n))};}
     return {results:[],unresponsive_engines:[['blocked','Suspended: CAPTCHA']]};
   };
   const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',SEARXNG_ENGINES:'fast,slow,blocked',DISCOVERY_RESULTS:6};
   const service=new SearchService(db,config);
   const started=await service.start({q:'orbit launch',mode:'refresh'},'alice');
   const working=workOnce(db,config,[new SearXNG(config,transport)]);
   let early=await service.poll(started.search_id,'alice');
   for(let i=0;i<300&&early.discovered.length<2;i++){await new Promise(r=>setTimeout(r,10));early=await service.poll(started.search_id,'alice');}
   assert.deepEqual([early.status,early.stage],['discovering','searching']);
   assert.deepEqual(early.discovered.map(r=>new URL(r.canonical_url).hostname),['fast.example.org','fast.example.org'],'the first answer adds its best two leads');
   release();await working;
   const done=await service.poll(started.search_id,'alice');
   assert.deepEqual([done.status,done.stage,done.catalogue_total,done.discovered.length],['complete',null,0,6]);
   assert.deepEqual(done.discovered.slice(0,4).map(r=>new URL(r.canonical_url).hostname),
     ['fast.example.org','fast.example.org','slow.example.org','slow.example.org'],'results already shown keep their place');
   assert.deepEqual(done.providers,[{provider:'searxng',status:'ok',message:'2 of 3 search engines answered; Blocked (blocked by a CAPTCHA) did not.'}]);
   const health=(await db.query("SELECT provider,failure_count FROM provider_health WHERE provider LIKE 'searxng:%' ORDER BY provider")).rows;
   assert.deepEqual(health.map(h=>[h.provider,h.failure_count]),[['searxng:blocked',1],['searxng:fast',0],['searxng:slow',0]]);
 }finally{await db.close();}
});

test('SearXNG sends each engine one request at a time, even from searches running in parallel',async()=>{
 let active=0,peak=0;const asked:string[]=[];
 const adapter=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://lanes.example:8080',SEARXNG_ENGINES:'one,two'},async(url:string)=>{
   const params=new URL(url).searchParams;asked.push(`${params.get('engines')}:${params.get('q')}`);
   if(params.get('engines')==='one'){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;}
   return {results:[]};
 });
 const pages=await Promise.all(['aa','bb','cc'].map(q=>adapter.search(q,searchInput.parse({q}))));
 assert.equal(peak,1);assert.equal(asked.length,6);
 assert.ok(pages.every(p=>p.status.status==='ok'));
 const broken=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://lanes.example:8080',SEARXNG_ENGINES:'one,two,three'},async(url:string)=>{
   if(new URL(url).searchParams.get('engines')!=='one')throw new Error('down');return {results:[]};});
 const partial=await broken.search('dd',searchInput.parse({q:'dd'}));
 assert.deepEqual([partial.status.status,partial.status.message],['partial','1 of 3 search engines answered; Two (returned an error), Three (returned an error) did not.']);
});

test('dig deeper continues a finished quick search with planning and AI ranking, keeping what was already found',async()=>{
 const db=await database();
 const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'};
 const app=await createApp(db,config);
 try{
   const item=(n:number,title:string)=>contentInput.parse({url:`https://clips.example.org/watch/${n}`,title});
   const asked:string[]=[];
   const adapter:SourceAdapter={name:'mock',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(query){asked.push(query);
       const results=query==='space scenes'?[item(1,'Space scenes in film'),item(2,'Space scenes ranked'),item(3,'Space scenes blooper')]
         :[item(4,'Best space scenes in cinema history'),item(2,'Space scenes ranked')];
       return {results,next_cursor:null,status:{provider:'mock',status:'ok',message:'Mocked provider'}};}};
   let planned=0,judged=0,seen:string[]=[];
   const planner:Planner={async plan(query){planned++;
     return {kind:'videos',searches:[{query,target:'videos'},{query:'space movie scenes cinema',target:'videos'}],criteria:['Shows a space scene'],model:'test-planner'};}};
   const relevance:Record<string,number>={'Space scenes in film':6,'Space scenes ranked':7,'Space scenes blooper':1,'Best space scenes in cinema history':9};
   const judge:Judge={async judge(_q,candidates){judged++;seen=candidates.map(c=>c.title);
     return {model:'test-judge',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:relevance[c.title],reason:`TEST ${c.title}`,momentKeys:[]}]))};}};
   const started=await app.inject('/api/search?q=space%20scenes&mode=refresh');
   const cookie=String(started.headers['set-cookie']).split(';')[0];
   const quickId=started.json().search_id;
   await workOnce(db,config,[adapter],undefined,{planner,judge});
   const quick=(await app.inject({url:`/api/search/${quickId}`,headers:{cookie}})).json();
   assert.deepEqual([quick.depth,quick.status,planned,judged],['quick','complete',0,0],'a quick search neither plans nor judges');
   assert.deepEqual(asked,['space scenes']);
   assert.deepEqual(quick.discovered.map((r:any)=>r.title),['Space scenes in film','Space scenes ranked','Space scenes blooper']);

   const deepUrl=`/api/search/${quickId}/deep`,headers={cookie,'x-requested-with':'CreatorSearch'};
   assert.equal((await app.inject({method:'POST',url:deepUrl,headers:{cookie}})).statusCode,403,'the request header is required');
   assert.equal((await app.inject({method:'POST',url:deepUrl,headers:{'x-requested-with':'CreatorSearch'}})).statusCode,404,'another visitor cannot deepen it');
   const begun=(await app.inject({method:'POST',url:deepUrl,headers})).json();
   assert.notEqual(begun.search_id,quickId);
   assert.deepEqual([begun.depth,begun.status,begun.stage,begun.discovered.length],['deep','discovering','queued',3],'what the quick search found stays listed');
   assert.equal((await app.inject({method:'POST',url:deepUrl,headers})).json().discovery_job_id,begun.discovery_job_id,'asking again follows the same deep job');

   await workOnce(db,config,[adapter],undefined,{planner,judge});
   const deep=(await app.inject({url:`/api/search/${begun.search_id}`,headers:{cookie}})).json();
   assert.deepEqual([deep.status,deep.stage,planned,judged],['complete',null,1,1]);
   assert.deepEqual(seen,['Best space scenes in cinema history','Space scenes in film','Space scenes ranked','Space scenes blooper'],
     'the judge checks the new find and everything the quick search showed');
   assert.deepEqual(deep.discovered.map((r:any)=>r.title),['Best space scenes in cinema history','Space scenes ranked','Space scenes in film'],
     'the judge orders the discoveries and its rejected result disappears');
   assert.equal(deep.discovered[1].judgement.reason,'TEST Space scenes ranked');
   assert.ok(deep.providers.some((p:any)=>p.provider==='planner'&&p.status==='ok'));

   const catalogue=(await app.inject({url:'/api/search?q=space%20scenes&mode=catalogue',headers:{cookie}})).json();
   const refused=await app.inject({method:'POST',url:`/api/search/${catalogue.search_id}/deep`,headers});
   assert.deepEqual([refused.statusCode,refused.json().error.code],[400,'discovery_disabled']);
 }finally{await app.close();await db.close();}
});

test('auto mode also runs discovery when strong catalogue matches come from too few sites',async()=>{
 const db=await database();
 try{
   await fixture(db);
   const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',COVERAGE_MIN_RESULTS:1,COVERAGE_MIN_SCORE:0};
   const single=await new SearchService(db,config).start({q:'bedroom',mode:'auto'},'alice');
   assert.equal(single.discovery_job_id,null,'one strong match from one site is enough by default');
   const diverse=await new SearchService(db,{...config,COVERAGE_MIN_SOURCES:2}).start({q:'bedroom',mode:'auto'},'alice');
   assert.notEqual(diverse.discovery_job_id,null);
 }finally{await db.close();}
});
