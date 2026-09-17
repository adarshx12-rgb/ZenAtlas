import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {AniListClient, animeSummary, matchingEpisodes, type AnimeMatch} from '../src/anilist.js';
import {UpstreamError} from '../src/http.js';

const media=(over:Partial<{romaji:string|null;english:string|null;native:string|null;synonyms:string[];streamingEpisodes:{title:string}[]}> ={})=>({
 id:1,siteUrl:'https://anilist.co/anime/1',
 title:{romaji:'Shingeki no Kyojin',english:'Attack on Titan',native:'進撃の巨人',...over},
 synonyms:over.synonyms??['AoT','SnK'],genres:['Action','Drama'],format:'TV',episodes:25,status:'FINISHED',
 seasonYear:2013,averageScore:84,studios:{nodes:[{name:'Wit Studio'}]},streamingEpisodes:over.streamingEpisodes??[],
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
     seasonYear:2013,averageScore:84,siteUrl:'https://anilist.co/anime/1',episodeTitles:[]});

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

   const noTrim=new AniListClient(db,config,async(_url,options:any)=>{
     asked.push(options.body.variables.search);
     return {data:{Page:{media:[],characters:[]}}};});
   asked.length=0;
   const original='a totally unrelated request with nothing to trim';
   assert.equal(await noTrim.lookup(original),null);
   assert.equal(asked[0],original,'the query is searched once as typed');
   assert.equal(asked.filter(s=>s===original).length,1,'nothing left to trim means the exact same text is never searched again as a title');
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

test('AniList: a query naming only characters, not the show, is identified when two of them are best known for the same anime',async()=>{
 const config={...testConfig,ANILIST_ENABLED:true};
 const db=await database();
 const dbz=(id=813)=>({id,siteUrl:`https://anilist.co/anime/${id}`,title:{romaji:'Dragon Ball Z',english:'Dragon Ball Z',native:null},
   synonyms:[],genres:['Action'],format:'TV',episodes:291,status:'FINISHED',seasonYear:1989,averageScore:81,
   studios:{nodes:[{name:'Toei Animation'}]},streamingEpisodes:[{title:'Episode 186 - The Unstoppable Gohan'}]});
 const character=(favourites:number,show:unknown|null)=>({data:{Page:{characters:[{favourites,media:{nodes:show?[show]:[]}}]}}});
 const isTitleQuery=(options:any)=>options.body.query.includes('type: ANIME');
 try{
   const asked:string[]=[];
   const converge=new AniListClient(db,config,async(_url,options:any)=>{
     if(isTitleQuery(options))return {data:{Page:{media:[]}}};
     const term=options.body.variables.search;asked.push(term);
     if(term==='gohan')return character(3768,dbz());
     if(term==='cell')return character(2000,dbz());
     return character(0,null);
   });
   const match=await converge.lookup('gohan ssj2 vs cell');
   assert.equal(match?.title,'Dragon Ball Z');
   assert.ok(asked.includes('gohan')&&asked.includes('cell'),'both character names were searched, in parallel with the others');
   assert.ok(match?.episodeTitles.includes('Episode 186 - The Unstoppable Gohan'),'the matched show carries its episode titles too');

   const lonely=new AniListClient(db,config,async(_url,options:any)=>{
     if(isTitleQuery(options))return {data:{Page:{media:[]}}};
     return options.body.variables.search==='fight'?character(3768,dbz()):character(0,null);
   });
   assert.equal(await lonely.lookup('best fight scenes'),null,'one coincidental character hit alone is not enough to claim a match');

   const obscure=new AniListClient(db,config,async(_url,options:any)=>{
     if(isTitleQuery(options))return {data:{Page:{media:[]}}};
     const term=options.body.variables.search;
     return ['totally','unrelated'].includes(term)?character(2,dbz(999)):character(0,null);
   });
   assert.equal(await obscure.lookup('a totally unrelated request'),null,'characters with very few favourites are not counted, even if two of them coincide');
 }finally{await db.close();}
});

test('AniList: streaming episode titles are fetched and hint at the specific episode a scene belongs to',async()=>{
 const config={...testConfig,ANILIST_ENABLED:true};
 const db=await database();
 try{
   const episodes=["Episode 1 - The New Threat","Episode 177 - Goku vs. Cell","Episode 186 - The Unstoppable Gohan",
     "Episode 200 - Gohan Goes to High School","Episode 200 - Gohan Goes to High School"];
   const client=new AniListClient(db,config,async()=>({data:{Page:{media:[media({streamingEpisodes:episodes.map(title=>({title}))})]}}}));
   const match=await client.lookup('attack on titan');
   assert.deepEqual(match?.episodeTitles,["Episode 1 - The New Threat","Episode 177 - Goku vs. Cell","Episode 186 - The Unstoppable Gohan",
     "Episode 200 - Gohan Goes to High School"],'duplicate entries from the source are deduplicated');
 }finally{await db.close();}
});

test('AniList: episode titles are matched against the query, ignoring a bare connector word, to hint at a specific scene',()=>{
 const dbz:AnimeMatch={id:813,title:'Dragon Ball Z',romaji:'Dragon Ball Z',english:'Dragon Ball Z',native:null,synonyms:[],
   genres:['Action','Adventure'],format:'TV',episodes:291,status:'FINISHED',studios:['Toei Animation'],seasonYear:1989,averageScore:81,
   siteUrl:'https://anilist.co/anime/813',
   episodeTitles:['Episode 1 - The New Threat','Episode 177 - Goku vs. Cell','Episode 186 - The Unstoppable Gohan',
     'Episode 200 - Gohan Goes to High School']};
 const hints=matchingEpisodes(dbz,'gohan ssj2 vs cell');
 assert.ok(hints.includes('Episode 186 - The Unstoppable Gohan'),'the transformation episode is a hint');
 assert.ok(!hints.includes('Episode 1 - The New Threat'),'an episode sharing none of the query\'s words is not');
 assert.deepEqual(matchingEpisodes(dbz,'vs'),[],'a query that is only a connector word has nothing distinctive to match on');
 assert.deepEqual(matchingEpisodes(dbz,'best pasta recipes'),[]);

 const withQuery=animeSummary(dbz,'gohan ssj2 vs cell') as any;
 assert.ok(withQuery.matching_episode_titles.includes('Episode 186 - The Unstoppable Gohan'));
 assert.equal((animeSummary(dbz) as any).matching_episode_titles,undefined,'no query means no episode hints are attempted');
 assert.equal((animeSummary(dbz,'best pasta recipes') as any).matching_episode_titles,undefined,'nor does an unrelated query add an empty list');
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
