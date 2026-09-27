import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ModelJudge, enforceRequirements, visualReference, type Judge, type JudgeCandidate, type JudgeContext, type Verdict} from '../src/judge.js';
import type {ModelClient} from '../src/model-client.js';
import {cascadeReview, type CascadeOptions} from '../src/cascade.js';
import {completeContract, planContract} from '../src/search-contract.js';
import {rulesContract} from '../src/requirements.js';
import {snippetsOf} from '../src/jev-judge.js';
import {contentHash, groupCopies} from '../src/canonical.js';
import {withSearchTrace, traceFields} from '../src/search-trace.js';
import {imageMime, reviewImages} from '../src/image-review.js';
import {testConfig} from './helpers.js';

const png=Buffer.from([137,80,78,71,13,10,26,10]);
const candidate=(key='a'):JudgeCandidate=>({key,kind:'website',site:'example.com',url:`https://example.com/${key}`,title:'An image',
 channel:null,official:false,duration:null,live:null,description:null,comments:[],moments:[],discussions:[]});
const verdict=(key='a',relevance=9):Verdict=>({key,relevance,reason:'Observed content',momentKeys:[]});
const context:JudgeContext={kind:'websites',criteria:[],requirements:[{id:'R1',text:'A red bicycle',evidence:'Visible pixels',evidence_kind:'visual'}]};
const options:CascadeOptions={border:[4,7],auditRate:0,confidence:.8,log:()=>{}};

function visualJudge(provenance=false) {
 const client={models:['fixture'],async json(_bucket:string,_system:string,text:string,_schema:unknown,images:any[]){
   const c=JSON.parse(text.split('\n').find(l=>l.startsWith('{"key"'))!);
   if(images.length)assert.equal(images[0].mimeType,'image/png');
   const check={status:'supported',field:'visual',quote:'A red bicycle stands against a blue wall.',evidence_id:c.visual?.id??'invented'};
   return {model:'fixture',value:{verdicts:[{key:c.key,relevance:9,reason:'Visible red bicycle',moment_keys:[],lesser_known:false,
     intent_checks:['subject','intent','relationship','format'].map(dimension=>({dimension,...check})),
     requirement_checks:[{id:'R1',...check},...(provenance?[{id:'R2',...check}]:[])]}]}};
 }} as unknown as ModelClient;
 return new ModelJudge(client,testConfig);
}

test('visual observations are bound to supplied pixels, without fabricated textual quotes',async()=>{
 const c={...candidate(),visual:visualReference(png,'image/png'),page:{status:'checked',title:'An image',description:null,text:null,libraries:[],screenshot:true}};
 const out=await visualJudge().judge('red bicycle',[c],context,new Map([['a',png]]));
 assert.equal(out.verdicts.get('a')!.relevance,9);
 const absent=await visualJudge().judge('red bicycle',[c],context,new Map());
 assert.equal(absent.verdicts.get('a')!.relevance,5,'a forged or stale visual reference cannot substitute for supplied pixels');
 assert.equal(absent.verdicts.get('a')!.requirementChecks![0].status,'unknown');
});

test('pixels cannot establish non-AI provenance; an unchecked exclusion stays uncertain',async()=>{
 const c={...candidate(),visual:visualReference(png,'image/png'),page:{status:'checked',title:'An image',description:null,text:null,libraries:[],screenshot:true}};
 const ctx={...context,requirements:[...context.requirements!,{id:'R2',text:'not AI-generated',evidence:'Creator provenance',evidence_kind:'provenance' as const}]};
 const out=await visualJudge(true).judge('red bicycle, not AI-generated',[c],ctx,new Map([['a',png]]));
 assert.equal(out.verdicts.get('a')!.relevance,5);
 assert.equal(out.verdicts.get('a')!.requirementChecks![1].status,'unknown');
});

test('invented contradictions become unknown, while a grounded event mismatch excludes',()=>{
 const c={...candidate(),page:{status:'checked',title:'Launch',description:null,text:'This is the Arabsat-6A launch, not the test flight.',libraries:[]}};
 const req=[{id:'R1',text:'The Falcon Heavy test flight',evidence:'Exact event identity'}];
 const bad={...verdict('a',2),requirementChecks:[{id:'R1',status:'mismatch' as const,field:'page',quote:'invented'}]};
 assert.equal(enforceRequirements(c,bad,req).relevance,5,'lack of a real contradiction is not rejection');
 const grounded={...bad,requirementChecks:[{...bad.requirementChecks[0],quote:c.page.text}]};
 assert.equal(enforceRequirements(c,grounded,req).relevance,2);
});

test('missing pixels do not call the strong judge, even when the cheap judge claimed a high score',async()=>{
 let strongCalls=0;
 const strong:Judge={async judge(){strongCalls++;throw Error('should not run');}};
 const out=await cascadeReview('red bicycle',[candidate()],new Map([['a',verdict()]]),undefined,context,undefined,strong,options);
 assert.equal(strongCalls,0);
 assert.equal(out.verdicts.get('a')!.relevance,5);
 assert.deepEqual(out.records.get('a')!.flags,['needs_evidence']);
});

test('a bounded inspection retries only changed evidence through the cheap judge',async()=>{
 let reads=0,cheapCalls=0,strongCalls=0;
 const cs=[candidate('a'),candidate('b'),candidate('c')];
 const cheap:Judge={async judge(_q,list){cheapCalls++;return {model:'cheap',verdicts:new Map(list.map(c=>[c.key,{...verdict(c.key),
   requirementChecks:[{id:'R1',status:'supported' as const,field:'visual',quote:'A red bicycle by the blue wall.',evidence_id:c.visual!.id}]}]))};}};
 const strong:Judge={async judge(){strongCalls++;throw Error('should not run');}};
 const out=await cascadeReview('red bicycle',cs,new Map(cs.map(c=>[c.key,verdict(c.key)])),undefined,context,undefined,strong,
   {...options,inspectionLimit:2,inspection:{judge:cheap,inspect:async c=>{reads++;return {...c,visual:visualReference(png,'image/png')};}}});
 assert.equal(reads,2);assert.equal(cheapCalls,2);assert.equal(strongCalls,0);
 assert.equal(out.verdicts.get('a')!.relevance,9);assert.equal(out.verdicts.get('c')!.relevance,5);
 let unchangedCalls=0;
 await cascadeReview('red bicycle',[candidate()],new Map([['a',verdict()]]),undefined,context,undefined,strong,
   {...options,inspection:{judge:{async judge(){unchangedCalls++;throw Error();}},inspect:async c=>({...c})}});
 assert.equal(unchangedCalls,0);
});

test('inspection timeout aborts the collector and retains uncertainty',async()=>{
 let signal:AbortSignal|undefined;
 const out=await cascadeReview('q',[candidate()],new Map([['a',verdict()]]),undefined,context,undefined,undefined,
   {...options,inspectionMs:10,inspection:{judge:visualJudge(),inspect:async(_c,_m,s)=>{signal=s;return new Promise(()=>{});}}});
 assert.equal(signal?.aborted,true);assert.equal(out.verdicts.get('a')!.relevance,5);
});

test('only an interpretation request anchored in supplied evidence reaches Strong',async()=>{
 const c={...candidate(),page:{status:'checked',title:'Engine test',description:null,text:'The two prototypes landed within the same second.',libraries:[]}};
 const ctx:JudgeContext={kind:'mixed',criteria:[],requirements:[{id:'R1',text:'Both prototypes land simultaneously',evidence:'The relationship between both landings'}]};
 const make=(quote:string):Verdict=>({...verdict('a',5),requirementChecks:[{id:'R1',status:'unknown',field:'page',quote,next_action:'reason'}]});
 let calls=0;
 const strong:Judge={async judge(_q,cs){calls++;assert.deepEqual(cs[0].review_focus?.requirements,['R1']);
   return {model:'strong',verdicts:new Map([['a',{...verdict(),requirementChecks:[{id:'R1',status:'supported',field:'page',quote:c.page.text}]}]])};}};
 const out=await cascadeReview('simultaneous landings',[c],new Map([['a',make(c.page.text)]]),undefined,ctx,undefined,strong,options);
 assert.equal(calls,1);assert.equal(out.verdicts.get('a')?.relevance,9);
 assert.ok(out.records.get('a')?.flags.includes('interpretation'));
 await cascadeReview('simultaneous landings',[c],new Map([['a',make('An invented observation')]]),undefined,ctx,undefined,strong,options);
 assert.equal(calls,1,'a model cannot escalate absent evidence by selecting reason');
});

test('sampled Jev rejections get an independent strong audit',async()=>{
 const c={...candidate(),page:{status:'checked',title:'Other launch',description:null,text:'This is the Arabsat mission, not the demonstration flight.',libraries:[]}};
 const check={id:'R1',status:'mismatch' as const,field:'page',quote:c.page.text};
 const ctx:JudgeContext={kind:'mixed',criteria:[],requirements:[{id:'R1',text:'The demonstration flight',evidence:'Event identity'}]};
 const jev=new Map([['a',{outcome:'rejected',requirements:{R1:{choice:'m_s1',confidence:.99,check}}}]]);
 let calls=0;
 const strong:Judge={async judge(){calls++;return {model:'strong',verdicts:new Map([['a',{...verdict('a',2),requirementChecks:[check]}]])};}};
 const out=await cascadeReview('demonstration flight',[c],new Map([['a',{...verdict('a',2),requirementChecks:[check]}]]),jev,ctx,undefined,strong,
   {...options,auditRate:1,random:()=>0});
 assert.equal(calls,1);assert.deepEqual(out.records.get('a')?.flags,['reject_audit']);
 assert.equal(out.verdicts.get('a')?.relevance,2);
});

test('image review retries the original when its thumbnail is missing, and preserves PNG pixels',async()=>{
 const fetched:string[]=[];
 const judge=visualJudge();
 const contract=rulesContract('red bicycle','2026-09-27');
 contract.requirements=[{id:'R1',text:'A red bicycle',kind:'subject',hardness:'hard',scope:'each',evidence:'Pixels',evidence_kind:'visual'}];
 const out=await reviewImages({} as any,testConfig,'red bicycle',[{id:'a',title:'Image',image_url:'https://example.com/original.png',thumbnail:'https://example.com/thumb',
   page_url:'https://example.com/page',source_name:'example.com',width:null,height:null,engine:'fixture'}],{
   judge,strong:{async judge(){throw Error('unnecessary strong call');}},contract,screener:undefined,log:()=>{},
   thumbnail:async url=>{fetched.push(url);if(url.endsWith('/thumb'))throw Error('unavailable');return {contentType:'image/png',data:png};}});
 assert.equal(fetched.length,2);assert.equal(out.results[0].unseen,undefined);
 assert.equal(out.results[0].judgement?.relevance,9);assert.equal(out.results[0].verification,'verified');
});

test('contracts preserve late constraints and separate image appearance from provenance',async()=>{
 const q='free to use photo of mount everest with license and attribution, not AI-generated';
 const c=completeContract(rulesContract(q,'2026-09-27'),'images');
 assert.ok(c.requirements.some(r=>r.kind==='subject'&&r.evidence_kind==='visual'));
 assert.ok(c.requirements.some(r=>r.text==='not AI-generated'&&r.evidence_kind==='provenance'));
 const long=`${'A comparison of databases and their workloads '.repeat(4)}, not vendor blogs`;
 const fallback=await planContract({} as any,testConfig,long,'web');
 assert.ok(fallback.requirements.some(r=>r.source_quote==='not vendor blogs'));
 const draft=await planContract({} as any,testConfig,'red bicycle','images',{contractModel:async()=>({completeness:'full',requirements:[
   {text:'commercial use only',source_quote:'not in the request',kind:'property',hardness:'hard',scope:'each'}]})});
 assert.ok(!draft.requirements.some(r=>/commercial/.test(r.text)));
 assert.equal(draft.deliverable.completeness,'any');
});

test('set coverage never becomes an each-result publisher requirement',()=>{
 const q='Webb deployment with official NASA, ESA and CSA sources, not opinion blogs';
 const base=rulesContract(q,'2026-09-27',{requirements:[{text:'Each agency represented',kind:'authority',hardness:'hard',scope:'set',evidence:'Publisher',set_items:['NASA','ESA','CSA']}]});
 const c=completeContract(base,'web');
 assert.deepEqual(c.requirements.filter(r=>r.kind==='subject').map(r=>r.text),['Webb deployment']);
 assert.ok(c.requirements.some(r=>r.source_quote==='not opinion blogs'));
 assert.deepEqual(c.requirements.find(r=>r.scope==='set')?.set_items,['NASA','ESA','CSA']);
});

test('missing image provenance fetches its source page instead of repeating the pixels',async()=>{
 const contract=rulesContract('bicycle not AI-generated','2026-09-27');
 contract.requirements=[{id:'R1',text:'not AI-generated',kind:'property',hardness:'hard',scope:'each',evidence:'Creator provenance',evidence_kind:'provenance'}];
 let pages=0,images=0;
 const judge:Judge={async judge(_q,cs){return {model:'cheap',verdicts:new Map(cs.map(c=>[c.key,{...verdict(c.key),requirementChecks:[{
   id:'R1',status:c.page?.text?'supported' as const:'unknown' as const,field:'page',quote:c.page?.text??''}]}]))};}};
 const out=await reviewImages({} as any,testConfig,contract.query,[{id:'a',title:'Bicycle',image_url:'https://example.com/original.png',thumbnail:'https://example.com/thumb',
   page_url:'https://example.com/source',source_name:'example.com',width:null,height:null,engine:'fixture'}],{judge,contract,screener:undefined,log:()=>{},
   strong:{async judge(){throw Error('unnecessary strong call');}},thumbnail:async()=>{images++;return {contentType:'image/png',data:png};},
   pages:{async check(url){pages++;assert.equal(url,'https://example.com/source');return {status:'checked',title:'Creator',description:null,
     text:'The creator identifies this specific photograph as a camera original made without AI generation.',libraries:[],badges:[]};}}});
 assert.equal(images,1);assert.equal(pages,1);assert.equal(out.results[0].verification,'verified');
});

test('long page text cannot crowd transcripts and scenes out of Jev snippets',()=>{
 const c={...candidate(),page:{status:'checked',title:'A long page',description:null,text:Array.from({length:80},(_,i)=>`Unrelated sentence number ${i}.`).join(' '),libraries:[]},
   transcripts:[{start:10,end:20,text:'Both boosters begin landing at the same time.'}],
   scenes:[{start:10,end:20,description:'Two boosters touch down simultaneously.',inspected_ranges:[[10,20]]}]};
 const snippets=snippetsOf(c,[{id:'R1',text:'Both boosters land',evidence:'Scene'}]);
 assert.ok(snippets.some(s=>s.field==='transcripts'));assert.ok(snippets.some(s=>s.field==='scenes'));assert.equal(snippets.length,40);
});

test('identical copies group under the canonical source; similar titles alone never merge',()=>{
 const hash=contentHash('MapReduce is a programming model. '.repeat(20));
 const items=[{url:'https://scribd.com/document/1',title:'MapReduce',content_hash:hash},
   {url:'https://research.google.com/mapreduce.pdf',title:'MapReduce',content_hash:hash},
   {url:'https://example.org/other',title:'MapReduce',content_hash:contentHash('A different paper. '.repeat(30))}];
 const out=groupCopies(items,'Google MapReduce paper');
 assert.equal(out.length,2);assert.equal(out[0].url,items[1].url);
 assert.equal((out[0] as any).alternatives[0].url,items[0].url);
});

test('search traces survive async work and do not mix concurrent searches',async()=>{
 const ids=await Promise.all([1,2].map(async()=>withSearchTrace(async()=>{
   const id=traceFields().trace_id;await new Promise(r=>setTimeout(r,5));
   assert.equal(traceFields().trace_id,id);
   assert.equal(await withSearchTrace(async()=>traceFields().trace_id),id);return id;
 })));
 assert.notEqual(ids[0],ids[1]);assert.equal(traceFields().trace_id,undefined);
});

test('supported binary formats are recognized by bytes, not a misleading HTTP type',()=>{
 assert.equal(imageMime(png),'image/png');
 assert.equal(imageMime(Buffer.from('RIFF1234WEBP')),'image/webp');
 assert.equal(imageMime(Buffer.from('GIF89a')),'image/gif');
 assert.equal(imageMime(Buffer.from('<html>not an image</html>')),null);
});
