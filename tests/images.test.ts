import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aiGenerated,excludesAI,wantsLicense,openverseResults,licenseLabel,openverseQuery} from '../src/image-signals.js';
import {reviewImages,startImageJob,imageReviewState} from '../src/image-review.js';
import type {Judge} from '../src/judge.js';
import {braveImageResults,searchImages,type ImageResult} from '../src/images.js';
import {collapseDuplicates,differenceHash} from '../src/image-duplicates.js';
import {novelty,rankSearches,simpleSearch,planImages,clearImagePlanCache} from '../src/image-plan.js';
import {interleaveImages,mergeShares,bySource,captionMatch,rankSearxng,weakSource,pageOrder} from '../src/image-sources.js';
import {testConfig} from './helpers.js';

test('AI-generated images are recognised from their source, not their pixels',()=>{
 assert.ok(aiGenerated('https://www.freepik.com/premium-ai-image/red-bicycle_160236855.htm','Red bicycle'));
 assert.ok(aiGenerated('https://www.rawpixel.com/image/12920184/mount-everest-generated-image-rawpixel','Everest'));
 assert.ok(aiGenerated('https://stock.adobe.com/images/x/123','Bicycle by a wall, Generative AI'));
 assert.ok(!aiGenerated('https://unsplash.com/photos/red-vintage-bicycle-leaning-against-a-blue-wall-lQh76MKnY6g','Red vintage bicycle'));
 assert.ok(!aiGenerated('https://example.com/raising-a-child','Parenting tips'),'"ai" inside a word is not a signal');
});

test('the request says when AI images are excluded and when a licence matters',()=>{
 assert.ok(excludesAI("infographic showing india's population by state, not AI-generated"));
 assert.ok(excludesAI('no ai art, real photos of cats'));
 assert.ok(!excludesAI('ai generated art of cats'));
 assert.ok(wantsLicense('free to use photo of mount everest with license and attribution'));
 assert.ok(wantsLicense('creative commons photo of a tiger'));
 assert.ok(!wantsLicense('red vintage bicycle leaning against a blue wall'));
});

test('Openverse results carry their licence, creator and attribution',()=>{
 const [r]=openverseResults({results:[{id:'a1',title:'Everest from Kala Patthar',url:'https://upload.wikimedia.org/e.jpg',thumbnail:'https://api.openverse.org/v1/images/a1/thumb/',
  foreign_landing_url:'https://commons.wikimedia.org/wiki/File:E.jpg',creator:'Pavel Novak',license:'by-sa',license_version:'2.5',
  license_url:'https://creativecommons.org/licenses/by-sa/2.5/',attribution:'"Everest" by Pavel Novak is licensed under CC BY-SA 2.5.',source:'wikimedia',width:1200,height:800}]});
 assert.equal(r!.page_url,'https://commons.wikimedia.org/wiki/File:E.jpg');
 assert.deepEqual(r!.license,{name:'CC BY-SA 2.5',url:'https://creativecommons.org/licenses/by-sa/2.5/',creator:'Pavel Novak',
  attribution:'"Everest" by Pavel Novak is licensed under CC BY-SA 2.5.'});
 assert.equal(licenseLabel('cc0',''),'CC0');
 assert.equal(licenseLabel('pdm',''),'Public domain');
 assert.equal(openverseResults({nonsense:true}).length,0);
});

const img=(id:string,title:string,extra:Partial<ImageResult>={}):ImageResult=>({id,title,image_url:`https://i.example/${id}.jpg`,thumbnail:`https://i.example/${id}-t.jpg`,
 page_url:`https://p.example/${id}`,source_name:'p.example',width:null,height:null,engine:'bing images',...extra});

test('the judge sees each image and keeps only what it shows; ranking follows its scores',async()=>{
 const seen:number[]=[];
 const judge:Judge={async judge(_q,cs,_ctx,shots){seen.push(shots?.size??0);
  return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:c.title==='Blue wall bicycle'?9:c.title==='Car'?2:6,reason:`r ${c.title}`,momentKeys:[]}]))};}};
 const out=await reviewImages({} as any,testConfig,'red bicycle against a blue wall',[img('a','Maybe bicycle'),img('b','Car'),img('c','Blue wall bicycle')],
  {judge,strong:null,thumbnail:async()=>({contentType:'image/jpeg',data:Buffer.from([0xff,0xd8,0xff,0xe0])}),log:()=>{}});
 assert.ok(seen.reduce((a,b)=>a+b,0)===3,'every thumbnail went to the judge');
 assert.deepEqual(out.results.map(r=>r.id),['c','a']);
 assert.equal(out.results[0]!.judgement!.relevance,9);
 assert.equal(out.removed,1);
});

test('PNG thumbnails are inspected; inaccessible images remain unseen',async()=>{
 let shots=-1;
 const judge:Judge={async judge(_q,cs,_ctx,s){shots=s?.size??0;return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:7,reason:'r',momentKeys:[]}]))};}};
 const out=await reviewImages({} as any,testConfig,'q',[img('a','A'),img('b','B')],{judge,strong:null,
  thumbnail:async(u:string)=>u.includes('a-t')?{contentType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10])}:Promise.reject(new Error('404')),log:()=>{}});
 assert.equal(shots,1);
 assert.ok(!out.results[0].unseen);
 assert.ok(out.results[1].unseen);
});

test('Openverse is asked for the subject, not the whole sentence',()=>{
 assert.equal(openverseQuery('free to use photo of mount everest with license and attribution',null),'mount everest');
 assert.equal(openverseQuery('creative commons pictures of a red panda','Red panda'),'Red panda');
 assert.equal(openverseQuery('royalty-free images of tokyo at night',null),'tokyo at night');
});

test('Brave image results carry the full image, its page and size; unusable rows are left out',()=>{
 const out=braveImageResults({results:[
  {title:'Red Panda',url:'https://faunafocus.com/portfolio/red-panda/',thumbnail:{src:'https://imgs.search.brave.com/x'},properties:{url:'https://faunafocus.com/p.jpg',width:700,height:218}},
  {title:'no image',url:'https://a.example/'},
  {title:'private',url:'https://b.example/',properties:{url:'http://127.0.0.1/p.jpg'}}]});
 assert.equal(out.length,1);
 assert.equal(out[0]!.image_url,'https://faunafocus.com/p.jpg');
 assert.equal(out[0]!.thumbnail,'https://imgs.search.brave.com/x');
 assert.equal(out[0]!.source_name,'faunafocus.com');
 assert.equal(out[0]!.width,700);
 assert.equal(out[0]!.engine,'brave');
 assert.equal(braveImageResults({nonsense:true}).length,0);
});

test('Brave and engine images are taken in turn, without repeats',()=>{
 const out=interleaveImages([img('a','A'),img('b','B'),img('c','C')],[img('b','B2'),img('d','D')]);
 assert.deepEqual(out.map(r=>r.id),['a','b','d','c']);
});

const at=(id:string,page:string,extra:Partial<ImageResult>={})=>img(id,id,{page_url:page,...extra});

test('a page is 60% Brave and 40% SearXNG, spread through it; a short side leaves its places to the other',()=>{
 const brave=Array.from({length:30},(_,i)=>img(`b${i}`,'B',{engine:'brave'})), searx=Array.from({length:30},(_,i)=>img(`s${i}`,'S'));
 const page=mergeShares(brave,searx,60,10);
 assert.equal(page.length,10);
 assert.equal(page.filter(r=>r.engine==='brave').length,6);
 assert.deepEqual(page.slice(0,4).map(r=>r.id[0]),['b','s','b','s']);
 assert.equal(mergeShares(brave.slice(0,2),searx,60,10).filter(r=>r.engine==='brave').length,2);
 assert.equal(mergeShares(brave,searx.slice(0,1),60,10).filter(r=>r.engine==='brave').length,9);
 assert.equal(mergeShares([],searx,60,10).length,10);
 assert.equal(mergeShares([img('x','X')],[img('x','X'),img('y','Y')],60,10).length,2,'an image both found is counted once');
});

test('the focus site leads, originals follow, stock and repin copies go last',()=>{
 const out=bySource([at('pin','https://www.pinterest.com/pin/1'),at('blog','https://blog.example/a'),at('stock','https://www.istockphoto.com/p/1'),
  at('ps','https://picsart.com/i/1'),at('ps2','https://x.example/a',{image_url:'https://cdn-cms-uploads.picsart.com/a.jpg'})],'picsart.com');
 assert.deepEqual(out.map(r=>r.id),['ps','ps2','blog','pin','stock']);
 assert.deepEqual(bySource([at('pin','https://in.pinterest.com/pin/1'),at('blog','https://blog.example/a')]).map(r=>r.id),['blog','pin']);
});

test('stock previews, repins, shops, wallpaper farms and tiny pictures are weak sources unless the request asks for them',()=>{
 const big={width:1200,height:800};
 assert.ok(weakSource(at('a','https://www.dreamstime.com/x',big),'red panda eating bamboo'));
 assert.ok(!weakSource(at('a','https://www.dreamstime.com/x',big),'red panda stock photo'));
 assert.ok(weakSource(at('a','https://www.redbubble.com/i/poster/x',big),'bauhaus poster design'));
 assert.ok(!weakSource(at('a','https://www.redbubble.com/i/poster/x',big),'buy bauhaus poster'));
 assert.ok(weakSource(at('a','https://wallpapers.com/x',big),'monogatari series art style'));
 assert.ok(!weakSource(at('a','https://wallpapers.com/x',big),'monogatari wallpaper'));
 assert.ok(weakSource(at('a','https://www.artofit.org/x',big),'bauhaus poster'));
 assert.ok(weakSource(at('a','https://www.reddit.com/r/anime/x',{width:140,height:78}),'monogatari'));
 assert.ok(!weakSource(at('a','https://www.wwf.org.uk/x',big),'red panda eating bamboo'));
});

test('judged images: a weak source ranks below originals scoring within two points, and no site fills the page',()=>{
 const row=(id:string,page:string,relevance:number,i:number)=>({image:at(id,page,{width:1200,height:800}),relevance,i});
 const out=pageOrder([row('stock','https://www.alamy.com/a',9,0),row('wwf','https://www.wwf.org.uk/a',8,1),row('blog','https://blog.example/a',6,2)],'red panda');
 assert.deepEqual(out.map(r=>r.image.id),['wwf','stock','blog']);
 const many=pageOrder([1,2,3,4,5].map(n=>row(`c${n}`,`https://carbuzz.com/${n}`,9,n)).concat(row('other','https://www.motortrend.com/a',7,9)),'cybertruck');
 assert.deepEqual(many.map(r=>r.image.id),['c1','c2','c3','other','c4','c5']);
});

test('copies of one picture collapse to the original publisher; different pictures stay',async()=>{
 const sharp=(await import('sharp')).default;
 const picture=(flip:boolean,size:number,q:number)=>sharp(Buffer.from(Array.from({length:64*64*3},(_,i)=>{const p=Math.floor(i/3),x=p%64,y=Math.floor(p/64);
  return flip?((63-x)*4+y)%256:(x*4+y)%256;})),{raw:{width:64,height:64,channels:3}}).resize(size,size).jpeg({quality:q}).toBuffer();
 const hashes=await Promise.all((await Promise.all([picture(false,64,90),picture(false,40,50),picture(true,64,90)])).map(differenceHash));
 assert.ok(hashes.every(h=>h!=null));
 const {kept,dropped}=collapseDuplicates([at('stock','https://www.alamy.com/x'),at('own','https://photographer.example/x'),at('other','https://b.example/y')],hashes);
 assert.deepEqual(kept.map(r=>r.id),['own','other']);
 assert.equal(dropped,1);
 assert.equal(await differenceHash(Buffer.from('not an image')),null);
});

test('Brave runs the request and every redesign, and the pool mixes their results',async()=>{
 const asked:string[]=[];
 const transport=(async(url:string)=>{const q=new URL(url).searchParams.get('q')!;asked.push(q);
  return {results:[1,2].map(n=>({title:`${q} ${n}`,url:`https://p${n}.example/${encodeURIComponent(q)}`,properties:{url:`https://i${n}.example/${encodeURIComponent(q)}.jpg`}}))};}) as any;
 const out=await searchImages({} as any,{...testConfig,SEARXNG_BASE_URL:'',BRAVE_SEARCH_API_KEY:'k',OPENVERSE_ENABLED:false} as any,
  {q:'red panda',limit:48,page:1} as any,{plan:async()=>({query:'red panda',corrected:'red panda',changed:false,topic:'Red panda',
   searches:['red panda eating bamboo in a tree','Ailurus fulgens feeding'],look_for:[]}),review:false,budget:async()=>true,transport});
 assert.deepEqual(asked.sort(),['Ailurus fulgens feeding','red panda','red panda eating bamboo in a tree']);
 assert.equal(out.results.length,6);
 assert.deepEqual(out.results.slice(0,3).map(r=>r.title.split(' ').slice(0,3).join(' ')),['red panda 1','red panda eating','Ailurus fulgens feeding'],'one from each search in turn');
});

test('among equally relevant images the original publisher comes before stock and repin copies',async()=>{
 const judge:Judge={async judge(_q,cs){return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:8,reason:'r',momentKeys:[]}]))};}};
 const out=await reviewImages({} as any,testConfig,'q',[at('pin','https://www.pinterest.com/pin/1'),at('own','https://blog.example/a')],
  {judge,strong:null,thumbnail:async()=>({contentType:'image/jpeg',data:Buffer.from([0xff,0xd8,0xff,0xe0])}),log:()=>{}});
 assert.deepEqual(out.results.map(r=>r.id),['own','pin']);
});

test('captions are matched on the query\'s distinctive words, stems included',()=>{
 assert.equal(captionMatch('vintage travel poster','Vintage Travel Posters of Italy'),1);
 assert.equal(captionMatch('pop art graphics design','Pop art patterns'),0.5);
 assert.equal(captionMatch('retro art style','Anything'),0,'"art" and "style" are generic, "retro" is not there');
 assert.equal(captionMatch('art style','Anything'),1,'a query of only generic words asks nothing of the caption');
});

test('SearXNG images: focus site first, then engine quality and caption; strict engines and the focus site need the whole query',()=>{
 const out=rankSearxng([
  img('y','Red panda eating bamboo',{engine:'yandex images'}),
  img('b','Red panda eating bamboo',{engine:'bing images'}),
  img('f1','Red panda eating bamboo leaves',{engine:'flickr'}),
  img('f2','Calgary zoo visit',{engine:'flickr'}),
  img('p1','Red panda eating bamboo',{engine:'bing images',page_url:'https://picsart.com/i/1'}),
  img('p2','Cute sticker',{engine:'bing images',page_url:'https://picsart.com/i/2'}),
  img('b2','Pandas',{engine:'bing images'})],'red panda eating bamboo','picsart.com',new Set(['flickr']));
 assert.deepEqual(out.map(r=>r.id),['p1','b','b2','y','f1']);
});

test('planned image searches that only repeat or pad the request are dropped; the one adding most leads',()=>{
 assert.equal(novelty('monogatari series art style','Monogatari series art style anime visuals'),0);
 assert.deepEqual(rankSearches('monogatari series art style',['Monogatari series art style anime visuals','Monogatari Shaft Akiyuki Shinbo visual style','shaft studio monogatari']),
  ['Monogatari Shaft Akiyuki Shinbo visual style','shaft studio monogatari']);
 assert.deepEqual(rankSearches('1984 film poster',['film poster design','1984 movie poster original']),['1984 movie poster original'],'a search dropping the year is refused');
});

test('the image planner keeps the request\'s meaning and falls back to the typed query on failure',async()=>{
 const config={...testConfig,QUERY_REWRITE_ENABLED:true,IMAGE_PLAN_TIMEOUT_MS:1000} as any;
 clearImagePlanCache();
 const plan=await planImages({} as any,config,'monogatri art style',{log:()=>{},model:async()=>({shows:['x'],captions:['y'],corrected:'monogatari art style',topic:'Monogatari',
  simple:'monogatari art',alternate:'Akiyuki Shinbo Shaft head tilt',look_for:['stark geometric backgrounds','text card frames']})});
 assert.equal(plan.corrected,'monogatari art style');
 assert.deepEqual(plan.searches,['monogatari art','Akiyuki Shinbo Shaft head tilt'],'simple version first, then the alternate terminology');
 assert.deepEqual(plan.look_for,['stark geometric backgrounds','text card frames']);
 const drifted=await planImages({} as any,config,'cat drawing',{log:()=>{},model:async()=>({corrected:'dog painting',topic:null,simple:'dog',alternate:'dog oil painting',look_for:[]})});
 assert.equal(drifted.corrected,'cat drawing');
 assert.deepEqual(drifted.searches,[],'a plan that changed the request is not searched');
 const failed=await planImages({} as any,config,'red fox',{log:()=>{},model:async()=>{throw new Error('down');}});
 assert.deepEqual(failed.searches,[]);
});

test('an alternate Jev reads as asking for something else is not searched; the simple version is never sent to Jev',async()=>{
 const config={...testConfig,QUERY_REWRITE_ENABLED:true,IMAGE_PLAN_TIMEOUT_MS:1000} as any;
 const model=async()=>({corrected:'lonely astronaut standing in red desert',topic:null,look_for:[],
  simple:'astronaut red desert',alternate:'astronaut alone Mars landscape'});
 clearImagePlanCache();
 let asked:string[]=[];
 const kept=await planImages({} as any,config,'lonely astronaut standing in red desert',{log:()=>{},model,intent:async(_q,list)=>{asked=list;return list.map(()=>true);}});
 assert.deepEqual(kept.searches,['astronaut red desert','astronaut alone Mars landscape']);
 assert.deepEqual(asked,['astronaut alone Mars landscape']);
 clearImagePlanCache();
 const refused=await planImages({} as any,config,'lonely astronaut standing in red desert',{log:()=>{},model,intent:async(_q,list)=>list.map(()=>false)});
 assert.deepEqual(refused.searches,['astronaut red desert']);
});

test('the simple version uses only the request\'s own words, fewer of them, and keeps its numbers',()=>{
 assert.equal(simpleSearch('lonely astronaut standing in red desert','astronaut red desert'),'astronaut red desert');
 assert.equal(simpleSearch('lonely astronaut standing in red desert','astronaut Mars'),null,'a new word is not a simplification');
 assert.equal(simpleSearch('red fox','red fox'),null,'nothing shorter to search');
 assert.equal(simpleSearch('1984 film poster','film poster'),null,'a dropped year is refused');
 assert.equal(simpleSearch('1984 film poster','1984 poster'),'1984 poster');
});

test('the Images job searches, then checks, and shows only judged images, best first',async()=>{
 const judge:Judge={async judge(_q,cs){return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:c.title.startsWith('good')?9:2,reason:'r',momentKeys:[]}]))};}};
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const images=Array.from({length:40},(_,i)=>img(`x${i}`,i%2?`good ${i}`:`bad ${i}`));
 const token=startImageJob({} as any,{...testConfig,IMAGE_REVIEW_ENABLED:true,IMAGE_JUDGE_POOL:12} as any,'q',48,async()=>{await gate;
  return {plan:{corrected:'q',changed:false},images,providers:[],next_cursor:'2'};},
  {judge,strong:null,screener:undefined,thumbnail:async()=>({contentType:'image/jpeg',data:Buffer.from([0xff,0xd8,0xff,0xe0])}),log:()=>{}})!;
 assert.equal(imageReviewState(token)!.stage,'searching');
 assert.equal(imageReviewState(token)!.results.length,0,'nothing is shown before judging');
 release();
 for(let i=0;i<50&&imageReviewState(token)!.status!=='complete';i++)await new Promise(r=>setTimeout(r,20));
 const done=imageReviewState(token)!;
 assert.equal(done.status,'complete');
 assert.equal(done.results.length,6,'only the judged pool, and only what matched');
 assert.ok(done.results.every(r=>r.judgement?.relevance===9));
 assert.equal(done.next_cursor,'2');
});
