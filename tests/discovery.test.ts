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
import type {YouTubeClient} from '../src/youtube.js';
import type {AnimeClient, AnimeMatch} from '../src/anilist.js';

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
   const health=(await db.query("SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider LIKE 'searxng:%' ORDER BY provider")).rows;
   assert.deepEqual(health.map(h=>[h.provider,h.failure_count,h.last_error_code]),
     [['searxng:blocked',1,'blocked by a CAPTCHA'],['searxng:fast',0,null],['searxng:slow',0,null]],'the watchdog can say why an engine failed');
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
 const late=await adapter.search('ee',searchInput.parse({q:'ee'}),'1',{deadline:Date.now()-1});
 assert.deepEqual([asked.length,late.results.length,late.engines?.asked,late.status.status],[6,0,[],'ok'],'no engine is asked after the deadline');
 const wide=adapter.forTarget('web','all');
 assert.deepEqual(new SearXNG({...testConfig,SEARXNG_WEB_ENGINES:'bing, yep',SEARXNG_DEEP_WEB_ENGINES:'yep,hackernews'}).forTarget('web','all').engines,
   ['bing','yep','hackernews'],'deep dives add their own engines once');
 assert.deepEqual(wide.forTarget('videos','extra').engines,testConfig.SEARXNG_DEEP_ENGINES.split(','));
 const broken=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://lanes.example:8080',SEARXNG_ENGINES:'one,two,three'},async(url:string)=>{
   if(new URL(url).searchParams.get('engines')!=='one')throw new Error('down');return {results:[]};});
 const partial=await broken.search('dd',searchInput.parse({q:'dd'}));
 assert.deepEqual([partial.status.status,partial.status.message],['partial','1 of 3 search engines answered; Two (returned an error), Three (returned an error) did not.']);
});

test('a deep dive searches niche engines, later pages and leads, and adds ranked underrated finds after the quick results',async()=>{
 const db=await database();
 // DEEP_RESULTS: the first searches find exactly four new results, so the lead found afterwards needs its round's own room.
 const config={...testConfig,SEARXNG_BASE_URL:'http://deep.example:8080',SEARXNG_ENGINES:'std',SEARXNG_DEEP_ENGINES:'niche',DEEP_PAGES:2,DEEP_FOLLOW_UPS:2,DEEP_RESULTS:4};
 const app=await createApp(db,config);
 try{
   await db.query(`INSERT INTO sources(domain,display_name,status,policy,provenance) VALUES('www.youtube.com','YouTube','active',
     '{"metadata":true,"viewer_signals":true,"retention_days":30}','{"fixture":true}')`);
   const video=(id:string,title:string)=>({url:`https://www.youtube.com/watch?v=${id}`,title});
   const answers:Record<string,{url:string;title:string}[]>={
     'std:1:orbit scenes':[video('QUICKAAAAA1','Orbit scenes classic'),video('QUICKAAAAA2','Orbit scenes remastered')],
     'std:2:orbit scenes':[{url:'https://small.example.org/orbit-scenes',title:'Orbit scenes from a small archive'}],
     'niche:1:orbit scenes':[{url:'https://niche.example.net/v/1',title:'Orbit scenes fan edit'}],
     'std:1:orbit scene compilation obscure':[video('DEEPAAAAAA1','Orbit scene compilation obscure cut')],
     'niche:2:orbit scene compilation obscure':[{url:'https://niche.example.net/v/2',title:'Orbit scenes off-topic upload'}],
     'niche:1:orbit scene lead':[{url:'https://lead.example.com/orbit',title:'Orbit scene lead from a forum'}],
   };
   const asked:string[]=[];
   const searxng=new SearXNG(config,async(url:string)=>{const p=new URL(url).searchParams;const key=`${p.get('engines')}:${p.get('pageno')}:${p.get('q')}`;
     asked.push(key);return {results:answers[key]??[]};});
   const plans:unknown[]=[];let material:string[]=[];
   const planner:Planner={
     async plan(query,options){plans.push(options??null);
       return options?.deep?{kind:'videos',searches:[{query:'orbit scene compilation obscure',target:'videos'}],criteria:['Shows an orbit scene'],model:'m'}
         :{kind:'videos',searches:[{query,target:'videos'}],criteria:[],model:'m'};},
     async followUps(_q,lines){material=lines;return [{query:'orbit scene lead',target:'videos'}];}};
   const commentsRead:string[]=[];
   const youtube:YouTubeClient={async videos(ids){return new Map(ids.map(id=>[id,{id,title:'t',description:'',channelId:'UC',channelTitle:'Chan',
     publishedAt:null,duration:300,live:'none' as const,wasLive:false,views:id.startsWith('DEEP')?1200:5000000,commentCount:id==='QUICKAAAAA2'?null:4}]));},
     async comments(id){commentsRead.push(id);return [];}};
   const judged:string[][]=[];
   const relevance=(title:string)=>title.includes('off-topic')?1:title.includes('obscure')?9:title.includes('forum')?7:6;
   const judge:Judge={async judge(_q,candidates){judged.push(candidates.map(c=>c.title));
     return {model:'j',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:relevance(c.title),reason:`TEST ${c.title}`,momentKeys:[],
       lesserKnown:!c.title.includes('archive')}]))};}};
   const deps={planner,judge,youtube};

   const started=await app.inject('/api/search?q=orbit%20scenes&mode=refresh');
   const cookie=String(started.headers['set-cookie']).split(';')[0];
   await workOnce(db,config,[searxng],undefined,deps);
   const quick=(await app.inject({url:`/api/search/${started.json().search_id}`,headers:{cookie}})).json();
   assert.deepEqual([quick.depth,quick.status,plans],['quick','complete',[{anime:null}]],'a quick search plans with AI too');
   assert.deepEqual(asked,['std:1:orbit scenes'],'and asks the standard engines for first pages');
   assert.deepEqual(quick.discovered.map((r:any)=>[r.title,r.judgement.relevance,!!r.deep_find]),
     [['Orbit scenes classic',6,false],['Orbit scenes remastered',6,false]],'and ranks its finds with AI');
   assert.deepEqual([commentsRead,quick.status],[['QUICKAAAAA1'],'complete'],'a video with comments turned off is not asked for comments or counted as a failure');

   asked.length=0;
   const begun=(await app.inject({method:'POST',url:`/api/search/${quick.search_id}/deep`,headers:{cookie,'x-requested-with':'CreatorSearch'}})).json();
   await workOnce(db,config,[searxng],undefined,deps);
   const deep=(await app.inject({url:`/api/search/${begun.search_id}`,headers:{cookie}})).json();
   assert.deepEqual([deep.depth,deep.status],['deep','complete']);
   assert.deepEqual(plans[1],{deep:true,avoid:['orbit scenes'],anime:null},'the deep plan avoids what the quick search ran');
   assert.ok(!asked.includes('std:1:orbit scenes'),'first pages the quick search saw are not asked again');
   for(const key of ['niche:1:orbit scenes','std:2:orbit scenes','niche:2:orbit scenes','std:1:orbit scene compilation obscure',
     'niche:1:orbit scene compilation obscure','std:2:orbit scene compilation obscure','niche:2:orbit scene compilation obscure','niche:1:orbit scene lead'])
     assert.ok(asked.includes(key),`asked ${key}`);
   assert.ok(material.includes('niche.example.net: Orbit scenes fan edit'),'leads come from the first finds');
   assert.deepEqual(judged.at(-1)!.sort(),['Orbit scene compilation obscure cut','Orbit scene lead from a forum','Orbit scenes fan edit',
     'Orbit scenes from a small archive','Orbit scenes off-topic upload'],'the deep judge checks only new finds');
   const titles=deep.discovered.map((r:any)=>r.title);
   assert.deepEqual(titles.slice(0,4),['Orbit scenes classic','Orbit scenes remastered','Orbit scene compilation obscure cut','Orbit scene lead from a forum'],
     'quick results keep their place, and the best new finds follow');
   assert.deepEqual(titles.slice(4).sort(),['Orbit scenes fan edit','Orbit scenes from a small archive'],'the rejected find is removed');
   const byTitle=(title:string)=>deep.discovered.find((r:any)=>r.title===title);
   assert.equal(byTitle('Orbit scene compilation obscure cut').deep_find,true);
   assert.deepEqual(byTitle('Orbit scene compilation obscure cut').badges,['Underrated find'],'a relevant video with few views');
   assert.deepEqual(byTitle('Orbit scene lead from a forum').badges,['Underrated find'],'a relevant site the judge calls lesser-known');
   assert.equal(byTitle('Orbit scenes from a small archive').badges,undefined,'a site the judge does not call lesser-known is not');
   assert.equal(byTitle('Orbit scenes classic').badges,undefined,'nor is a widely watched video, whatever the judge says');
   assert.deepEqual(deep.providers.filter((p:any)=>['planner','leads'].includes(p.provider)).map((p:any)=>[p.provider,p.status]),[['planner','ok'],['leads','ok']]);

   const catalogue=(await app.inject({url:'/api/search?q=orbit%20scenes&mode=catalogue',headers:{cookie}})).json();
   const refused=await app.inject({method:'POST',url:`/api/search/${catalogue.search_id}/deep`,headers:{cookie,'x-requested-with':'CreatorSearch'}});
   assert.deepEqual([refused.statusCode,refused.json().error.code],[400,'discovery_disabled']);
   assert.equal((await app.inject({method:'POST',url:`/api/search/${quick.search_id}/deep`,headers:{'x-requested-with':'CreatorSearch'}})).statusCode,404,
     'another visitor cannot deepen it');
 }finally{await app.close();await db.close();}
});

test('a confident anime match gives the planner and judge its official titles and details, and is silent on a miss',async()=>{
 const db=await database();
 const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'};
 try{
   const anime:AnimeMatch={id:16498,title:'Attack on Titan',romaji:'Shingeki no Kyojin',english:'Attack on Titan',native:'進撃の巨人',
     synonyms:['AoT'],genres:['Action','Drama'],format:'TV',episodes:25,status:'FINISHED',studios:['Wit Studio'],
     seasonYear:2013,averageScore:84,siteUrl:'https://anilist.co/anime/16498',episodeTitles:[]};
   const lookups:string[]=[];
   const anilist:AnimeClient={async lookup(query){lookups.push(query);return query.includes('titan')?anime:null;}};
   const adapter:SourceAdapter={name:'mock',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[contentInput.parse({url:'https://videos.example.com/watch/1',title:'AoT clip'})],next_cursor:null,
       status:{provider:'mock',status:'ok',message:'Mocked provider'}};}};
   let planOptions:any,judgeContext:any;
   const planner:Planner={async plan(query,options){planOptions=options;
     return {kind:'videos',searches:[{query,target:'videos'}],criteria:[],model:'m'};}};
   const judge:Judge={async judge(_q,candidates,context){judgeContext=context;
     return {model:'j',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:6,reason:'TEST',momentKeys:[]}]))};}};

   const service=new SearchService(db,config);
   const started=await service.start({q:'attack on titan season 4',mode:'refresh'},'alice');
   await workOnce(db,config,[adapter],undefined,{planner,judge,anilist});
   const done=await service.poll(started.search_id,'alice');
   assert.deepEqual(lookups,['attack on titan season 4']);
   assert.deepEqual(planOptions,{anime});
   assert.deepEqual(judgeContext,{kind:'videos',criteria:[],anime});
   assert.deepEqual(done.providers.find(p=>p.provider==='anilist'),
     {provider:'anilist',status:'ok',message:'Recognised the anime "Attack on Titan"; searches and AI checks use its official titles and details.'});

   const other=await service.start({q:'best pasta recipes',mode:'refresh'},'alice');
   await workOnce(db,config,[adapter],undefined,{planner,judge,anilist});
   const missed=await service.poll(other.search_id,'alice');
   assert.deepEqual(planOptions,{anime:null});
   assert.deepEqual(judgeContext,{kind:'videos',criteria:[],anime:null});
   assert.equal(missed.providers.find(p=>p.provider==='anilist'),undefined,'a miss adds no notice to an unrelated search');

   const failing:AnimeClient={async lookup(){throw new Error('down');}};
   const resilient=await service.start({q:'attack on titan movie',mode:'refresh'},'alice');
   await workOnce(db,config,[adapter],undefined,{planner,judge,anilist:failing});
   const survived=await service.poll(resilient.search_id,'alice');
   assert.equal(survived.status,'complete','a failed lookup never blocks or degrades the rest of the search');
   assert.equal(survived.providers.find(p=>p.provider==='anilist'),undefined);
 }finally{await db.close();}
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
