import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {rankDiscovery,type DiscoveryCandidate} from '../src/ranking.js';
import {BraveSearch,SearXNG} from '../src/providers.js';
import {SearchService} from '../src/search.js';
import {workOnce} from '../src/worker.js';
import {createApp} from '../src/app.js';
import {contentInput,searchInput,type SourceAdapter} from '../src/types.js';
import type {Planner} from '../src/planner.js';
import type {Judge} from '../src/judge.js';
import type {YouTubeClient} from '../src/youtube.js';
import type {AnimeClient, AnimeMatch} from '../src/anilist.js';
import {runDiscovery} from '../src/discovery.js';
import type {Screener} from '../src/screener.js';
import {UpstreamError} from '../src/http.js';
import type {Explorer} from '../src/exploration.js';

const lead=(url:string,title:string,provider='searxng',position=0,description:string|null=null):DiscoveryCandidate=>
 ({item:contentInput.parse({url,title,description}),provider,position});
const urls=(list:DiscoveryCandidate[])=>list.map(c=>c.item.url);

test('ordinary providers start while anime recognition is pending; planning still waits for its context',async()=>{
 const db=await database();
 let finishRecognition!:(value:AnimeMatch|null)=>void,notifyStarted!:()=>void;
 const recognition=new Promise<AnimeMatch|null>(resolve=>{finishRecognition=resolve;});
 const providerStarted=new Promise<void>(resolve=>{notifyStarted=resolve;});
 let planned=false,startedBeforeRecognition=false;
 const adapter:SourceAdapter={name:'concurrent-fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
   async search(){notifyStarted();return {results:[],next_cursor:null,status:{provider:'concurrent-fixture',status:'ok',message:'TEST'}};}};
 const planner:Planner={async plan(query,options){planned=true;assert.deepEqual(options,{anime:null});
   return {kind:'videos',searches:[{query,target:'videos'}],criteria:[],model:'test'};}};
 const run=runDiscovery(db,testConfig,searchInput.parse({q:'moon launch'}),[adapter],
   {planner,anilist:{lookup:()=>recognition}},async()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
   startedBeforeRecognition=await Promise.race([providerStarted.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);
   assert.equal(planned,false,'planning must retain recognition context');
 } finally {
   clearTimeout(timer);finishRecognition(null);
   try {await run;} finally {await db.close();}
 }
 assert.equal(startedBeforeRecognition,true,'an optional lookup must not hold up the initial provider search');
 assert.equal(planned,true);
});

test('Jev exploration adds checked outbound sources before judging, reuses pages, and respects scoped searches',async()=>{
 const db=await database();
 try{
   const root='https://catalogue.example.org/moon',found='https://original.example.org/launch';
   const provider:SourceAdapter={name:'explore-fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[contentInput.parse({url:root,title:'Moon launch source catalogue'})],next_cursor:null,status:{provider:'explore-fixture',status:'ok',message:'TEST'}};}};
   const planner:Planner={async plan(){return {kind:'websites',searches:[{query:'moon launch sources',target:'web'}],criteria:[],model:'test'};}};
   const explorer:Explorer={async assess(_q,candidates){return {failed_batches:0,decisions:candidates.map(c=>({url:c.url,model:'test',choice:'useful',confidence:0.95,
     probabilities:{useful:0.98,uncertain:0.01,irrelevant:0.01}}))};}};
   const calls:string[]=[];
   const pages={async check(url:string){calls.push(url);return {status:'checked' as const,title:'Moon launch footage',description:'Original moon launch footage and source references.',
     text:'Moon launch footage',libraries:[],badges:[],links:url===root?[{url:found,title:'Original recording'}]:[]};}};
   const judge:Judge={async judge(_q,candidates){return {model:'final',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:c.url===found?9:4,reason:'TEST evidence',momentKeys:[]}]))};}};
   // The title-based explorer is the pipeline without a requirements contract (the evaluation baseline).
   const config={...testConfig,PAGE_CHECKS:8,REQUIREMENTS_ENABLED:false};
   const out=await runDiscovery(db,config,searchInput.parse({q:'moon launch websites'}),[provider],{planner,explorer,pages,judge},async()=>{});
   assert.ok(out.results.some(r=>r.canonical_url===found));
   assert.deepEqual(out.trace.exploration?.new_urls,[found]);
   assert.ok(out.providers.some(p=>p.provider==='jev_exploration'&&p.status==='ok'));
   assert.equal(calls.filter(url=>url===found).length,1,'final evidence checks reuse exploration fetches');
   let assessed=false;
   const scoped=await runDiscovery(db,config,searchInput.parse({q:'moon launch site:catalogue.example.org'}),[provider],
     {planner,pages,judge,explorer:{async assess(){assessed=true;return {decisions:[],failed_batches:0};}}},async()=>{});
   assert.equal(assessed,false);assert.equal(scoped.trace.exploration,undefined);
 }finally{await db.close();}
});

test('Jev screening precedes admission, preserves exploration, and leaves final rejection to the judge',async()=>{
 const db=await database();
 try{
   const items=Array.from({length:8},(_,i)=>contentInput.parse({url:`https://screen.example.org/${i}`,
     title:i<4?`Moon launch ${i}`:`Orbital ascent ${i}`}));
   const excluded=contentInput.parse({url:'https://screen.example.org/excluded',title:'Moon launch gameplay'});
   const provider:SourceAdapter={name:'screen-fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[...items,excluded],next_cursor:null,status:{provider:'screen-fixture',status:'ok',message:'TEST'}};}};
   const judge:Judge={async judge(_q,candidates){return {model:'final-judge',verdicts:new Map(candidates.map(c=>[c.key,
     {key:c.key,relevance:c.title==='Orbital ascent 4'?8:4,reason:'Final evidence verdict',momentKeys:[]}]))};}};
   const screener:Screener={async screen(query,candidates){
     assert.equal(query,'moon launch -gameplay');
     assert.equal(candidates.length,8);
     assert.ok(!candidates.some(c=>c.item.url===excluded.url),'exclusions apply before Jev');
     return {screened:candidates.length,promising:new Set(items.slice(4).map(c=>c.url))};
   }};
   const config={...testConfig,DISCOVERY_CANDIDATES:4};
   const input=searchInput.parse({q:'moon launch -gameplay'});
   const health:{provider:string;ok:boolean}[]=[];
   const out=await runDiscovery(db,config,input,[provider],{judge,screener},async(provider,ok)=>{health.push({provider,ok});});
   assert.deepEqual(out.ingested.map(r=>r.title),['Orbital ascent 4','Orbital ascent 5','Orbital ascent 6','Moon launch 0']);
   assert.deepEqual(out.results.map(r=>r.title),['Orbital ascent 4'],'Jev promotion cannot override final rejection');
   assert.equal(out.results[0].judgement?.model,'final-judge');
   assert.ok(out.providers.some(p=>p.provider==='jev_screener'&&p.status==='ok'));
   assert.ok(health.some(h=>h.provider==='jev_screener'&&h.ok));
   const baseline=await runDiscovery(db,config,input,[provider],{judge},async()=>{});
   assert.ok(!baseline.providers.some(p=>p.provider==='jev_screener'),'no key preserves default behaviour');
   for(const code of ['timeout','malformed_response','budget_exhausted']){
     const failed=await runDiscovery(db,config,input,[provider],{judge,screener:{async screen(){throw new UpstreamError(code);}}},async()=>{});
     assert.deepEqual(failed.ingested.map(r=>r.canonical_url),baseline.ingested.map(r=>r.canonical_url));
     assert.ok(failed.providers.some(p=>p.provider==='jev_screener'&&p.status===(code==='budget_exhausted'?'budget_exhausted':'unavailable')));
   }
 }finally{await db.close();}
});

test('late specialist semantic matches compete before the display limit, regardless of arrival order',async()=>{
 const db=await database();
 try{
   const config={...testConfig,DISCOVERY_RESULTS:2};
   const judge:Judge={async judge(_q,candidates){return {model:'test',verdicts:new Map(candidates.map(c=>[c.key,
     {key:c.key,relevance:c.site==='specialist.example.org'?9:4,reason:'TEST supporting evidence',momentKeys:[]}]))};}};
   const run=async(slowSpecialist:boolean,checking=judge)=>{
     let release!:()=>void,started!:()=>void;
     const waiting=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
     const provider=(specialist:boolean):SourceAdapter=>({name:specialist?'specialist':'general',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
       async search(){if(specialist===slowSpecialist){started();await gate;}
         return {results:specialist?[contentInput.parse({url:'https://specialist.example.org/orbit',title:'Orbital ascent',description:'Original recording'})]
           :Array.from({length:12},(_,i)=>contentInput.parse({url:`https://general.example.org/${i}`,title:`Moon launch ${i}`})),
           next_cursor:null,status:{provider:specialist?'specialist':'general',status:'ok',message:'TEST'}};}});
     let done=false;const updates:number[]=[];
     const working=runDiscovery(db,config,searchInput.parse({q:'moon launch'}),[provider(false),provider(true)],{judge:checking},async()=>{},async u=>{updates.push(u.results.length);}).then(r=>{done=true;return r;});
     await waiting;
     assert.equal(done,false);assert.ok(updates.every(n=>n===0));release();
     return working;
   };
   const first=await run(true),second=await run(false);
   assert.equal(first.results[0].canonical_url,'https://specialist.example.org/orbit');
   assert.equal(first.ingested.length,13,'display limit does not restrict admission before relevance checks');
   assert.deepEqual(first.results.map(r=>r.canonical_url),second.results.map(r=>r.canonical_url));
   assert.deepEqual(first.results.map(r=>r.judgement?.relevance),[9],'weak earlier candidates cannot fill spare display slots');
   const failed=await run(true,{async judge(){throw Error('unavailable');}});
   assert.deepEqual(failed.results,[], 'when checking fails, no unchecked discovery result is displayed');
 }finally{await db.close();}
});

test('clear keyword matches fill the checking pool before loosely related leads, whatever their position',async()=>{
 const db=await database();
 try{
   const all:Judge={async judge(_q,candidates){return {model:'test',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:8,reason:'TEST',momentKeys:[]}]))};}};
   const provider:SourceAdapter={name:'general',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[
       ...['a','b','c'].map(d=>contentInput.parse({url:`https://${d}.example.org/best-tools`,title:'Best tools of the year'})),
       ...Array.from({length:7},(_,i)=>contentInput.parse({url:`https://www.youtube.com/watch?v=osint00000${i}`,title:`Hidden OSINT tools ${i}`})),
     ].map((item,i)=>i<3?item:item),next_cursor:null,status:{provider:'general',status:'ok',message:'TEST'}};}};
   const out=await runDiscovery(db,{...testConfig,DISCOVERY_CANDIDATES:3},searchInput.parse({q:'underrated osint tools'}),[provider],{judge:all},async()=>{});
   assert.equal(out.ingested.length,3);
   assert.ok(out.ingested.every(r=>r.title.startsWith('Hidden OSINT tools')),out.ingested.map(r=>r.title).join(', '));
 }finally{await db.close();}
});

test('completed judging cannot leave provisional catalogue matches behind after rejection or failure',async()=>{
 const db=await database();
 try {
   const item=await fixture(db,'WWE commentators gone crazy moments','WWE commentary over unrelated gaming footage');
   const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'};
   const service=new SearchService(db,config);
   const adapter:SourceAdapter={name:'fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[contentInput.parse({url:item.canonical_url,title:item.title,description:item.description})],
       next_cursor:null,status:{provider:'fixture',status:'ok',message:'Fixture'}};}};
   for(const failing of [false,true]) {
     const started=await service.start({q:failing?'WWE commentators':'WWE moments',mode:'refresh'},'strict-display');
     assert.equal(started.results.length,1,'catalogue supplies the provisional match');
     const judge:Judge={async judge(_q,candidates){
       if(failing) throw Error('fixture judge failure');
       return {model:'fixture',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:5,reason:'Uncertain relationship',momentKeys:[]}]))};
     }};
     await workOnce(db,config,[adapter],undefined,{judge});
     const finished=await service.poll(started.search_id,'strict-display');
     assert.deepEqual(finished.results,[]);
     assert.deepEqual(finished.ranked,[]);
     assert.deepEqual(finished.discovered,[]);
     assert.deepEqual((await service.poll(started.search_id,'strict-display')).results,[],'subsequent polls cannot resurrect the rejected match');
     assert.equal(finished.status,failing?'partial':'complete');
   }
 } finally {await db.close();}
});

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

test('quick discovery waits for slow engines before selection and names engines that failed',async()=>{
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
   await new Promise(r=>setTimeout(r,100));early=await service.poll(started.search_id,'alice');
   assert.deepEqual([early.status,early.stage],['discovering','searching']);
   assert.deepEqual(early.discovered,[],'fast answers cannot fill the display before slow sources finish');
   release();await working;
   const done=await service.poll(started.search_id,'alice');
   assert.deepEqual([done.status,done.stage,done.catalogue_total,done.discovered.length],['complete',null,0,6]);
   assert.deepEqual(done.discovered.slice(0,4).map(r=>new URL(r.canonical_url).hostname),
     ['fast.example.org','slow.example.org','fast.example.org','slow.example.org'],'all answers share the final candidate ranking');
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

test('Brave searches videos through its video index with usable metadata, and pages by offset',async()=>{
 const asked:string[]=[];
 const brave=new BraveSearch({...testConfig,BRAVE_SEARCH_API_KEY:'k'},async(url:string)=>{asked.push(url);return {type:'videos',query:{more_results_available:true},results:[
   {url:'https://www.youtube.com/watch?v=LZnAo_2cpYY',title:'Evidence of the Yeti',description:'A footprint on Everest',page_age:'2013-11-14T17:49:16',
     video:{duration:'02:34',creator:'National Geographic'},thumbnail:{src:'https://imgs.search.brave.com/thumb.jpg'}},
   {url:'javascript:alert(1)',title:'unsafe'}]};});
 const page=await brave.forTarget('videos').search('yeti footage',searchInput.parse({q:'yeti footage'}),'1');
 const url=new URL(asked[0]);
 assert.deepEqual([url.pathname,url.searchParams.get('q'),url.searchParams.get('offset')],['/res/v1/videos/search','yeti footage','1']);
 assert.deepEqual(page.results.map(r=>[r.title,r.creator,r.duration,r.published_at,r.thumbnail]),
   [['Evidence of the Yeti','National Geographic',154,'2013-11-14T17:49:16.000Z','https://imgs.search.brave.com/thumb.jpg']],'a malformed row is dropped, not the page');
 assert.equal(page.next_cursor,'2');
 await brave.forTarget('web').search('yeti',searchInput.parse({q:'yeti'}));
 assert.equal(new URL(asked[1]).pathname,'/res/v1/web/search','web searches keep the web index');
});

test('with Brave configured, SearXNG standard engines only fill in where Brave fails or finds too little, without waiting on each other',async()=>{
 const db=await database();
 try{
   const config={...testConfig,BRAVE_SEARCH_API_KEY:'k',BRAVE_MIN_RESULTS:3,SEARXNG_BASE_URL:'http://mix.example:8080',
     SEARXNG_ENGINES:'std',SEARXNG_DEEP_ENGINES:'niche',DEEP_PAGES:2,DEEP_FOLLOW_UPS:0};
   const rows=(site:string,n:number)=>Array.from({length:n},(_,i)=>({url:`https://${site}.example.org/v/${i}`,title:`Yeti footage ${site} ${i}`}));
   const braveAsked:string[]=[],sxAsked:string[]=[];
   let releaseBrave!:()=>void;let braveGate:Promise<void>=Promise.resolve();
   const brave=new BraveSearch(config,async(url:string)=>{const u=new URL(url);const q=u.searchParams.get('q')!;
     braveAsked.push(`${q}:${u.searchParams.get('offset')}`);await braveGate;
     if(q.includes('broken'))throw new UpstreamError('unavailable');
     return {results:q.includes('thin')?rows('thin',1):rows(`brave-${q.replace(/\W/g,'')}-${u.searchParams.get('offset')}`,5)};});
   const searxng=new SearXNG(config,async(url:string)=>{const p=new URL(url).searchParams;sxAsked.push(`${p.get('engines')}:${p.get('pageno')}:${p.get('q')}`);
     return {results:rows(`${p.get('engines')}-${p.get('pageno')}`,2)};});
   const planner=(queries:string[]):Planner=>({async plan(){return {kind:'videos',searches:queries.map(query=>({query,target:'videos' as const})),criteria:[],model:'t'};}});

   // Quick: Brave answers well, so SearXNG is not asked at all.
   const quick=await runDiscovery(db,config,searchInput.parse({q:'yeti footage'}),[brave,searxng],{planner:planner(['yeti footage'])},async()=>{});
   assert.equal(sxAsked.length,0,'a good Brave answer needs no SearXNG');
   assert.ok(quick.results.length>0);
   assert.deepEqual(quick.providers.find(p=>p.provider==='searxng'),{provider:'searxng',status:'ok',message:'Not needed: Brave answered every search.'});

   // Quick: a thin and a failed Brave answer each bring in SearXNG's standard engines for that search only.
   sxAsked.splice(0);
   const mixed=await runDiscovery(db,config,searchInput.parse({q:'yeti thin'}),[brave,searxng],{planner:planner(['yeti thin','yeti broken','yeti fine'])},async()=>{});
   assert.deepEqual(sxAsked.sort(),['std:1:yeti broken','std:1:yeti thin']);
   assert.match(mixed.providers.find(p=>p.provider==='searxng')!.message,/Filled in for 2 of 3 searches where Brave failed or found too little\.$/);

   // Deep: niche engines start alongside Brave (before it answers); Brave pages by offset; niche engines only take first pages.
   sxAsked.splice(0);braveAsked.splice(0);braveGate=new Promise<void>(r=>{releaseBrave=r;});
   const deep=runDiscovery(db,config,searchInput.parse({q:'yeti footage',depth:'deep'}),[brave,searxng],{planner:planner(['yeti expedition'])},async()=>{});
   for(let i=0;i<50&&!sxAsked.length;i++)await new Promise(r=>setTimeout(r,10));
   assert.ok(sxAsked.some(k=>k.startsWith('niche:1:')),'niche engines do not wait for Brave');
   releaseBrave();await deep;
   assert.deepEqual(sxAsked.filter(k=>!k.startsWith('niche:1:')),[],'no standard engines or later niche pages while Brave answers well');
   for(const key of ['yeti footage:0','yeti footage:1','yeti expedition:0','yeti expedition:1'])assert.ok(braveAsked.includes(key),`Brave asked ${key}`);
 }finally{await db.close();}
});

test('a deep dive searches niche engines, later pages and leads, and reranks quick and deep results together',async()=>{
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
   assert.deepEqual(judged.at(-1)!.sort(),['Orbit scene compilation obscure cut','Orbit scene lead from a forum','Orbit scenes classic','Orbit scenes fan edit',
     'Orbit scenes from a small archive','Orbit scenes off-topic upload','Orbit scenes remastered'],'the deep judge checks old and new finds together');
   const titles=deep.discovered.map((r:any)=>r.title);
   assert.deepEqual(titles.slice(0,2),['Orbit scene compilation obscure cut','Orbit scene lead from a forum'],
     'more relevant deep results outrank quick results');
   assert.deepEqual(titles.slice(2).sort(),['Orbit scenes classic','Orbit scenes fan edit','Orbit scenes from a small archive','Orbit scenes remastered'],'the rejected find is removed');
   assert.deepEqual(deep.ranked.map((r:any)=>r.title),titles,'the browser receives the same combined ranking');
   const byTitle=(title:string)=>deep.discovered.find((r:any)=>r.title===title);
   assert.equal(byTitle('Orbit scene compilation obscure cut').deep_find,true);
   assert.deepEqual(byTitle('Orbit scene compilation obscure cut').badges,['Underrated find'],'a relevant video with few views');
   assert.deepEqual(byTitle('Orbit scene lead from a forum').badges,['Underrated find'],'a relevant site the judge calls lesser-known');
   assert.equal(byTitle('Orbit scenes from a small archive').badges,undefined,'a site the judge does not call lesser-known is not');
   assert.equal(byTitle('Orbit scenes classic').badges,undefined,'nor is a widely watched video, whatever the judge says');
   assert.deepEqual(deep.providers.filter((p:any)=>['planner','leads'].includes(p.provider)).map((p:any)=>[p.provider,p.status]),[['planner','ok'],['leads','ok']]);

   const traces=(await db.query('SELECT query,depth,trace,metrics FROM search_traces ORDER BY created_at')).rows;
   assert.deepEqual(traces.map((t:any)=>[t.query,t.depth]),[['orbit scenes','quick'],['orbit scenes','deep']],'every discovery search leaves a record');
   const trace=traces[1].trace,entry=(title:string)=>trace.pool.find((p:any)=>p.title===title);
   assert.deepEqual([trace.plan.kind,trace.plan.criteria,trace.rounds],['videos',['Shows an orbit scene'],1]);
   assert.deepEqual([entry('Orbit scene lead from a forum').round,entry('Orbit scenes classic').round],[1,0],'each find keeps the round that first found it');
   assert.deepEqual([entry('Orbit scenes off-topic upload').relevance,entry('Orbit scenes off-topic upload').shown],[1,false],'rejected candidates keep their scores');
   assert.deepEqual([entry('Orbit scene compilation obscure cut').rank,entry('Orbit scene compilation obscure cut').shown],[1,true]);
   assert.ok(trace.searches.some((s:any)=>s.query==='orbit scene lead'&&s.round===1));
   assert.equal(traces[1].metrics.last_round_share,1/6,'one of the six shown results came from the last follow-up round');
   assert.equal((await db.query("SELECT count(*)::int n FROM jobs WHERE kind='audit'")).rows[0].n,0,'no audit is queued while the critic is off');
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
