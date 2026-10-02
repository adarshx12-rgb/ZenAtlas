// What makes a SearXNG image result good: each image engine's top results (and the Picsart keyword search) are judged by
// the image review, then scores are compared by engine and by simple signals (caption words, size, caption present).
import {writeFileSync} from 'node:fs';
import {configSchema} from '../src/config.js';
import {connect} from '../src/db.js';
import {engineImages,type ImageResult} from '../src/images.js';
import {reviewImages} from '../src/image-review.js';
import {makeJudge} from '../src/judge.js';
import {isCopy} from '../src/image-sources.js';

const config=configSchema.parse(process.env),db=connect(config.DATABASE_URL);
const judge=makeJudge(db,config)!;
const queries=process.argv.slice(2).length?process.argv.slice(2):['pop art graphics design','retro art style','red panda eating bamboo','eiffel tower at night',
 'minimalist logo design','watercolor landscape painting','cyberpunk city wallpaper','vintage travel poster'];
const engines=config.SEARXNG_IMAGE_ENGINES.split(',').map(e=>e.trim());
const PER=6;
const words=(s:string)=>(s.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>w.length>2&&!['the','and','with','for','art','style','design'].includes(w));
const rows:any[]=[];
for(const q of queries){
 const lists=await Promise.all([...engines.map(e=>engineImages(db,config,{q,limit:48,page:1} as any,[e]).then(r=>r.results.slice(0,PER).map(x=>({...x,src:e,rank:0})))),
   engineImages(db,config,{q:`picsart ${q}`,limit:48,page:1} as any,config.SEARXNG_IMAGE_FOCUS_ENGINES.split(',').map(e=>e.trim()))
     .then(r=>r.results.filter(x=>/picsart/.test(x.page_url+x.image_url)).slice(0,PER).map(x=>({...x,src:'picsart focus',rank:0})))]);
 const seen=new Set<string>();const all=lists.flatMap(l=>l.map((x,i)=>({...x,rank:i+1}))).filter(x=>!seen.has(x.image_url)&&seen.add(x.image_url));
 const qw=words(q);
 for(let i=0;i<all.length;i+=24){
   const chunk=all.slice(i,i+24);
   const out=await reviewImages(db,config,q,chunk as ImageResult[],{judge,log:()=>{}});
   const by=new Map(out.results.map(r=>[r.id,r]));
   for(const x of chunk){const r=by.get(x.id);const tw=words(x.title);
     rows.push({q,engine:x.src,rank:x.rank,host:x.source_name,title:x.title,score:r?(r.judgement?.relevance??null):0,removed:!r,unseen:!!r?.unseen,
       overlap:qw.length?qw.filter(w=>tw.some(t=>t.startsWith(w.slice(0,5)))).length/qw.length:0,captionless:x.title===x.source_name,
       area:(x.width??0)*(x.height??0),copy:isCopy(x)});}
 }
 console.log(q,'done',all.length);
}
writeFileSync(`output/searxng-image-quality-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify(rows,null,1));
const judged=rows.filter(r=>r.score!==null&&!r.unseen);
const sum=(f:(r:any)=>boolean,label:string)=>{const g=judged.filter(f);if(!g.length)return;const good=g.filter(r=>r.score>=8).length,bad=g.filter(r=>r.score<=5).length;
 console.log(label.padEnd(34),'n',String(g.length).padStart(3),'mean',(g.reduce((a,r)=>a+r.score,0)/g.length).toFixed(1),'good(8+)',`${Math.round(100*good/g.length)}%`.padStart(4),'bad(<=5)',`${Math.round(100*bad/g.length)}%`.padStart(4));};
console.log('\nBY ENGINE');for(const e of [...engines,'picsart focus'])sum(r=>r.engine===e,e);
console.log('\nBY SIGNAL');
sum(r=>r.overlap>=0.99,'caption has every query word');sum(r=>r.overlap>0&&r.overlap<0.99,'caption has some query words');sum(r=>r.overlap===0&&!r.captionless,'caption has no query word');
sum(r=>r.captionless,'no caption (filename/host)');sum(r=>r.area>=600*400,'large (>=600x400)');sum(r=>r.area>0&&r.area<600*400,'small');sum(r=>r.area===0,'size unknown');
sum(r=>r.copy,'stock/repin host');sum(r=>r.rank<=2,'engine rank 1-2');sum(r=>r.rank>=5,'engine rank 5-6');
console.log('\nunseen',rows.filter(r=>r.unseen).length,'of',rows.length);
await db.end?.();process.exit(0);
