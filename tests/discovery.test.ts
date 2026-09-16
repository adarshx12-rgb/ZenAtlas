import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {rankDiscovery,type DiscoveryCandidate} from '../src/ranking.js';
import {SearXNG} from '../src/providers.js';
import {SearchService} from '../src/search.js';
import {contentInput,searchInput} from '../src/types.js';

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
 const adapter=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',PROVIDER_TIMEOUT_MS:12000},async url=>{observed=url;return {results:rows};});
 const page=await adapter.search('clip',searchInput.parse({q:'clip'}));
 assert.equal(new URL(observed).searchParams.get('timeout_limit'),'10');
 assert.equal(page.results.length,100);
 const [first,second,third]=page.results;
 assert.equal(first.duration,4117);assert.equal(first.published_at,'2025-07-29T05:41:45.000Z');
 assert.equal(first.thumbnail,'https://s1.dmcdn.net/v/x1');assert.equal(first.creator,null);assert.equal(first.description,null);
 assert.equal(second.duration,756);assert.equal(second.creator,'fajfer');assert.equal(second.thumbnail,null,'private-address thumbnails are dropped');
 assert.equal(second.published_at,'2025-07-17T02:28:19.445Z');
 assert.equal(third.duration,null);assert.equal(third.published_at,null);assert.equal(third.thumbnail,null);
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
