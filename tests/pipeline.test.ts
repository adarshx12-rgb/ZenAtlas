import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {runDiscovery} from '../src/discovery.js';
import {contentInput,searchInput,type SourceAdapter} from '../src/types.js';
import type {Planner} from '../src/planner.js';
import type {Judge,JudgeContext} from '../src/judge.js';
import type {PageEvidence} from '../src/pages.js';
import type {Screener,ScreenContract} from '../src/screener.js';
import type {GapChooser} from '../src/gaps.js';
import {traceMetrics} from '../src/learning.js';

// End-to-end runs of the requirements pipeline with recorded pages: no live calls.
const DAY='2026-09-24';
const config={...testConfig,PAGE_CHECKS:20};
type Row={url:string;title:string;description?:string};
const provider=(answers:Record<string,Row[]>,asked:string[]=[]):SourceAdapter=>({name:'fixture',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
 async search(q){asked.push(q);return {results:(answers[q]??[]).map(r=>contentInput.parse({description:null,...r})),next_cursor:null,status:{provider:'fixture',status:'ok',message:'TEST'}};}});
const checked=(p:Partial<PageEvidence>):PageEvidence=>({status:'checked',title:null,description:null,text:null,libraries:[],badges:[],...p});
const pagesOf=(site:Record<string,PageEvidence>,visited:string[]=[])=>({async check(url:string){visited.push(url);
 return site[url]??{status:'unavailable' as const,title:null,description:null,text:null,libraries:[],badges:[]};}});
// A judge that finds every candidate on topic, quoting its own title, and supports each listed requirement likewise.
const judgeSeeing=(contexts:(JudgeContext|undefined)[]=[]):Judge=>({async judge(_q,cs,context){contexts.push(context);
 return {model:'judge',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:8,reason:`About ${c.title}`,momentKeys:[],
   intentChecks:(['subject','intent','relationship','format'] as const).map(dimension=>({dimension,status:'supported' as const,field:'title' as const,quote:c.title.slice(0,20)})),
   requirementChecks:(context?.requirements??[]).map(r=>({id:r.id,status:'supported' as const,field:'title',quote:c.title.slice(0,20)}))}]))};}});
const planned=(draft:unknown,searches:string[]):Planner=>({async plan(query){return {kind:'mixed',searches:[query,...searches].map(q=>({query:q,target:'web' as const})),criteria:[],model:'plan',draft};}});

test('Roswell "real article": the contract reaches every stage, videos cannot satisfy an article-only request, and the judge cannot overrule inspection',async()=>{
 const db=await database();
 try{
   const q='rosswell ufo incident real article';
   const rows=[{url:'https://www.youtube.com/watch?v=abcdefghijk',title:'Roswell: The First Reports documentary'},
     {url:'https://www.smithsonianmag.com/history/roswell-incident',title:'What really happened at Roswell'},
     {url:'https://blocked.example.org/roswell',title:'Roswell incident retrospective'}];
   const site={'https://www.smithsonianmag.com/history/roswell-incident':checked({title:'What really happened at Roswell',
     text:'In July 1947 a rancher found debris near Roswell.',meta:{og_type:'article',schema_types:['NewsArticle'],published:'2017-06-01'}}),
     'https://blocked.example.org/roswell':{status:'robots_disallowed' as const,title:null,description:null,text:null,libraries:[],badges:[]}};
   const contexts:(JudgeContext|undefined)[]=[];let screened:ScreenContract|undefined;
   const screener:Screener={async screen(_q,cs,contract){screened=contract;return {screened:cs.length,promising:new Set()};}};
   const out=await runDiscovery(db,config,searchInput.parse({q}),[provider({[q]:rows})],
     {planner:planned({intent:'A real article about the 1947 Roswell incident',entities:[{name:'Roswell incident',kind:'event'}]},[]),
       pages:pagesOf(site),judge:judgeSeeing(contexts),screener,today:DAY},async()=>{});
   const format=out.contract!.requirements.find(r=>r.kind==='format')!;
   assert.deepEqual(format.formats,['article']);
   assert.deepEqual(screened?.requirements.map(r=>r.id),[format.id],'the screener works from the contract');
   assert.ok(contexts.every(c=>c?.requirements?.some(r=>r.id===format.id)),'the judge checks the same requirement IDs');
   assert.deepEqual(out.trace.contract?.query,q,'the trace keeps the contract with the original query');
   assert.deepEqual(out.results.map(r=>r.canonical_url),['https://www.smithsonianmag.com/history/roswell-incident']);
   assert.deepEqual(out.results[0].requirements?.map(r=>[r.id,r.status,r.excerpt]),[[format.id,'supported','NewsArticle']]);
   assert.ok(!out.ingested.some(r=>r.canonical_url.includes('youtube')),
     'inspection before admission already contradicted the article-only requirement, so the video is never admitted');
   const ablation=await runDiscovery(db,{...config,GAP_EXPLORATION:false},searchInput.parse({q}),[provider({[q]:rows})],
     {planner:planned({},[]),pages:pagesOf(site),judge:judgeSeeing(),today:DAY},async()=>{});
   const video=ablation.trace.pool.find(p=>p.url.includes('youtube'))!;
   assert.deepEqual([video.shown,video.decision?.status,video.decision?.contradicted],[false,'excluded',[format.id]],
     'admitted without exploration, the judge says supported, but the inspected format still excludes it');
   const blocked=out.trace.pool.find(p=>p.url.includes('blocked'))!;
   assert.equal(blocked.decision?.status,'uncertain','a robots refusal is unknown, not a contradiction');
   assert.ok(blocked.findings?.some(f=>f.access==='robots_disallowed'));
   assert.ok(out.closest.some(r=>r.canonical_url.includes('blocked')&&r.uncertainties?.some(u=>/Not confirmed/.test(u))),'uncertain results stay available as closest matches');
   assert.equal(traceMetrics(ablation.trace).decisions?.excluded,1);
   assert.equal(typeof traceMetrics(out.trace).unknown_rate,'number');
 }finally{await db.close();}
});

test('Art of Seduction "pdf": a summary never qualifies as the book, a store page does, and unauthorized copies are never admitted',async()=>{
 const db=await database();
 try{
   const q='robert greene art of seduction pdf';
   const rows=[{url:'https://docs.example.org/seduction-summary.pdf',title:'The Art of Seduction PDF'},
     {url:'https://www.penguinrandomhouse.com/books/331432/the-art-of-seduction-by-robert-greene/',title:'The Art of Seduction by Robert Greene'},
     {url:'https://oceanofpdf.com/authors/robert-greene/pdf-the-art-of-seduction/',title:'[PDF] The Art of Seduction by Robert Greene'}];
   const site={'https://docs.example.org/seduction-summary.pdf':checked({title:'The Art of Seduction - Summary',text:'Book summary and key takeaways.',
       meta:{content_type:'application/pdf'},pdf:{pages:38,title:'The Art of Seduction - Summary',author:'StoryShots',created:'2024-08-02',text:'Book summary and key takeaways.'}}),
     'https://www.penguinrandomhouse.com/books/331432/the-art-of-seduction-by-robert-greene/':checked({title:'The Art of Seduction by Robert Greene | Penguin Random House'})};
   const out=await runDiscovery(db,config,searchInput.parse({q}),[provider({[q]:rows})],
     {planner:planned({completeness:'full',entities:[{name:'The Art of Seduction',kind:'work'},{name:'Robert Greene',kind:'person'}]},[]),
       pages:pagesOf(site),judge:judgeSeeing(),today:DAY},async()=>{});
   assert.ok(!out.ingested.some(r=>r.canonical_url.includes('oceanofpdf')),'shadow-library copies are never admitted');
   assert.deepEqual(out.results.map(r=>new URL(r.canonical_url).hostname),['www.penguinrandomhouse.com']);
   assert.ok(out.results[0].badges?.includes('Buy'));
   assert.ok(out.results[0].uncertainties?.some(u=>/not as PDF/.test(u)),'the other file format is stated, not hidden');
   assert.ok(!out.ingested.some(r=>r.canonical_url.includes('summary')),'the summary PDF is kept out once its first page has been read');
   const ablation=await runDiscovery(db,{...config,GAP_EXPLORATION:false},searchInput.parse({q}),[provider({[q]:rows})],
     {planner:planned({completeness:'full',entities:[{name:'The Art of Seduction',kind:'work'}]},[]),pages:pagesOf(site),judge:judgeSeeing(),today:DAY},async()=>{});
   const summary=ablation.trace.pool.find(p=>p.url.includes('summary'))!;
   assert.equal(summary.decision?.status,'excluded');
   assert.ok(summary.findings?.some(f=>f.status==='contradicted'&&f.method==='pdf_parse'&&/Summary/.test(f.excerpt??'')));
 }finally{await db.close();}
});

test('WhatsApp "official … past 3 years": official status and dates need evidence; exploration targets the missing years and reports what stays unmet',async()=>{
 const db=await database();
 try{
   const q='official whatsapp chat ui interface from over past 3 years';
   const rows=[{url:'https://blog.whatsapp.com/2024-refresh',title:'WhatsApp chat UI refresh'},
     {url:'https://www.theverge.com/whatsapp-redesign',title:'WhatsApp chat UI redesign'},
     {url:'https://blog.whatsapp.com/2019-dark-mode',title:'WhatsApp chat UI dark mode'},
     {url:'https://blog.whatsapp.com/undated',title:'WhatsApp chat UI tips'}];
   const post=(title:string,day:string|null,links:string[]=[])=>checked({title,links:links.map(url=>({url,title:'WhatsApp chat UI update'})),
     meta:{site_name:'WhatsApp',...(day?{published:day}:{})}});
   const site:Record<string,PageEvidence>={
     'https://blog.whatsapp.com/2024-refresh':post('WhatsApp chat UI refresh','2024-05-09',['https://blog.whatsapp.com/2025-themes']),
     'https://www.theverge.com/whatsapp-redesign':checked({title:'WhatsApp chat UI redesign',meta:{site_name:'The Verge',published:'2024-06-01'}}),
     'https://blog.whatsapp.com/2019-dark-mode':post('WhatsApp chat UI dark mode','2019-03-01'),
     'https://blog.whatsapp.com/undated':post('WhatsApp chat UI tips',null),
     'https://blog.whatsapp.com/2025-themes':post('WhatsApp chat UI themes','2025-02-13'),
   };
   const visited:string[]=[];const asked:string[]=[];
   const chooser:GapChooser={async choose(contract,gaps,_c,cands){
     assert.equal(contract.query,q,'Jev explores against the same contract');
     return {failed_batches:0,decisions:cands.map(c=>({url:c.url,gap:c.url.includes('2025')?gaps.find(g=>g.item==='2025')?.key??null:null,confidence:0.9}))};}};
   const out=await runDiscovery(db,{...config,GAP_TARGET_RESULTS:1},searchInput.parse({q,depth:'deep'}),[provider({[q]:rows},asked)],
     {planner:planned({entities:[{name:'WhatsApp',kind:'product'}],official_domains:['whatsapp.com']},[]),pages:pagesOf(site,visited),
       judge:judgeSeeing(),gapChooser:chooser,today:DAY},async()=>{});
   const shown=out.results.map(r=>r.canonical_url);
   assert.ok(shown.includes('https://blog.whatsapp.com/2024-refresh'));
   assert.ok(shown.includes('https://blog.whatsapp.com/2025-themes'),'exploration followed a real link to close the 2025 gap');
   assert.ok(!shown.includes('https://www.theverge.com/whatsapp-redesign'),'a third-party page is not official without evidence');
   assert.ok(!out.ingested.some(r=>r.canonical_url.includes('2019')),'a page dated outside the requested window is kept out once inspected');
   assert.equal(out.trace.pool.find(p=>p.url.includes('undated'))?.decision?.status,'uncertain','a missing date is unknown, never verified');
   const gaps=out.trace.gaps!;
   assert.ok(gaps.rounds.flatMap(r=>r.visits).some(v=>v.url.endsWith('2025-themes')&&v.targets.some(t=>t.endsWith(':2025'))),'each visit records the gap it targets');
   assert.ok(gaps.closed.some(k=>k.endsWith(':2025')));
   assert.ok(asked.some(a=>/2023/.test(a)),'a targeted search went after the uncovered 2023');
   assert.ok(out.unmet!.some(u=>/2023/.test(u))&&out.unmet!.some(u=>/2026/.test(u)),'years nobody covers are reported');
   assert.equal(new Set(visited).size,visited.length,'each page is fetched once per search');
   const m=traceMetrics(out.trace);
   assert.ok((m.coverage_gain_per_visit??0)>0);assert.ok(m.requirement_satisfaction!>0&&m.requirement_satisfaction!<1);
 }finally{await db.close();}
});

test('multi-source research: result-set coverage names each organisation that is still missing',async()=>{
 const db=await database();
 try{
   const q='timeline of the James Webb Space Telescope deployment with official NASA, ESA and CSA sources';
   const rows=[{url:'https://www.nasa.gov/webb-deployment',title:'Webb deployment timeline'},{url:'https://www.esa.int/webb/deployment',title:'Webb unfolds'}];
   const site={'https://www.nasa.gov/webb-deployment':checked({title:'Webb deployment timeline',meta:{site_name:'NASA',published:'2022-01-08'}}),
     'https://www.esa.int/webb/deployment':checked({title:'Webb unfolds',meta:{site_name:'ESA',published:'2022-01-09'}})};
   const out=await runDiscovery(db,{...config,GAP_TARGET_RESULTS:1},searchInput.parse({q}),[provider({[q]:rows})],
     {planner:planned({entities:[{name:'James Webb Space Telescope',kind:'product'}],requirements:[
       {text:'An official source from each agency',kind:'authority',hardness:'hard',scope:'set',evidence:'Published by the agency',set_items:['NASA','ESA','CSA']}]},[]),
       pages:pagesOf(site),judge:judgeSeeing(),gapChooser:{async choose(){return {decisions:[],failed_batches:0};}},today:DAY},async()=>{});
   const set=out.contract!.requirements.find(r=>r.scope==='set'&&r.kind==='authority')!;
   assert.deepEqual(set.set_items,['NASA','ESA','CSA']);
   assert.equal(out.results.length,2,'a set requirement is not demanded of each result');
   assert.deepEqual(out.unmet,[`No result found for CSA: ${set.text}`]);
   assert.equal(out.trace.gaps?.stop,'no_candidates','exploration stops when Jev finds nothing worth opening');
 }finally{await db.close();}
});

test('bounded: exploration respects the visit cap, and the baseline and ablation switches turn the new stages off',async()=>{
 const db=await database();
 try{
   const q='whatsapp chat ui articles from past 3 years';
   const many=Array.from({length:30},(_,i)=>({url:`https://news${i}.example.org/w`,title:`WhatsApp chat UI article ${i}`}));
   const visited:string[]=[];
   const out=await runDiscovery(db,{...config,JEV_EXPLORATION_VISITS:4},searchInput.parse({q,depth:'deep'}),[provider({[q]:many})],
     {planner:planned(undefined,[]),pages:pagesOf({},visited),judge:judgeSeeing(),today:DAY},async()=>{});
   assert.ok(out.trace.gaps!.visits<=4);
   assert.equal(out.contract?.source,'rules','a planner without a contract draft yields the rules-only contract');
   const ablation=await runDiscovery(db,{...config,GAP_EXPLORATION:false},searchInput.parse({q}),[provider({[q]:many})],
     {planner:planned(undefined,[]),pages:pagesOf({}),judge:judgeSeeing(),today:DAY},async()=>{});
   assert.equal(ablation.trace.gaps,undefined);assert.ok(ablation.contract);
   const baseline=await runDiscovery(db,{...config,REQUIREMENTS_ENABLED:false},searchInput.parse({q}),[provider({[q]:many})],
     {planner:planned(undefined,[]),pages:pagesOf({}),judge:judgeSeeing(),today:DAY},async()=>{});
   assert.equal(baseline.contract,null);assert.equal(baseline.trace.contract,undefined);
   assert.ok(baseline.results.every(r=>!r.requirements));
 }finally{await db.close();}
});
