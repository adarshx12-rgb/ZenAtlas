import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {AniListClient} from '../src/anilist.js';
import {UpstreamError} from '../src/http.js';

const media=(over:Partial<{romaji:string|null;english:string|null;native:string|null;synonyms:string[]}> ={})=>({
 id:1,siteUrl:'https://anilist.co/anime/1',
 title:{romaji:'Shingeki no Kyojin',english:'Attack on Titan',native:'進撃の巨人',...over},
 synonyms:over.synonyms??['AoT','SnK'],genres:['Action','Drama'],format:'TV',episodes:25,status:'FINISHED',
 seasonYear:2013,averageScore:84,studios:{nodes:[{name:'Wit Studio'}]},
});

test('AniList: sends a title search, maps a confident match, and treats a low-coverage top result as no match',async()=>{
 const config={...testConfig,ANILIST_ENABLED:true};
 const db=await database();
 try{
   let sent:any;
   const hit=new AniListClient(db,config,async(url,options)=>{sent={url,options};return {data:{Page:{media:[media()]}}};});
   const match=await hit.lookup('attack on titan season 4 episode 28 english dub');
   assert.equal(sent.url,'https://graphql.anilist.co');
   assert.equal(sent.options.method,'POST');assert.equal(sent.options.trustedOrigin,'https://graphql.anilist.co');
   assert.match(sent.options.body.query,/type: ANIME/);assert.equal(sent.options.body.variables.search,'attack on titan season 4 episode 28 english dub');
   assert.deepEqual(match,{id:1,title:'Attack on Titan',romaji:'Shingeki no Kyojin',english:'Attack on Titan',native:'進撃の巨人',
     synonyms:['AoT','SnK'],genres:['Action','Drama'],format:'TV',episodes:25,status:'FINISHED',studios:['Wit Studio'],
     seasonYear:2013,averageScore:84,siteUrl:'https://anilist.co/anime/1'});

   const miss=new AniListClient(db,config,async()=>({data:{Page:{media:[media()]}}}));
   assert.equal(await miss.lookup('cooking pasta for dinner'),null,'a title sharing no real words with the query is not a match');

   const noResults=new AniListClient(db,config,async()=>({data:{Page:{media:[]}}}));
   assert.equal(await noResults.lookup('some unlisted show'),null);
 }finally{await db.close();}
});

test('AniList: a verbose, arc-specific title matches when the query is explained by the title, even if the title has words the query does not',async()=>{
 const config={...testConfig,ANILIST_ENABLED:true};
 const db=await database();
 try{
   const arc=media({romaji:'Kimetsu no Yaiba: Katanakaji no Sato-hen',english:'Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc',
     native:null,synonyms:['KnY 3']});
   const client=new AniListClient(db,config,async()=>({data:{Page:{media:[arc]}}}));
   const match=await client.lookup('demon slayer swordsmith village');
   assert.equal(match?.title,'Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc');
   assert.equal(await client.lookup('good anime to watch this weekend'),null,'a generic request explained by none of the title is not confident');
 }finally{await db.close();}
});

test('AniList: a short or single-word title only matches a query that is little more than that title',async()=>{
 const config={...testConfig,ANILIST_ENABLED:true};
 const db=await database();
 try{
   const naruto=new AniListClient(db,config,async()=>({data:{Page:{media:[media({romaji:'Naruto',english:null,native:null,synonyms:[]})]}}}));
   assert.ok(await naruto.lookup('naruto'),'a bare query for the title itself matches');
   assert.ok(await naruto.lookup('watch naruto'),'a two-word query dominated by the title matches');
   assert.equal(await naruto.lookup('spicy naruto ramen recipe for dinner'),null,
     'the same common word inside a longer, unrelated request does not');
 }finally{await db.close();}
});

test('AniList: a query with season/episode or descriptive words falls back to a narrower search of just the title',async()=>{
 const config={...testConfig,ANILIST_ENABLED:true};
 const db=await database();
 try{
   const asked:string[]=[];
   const fallback=new AniListClient(db,config,async(_url,options:any)=>{
     asked.push(options.body.variables.search);
     return {data:{Page:{media:asked.length===1?[]:[media()]}}};});
   const match=await fallback.lookup('attack on titan season 4 episode 28 english dub');
   assert.deepEqual(asked,['attack on titan season 4 episode 28 english dub','attack on titan'],
     'season/episode markers and trailing descriptive words are dropped for a second attempt');
   assert.equal(match?.title,'Attack on Titan');

   const noTrim=new AniListClient(db,config,async(_url,options:any)=>{asked.push(options.body.variables.search);return {data:{Page:{media:[]}}};});
   asked.length=0;
   assert.equal(await noTrim.lookup('a totally unrelated request with nothing to trim'),null);
   assert.equal(asked.length,1,'nothing left to trim means no second request');
 }finally{await db.close();}
});

test('AniList: a budget spent on the narrower fallback attempt is not surfaced as an error',async()=>{
 const db=await database();
 try{
   let calls=0;
   const spent=new AniListClient(db,{...testConfig,ANILIST_ENABLED:true,ANILIST_DAILY_BUDGET:1},async()=>{calls++;return {data:{Page:{media:[]}}};});
   assert.equal(await spent.lookup('attack on titan season 4'),null);
   assert.equal(calls,1,'the direct attempt used the one allowed call; the fallback found none left and gave up quietly');
 }finally{await db.close();}
});

test('AniList: a malformed reply is rejected and the daily budget gates the request',async()=>{
 const db=await database();
 try{
   const bad=new AniListClient(db,{...testConfig,ANILIST_ENABLED:true},async()=>({data:{Page:{media:[{id:'not-a-number'}]}}}));
   await assert.rejects(bad.lookup('attack on titan'),/malformed_response/);

   let called=false;
   const client=new AniListClient(db,{...testConfig,ANILIST_ENABLED:true,ANILIST_DAILY_BUDGET:0},async()=>{called=true;return {data:{Page:{media:[]}}};});
   await assert.rejects(client.lookup('attack on titan'),(e:any)=>e instanceof UpstreamError&&e.code==='budget_exhausted');
   assert.equal(called,false,'an exhausted budget never calls the API');
 }finally{await db.close();}
});
