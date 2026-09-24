import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exploreGaps,gapSearches,type GapCandidate,type GapChooser} from '../src/gaps.js';
import {inspect,coverage} from '../src/evidence.js';
import {normaliseContract} from '../src/requirements.js';
import type {PageEvidence} from '../src/pages.js';

const DAY='2026-09-24';
const contract=normaliseContract('official whatsapp chat ui interface from over past 3 years',DAY,{
 entities:[{name:'WhatsApp',kind:'product'}],official_domains:['whatsapp.com']});
const cand=(url:string,title='WhatsApp chat',target:'web'|'videos'='web'):GapCandidate=>({url,title,description:null,published_at:null,from_url:null,target});
// A small web: official posts dated by year, each linking to the next one.
const site:Record<string,{day:string|null;links:string[];official?:boolean}>={
 'https://blog.whatsapp.com/2024':{day:'2024-05-09',links:['https://blog.whatsapp.com/2023']},
 'https://blog.whatsapp.com/2023':{day:'2023-11-02',links:['https://blog.whatsapp.com/2025']},
 'https://blog.whatsapp.com/2025':{day:'2025-02-13',links:[]},
 'https://blog.whatsapp.com/2026':{day:'2026-03-01',links:[]},
 'https://news.example.org/whatsapp':{day:null,links:['https://blog.whatsapp.com/2026']},
};
const pageOf=(url:string):PageEvidence=>{const s=site[url];
 return s?{status:'checked',title:'WhatsApp chat',description:null,text:null,libraries:[],badges:[],links:s.links.map(u=>({url:u,title:'WhatsApp chat update'})),
   meta:{site_name:new URL(url).hostname.endsWith('whatsapp.com')?'WhatsApp':'News',...(s.day?{published:s.day}:{})}}
   :{status:'unavailable',title:null,description:null,text:null,libraries:[],badges:[]};};

function harness(opts:{chooser?:GapChooser;searchResults?:Record<string,string[]>}={}){
 const visited:string[]=[],searched:string[][]=[];
 return {visited,searched,run:(over:Partial<Parameters<typeof exploreGaps>[0]>={})=>exploreGaps({
   contract,initial:[cand('https://news.example.org/whatsapp'),cand('https://blog.whatsapp.com/2024')],initialInspect:2,
   inspect:async c=>{visited.push(c.url);const page=pageOf(c.url);
     return {findings:inspect(contract,{url:c.url,title:c.title,description:null,page}),links:page.links??[],title:page.title,description:null};},
   search:async searches=>{searched.push(searches.map(s=>s.query));
     return searches.flatMap(s=>(opts.searchResults?.[s.query]??[]).map(u=>cand(u)));},
   chooser:opts.chooser,rounds:2,visits:6,searches:4,target:1,deadline:Infinity,skip:()=>false,...over})};
}

test('exploration targets the gaps it finds, records which gap each action targets, and stops when covered',async()=>{
 const chooser:GapChooser={async choose(_c,gaps,_s,candidates){
   return {failed_batches:0,decisions:candidates.map(c=>({url:c.url,gap:gaps.find(g=>c.url.endsWith(g.item??'-'))?.key??null,confidence:0.9}))};}};
 const h=harness({chooser});
 const out=await h.run();
 assert.deepEqual(out.trace.initial_gaps.map(g=>g.item).filter(Boolean),['2023','2025','2026']);
 assert.equal(out.trace.stop,'covered');
 const visits=out.trace.rounds.flatMap(r=>r.visits);
 assert.ok(visits.every(v=>v.targets.length),'every visit names the gap it targets');
 assert.ok(visits.some(v=>v.url==='https://blog.whatsapp.com/2023'&&v.targets.includes(out.trace.initial_gaps.find(g=>g.item==='2023')!.key)));
 assert.ok(!coverage(contract,out.findings,1).gaps.some(g=>g.item),'all years covered');
 assert.equal(new Set(h.visited).size,h.visited.length,'no URL is visited twice');
 assert.ok(out.trace.coverage_gain_per_visit>0);
});

test('exploration is bounded by visits, rounds and the deadline, and stops when a round adds nothing',async()=>{
 const none:GapChooser={async choose(_c,_g,_s,candidates){return {failed_batches:0,decisions:candidates.map(c=>({url:c.url,gap:null,confidence:0.9}))};}};
 const stuck=await harness({chooser:none}).run({initial:[cand('https://news.example.org/whatsapp')],initialInspect:1});
 assert.equal(stuck.trace.stop,'no_candidates','Jev choosing nothing leaves no visit to make');
 const capped=harness();
 const out=await capped.run({visits:1});
 assert.ok(out.trace.visits<=1);assert.equal(out.trace.stop,'visits');
 const late=await harness().run({deadline:Date.now()-1});
 assert.deepEqual([late.trace.stop,late.trace.rounds.length],['deadline',0]);
 const barren=harness();
 const dry=await barren.run({initial:[cand('https://news.example.org/whatsapp')],initialInspect:1,
   inspect:async c=>{barren.visited.push(c.url);return {findings:[],links:[{url:`${c.url}/more`,title:'WhatsApp chat more'}],title:'x',description:null};}});
 assert.equal(dry.trace.stop,'no_gain');
 assert.equal(dry.trace.rounds.length,1,'a round that closes nothing ends exploration');
});

test('without Jev, exploration falls back to deterministic order; gap searches are built from the contract, never from a model',async()=>{
 const h=harness({searchResults:{'whatsapp chat ui interface 2025':['https://blog.whatsapp.com/2025']}});
 const out=await h.run({chooser:undefined});
 assert.ok(out.trace.rounds.length>=1);
 assert.ok(h.searched.flat().includes('whatsapp chat ui interface 2025'));
 assert.ok(h.searched.flat().some(q=>q.startsWith('site:whatsapp.com')),'an authority gap searches the hypothesised domain; the page must still be inspected');
 const failing:GapChooser={async choose(){throw new Error('down');}};
 const fallback=await harness({chooser:failing}).run();
 assert.ok(fallback.trace.rounds.length>=1,'a failed Jev call falls back instead of stopping');
 assert.ok(fallback.trace.rounds[0].decisions_failed);
});

test('gap searches: year gaps, format gaps and full-work gaps',()=>{
 const gaps=coverage(contract,[],1).gaps;
 const qs=gapSearches(contract,gaps,[],8).map(s=>s.query);
 assert.ok(qs.includes('whatsapp chat ui interface 2023'));
 assert.ok(qs.every(q=>q.split(' ').length<=12));
 const roswell=normaliseContract('rosswell ufo incident real article',DAY,{});
 assert.deepEqual(gapSearches(roswell,coverage(roswell,[],1).gaps,[],4).map(s=>[s.query,s.target]),[['rosswell ufo incident real article','web']]);
 const book=normaliseContract('robert greene art of seduction pdf',DAY,{completeness:'full',entities:[{name:'The Art of Seduction',kind:'work'}]});
 const bq=gapSearches(book,coverage(book,[],1).gaps,[],8).map(s=>s.query);
 assert.ok(bq.some(q=>/ebook/.test(q))&&bq.some(q=>/library/.test(q)),'a full-work gap looks for stores and libraries');
 assert.ok(!bq.some(q=>/free download/i.test(q)));
});

test('unauthorized and skipped addresses are never visited',async()=>{
 const h=harness();
 await h.run({initial:[cand('https://oceanofpdf.com/x'),cand('https://blog.whatsapp.com/2024')],skip:(u:string)=>u.includes('oceanofpdf')});
 assert.ok(!h.visited.some(u=>u.includes('oceanofpdf')));
});
