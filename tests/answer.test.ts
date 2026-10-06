import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answerIntent, collectAnswerSources, generateAnswer, type AnswerSource, type AnswerDeps} from '../src/answer.js';
import {startWebReview, webReviewState, cancelWebAnswer, webReviewSnapshot} from '../src/web-review.js';
import {PageChecker, type PageEvidence} from '../src/pages.js';
import type {WebResult} from '../src/web.js';
import {testConfig} from './helpers.js';

const row=(n:number):WebResult & {judgement:{relevance:number;reason:string}}=>({id:`r${n}`,url:`https://site${n}.example/article`,title:`Solar article ${n}`,
 source_name:`site${n}.example`,snippet:'A snippet is not evidence.',published:null,doc_type:null,access:null,engine:'brave',preview:null,
 judgement:{relevance:9,reason:'Relevant'}});
const passage='Solar panels convert sunlight into electricity. Solar output varies with sunlight, shade and the orientation of the panels. ';
const page=(n=1):PageEvidence=>({status:'checked',title:'Solar panels',text:passage,description:null,libraries:[],badges:[],
 evidence:{text:passage+`Article ${n}.`,url:row(n).url,fetched_at:'2026-10-07T10:00:00Z'}});
const sources:AnswerSource[]=collectAnswerSources('solar panels',[row(1)],new Map([[row(1).url,page()]]),8);
const draft={model:'writer',value:{claims:[{text:'Solar panels convert sunlight into electricity.',evidence:['s1p1']}]}};
const verified={model:'checker',value:{checks:[{id:'c1',status:'supported',evidence:['s1p1']}]}};
const deps:AnswerDeps={write:async()=>draft,verify:async()=>verified};
const run=(d:AnswerDeps)=>generateAnswer({} as any,testConfig,'How do solar panels work?',sources,{deps:d});

test('answer evidence uses readable passages, promotes routed sources independently of visible order and removes copies',()=>{
 const a=row(1),b=row(2),c=row(3),d=row(4);
 const pages=new Map([[a.url,page(1)],[b.url,page(2)],[c.url,{...page(3),evidence:{...page(1).evidence!,url:c.url}}],
 [d.url,{...page(4),status:'unavailable' as const}]]);
 const found=collectAnswerSources('solar panels',[a,b,c,d],pages,8,new Set([b.url]));
 assert.deepEqual(found.map(s=>s.url),[b.url,a.url]);
 assert.equal(found[0].passages[0].text,page(2).evidence!.text);
 assert.equal(collectAnswerSources('solar',[a],new Map([[a.url,{...page(),evidence:undefined}]]),8).length,0);
 assert.equal(collectAnswerSources('solar',[{...a,judgement:undefined}],pages,8).length,0);
 assert.equal(collectAnswerSources('solar',[a],new Map([[a.url,{...page(),evidence:{...page().evidence!,url:'http://127.0.0.1/private'}}]]),8).length,0);
});

test('passage selection can find a relevant section beyond the ranking excerpt and retains exact offsets',()=>{
 const text='General background without the query terms. '.repeat(100)+passage.repeat(3);
 const found=collectAnswerSources('solar panels',[row(1)],new Map([[row(1).url,{...page(),evidence:{...page().evidence!,text}}]]),8);
 assert.ok(found[0].passages.some(p=>p.start>800&&p.text.includes('Solar panels')));
 for(const p of found[0].passages)assert.equal(text.slice(p.start,p.end),p.text);
});

test('the writer and independent verifier must agree on valid evidence before a claim is published',async()=>{
 const out=await run(deps);
 assert.equal(out.status,'ready');assert.equal(out.claims.length,1);assert.equal(out.sources[0].passages[0].id,'s1p1');
 const stages:string[]=[];
 await generateAnswer({} as any,testConfig,'solar',sources,{deps,onStage:s=>stages.push(s.status)});
 assert.deepEqual(stages,['drafting','checking']);
});

test('unknown citations, omitted checks, duplicate checks, and unsupported or altered references fail closed',async()=>{
 for(const value of [{checks:[]},{checks:[verified.value.checks[0],verified.value.checks[0]]},
   {checks:[{id:'c1',status:'supported',evidence:['invented']}]},
   ...['partial','contradicted','unsupported'].map(status=>({checks:[{id:'c1',status,evidence:['s1p1']}]}))]){
   const out=await run({...deps,verify:async()=>({model:'checker',value})});
   assert.equal(out.status,'insufficient');assert.equal(out.claims.length,0);assert.equal(out.sources.length,0);
 }
 let checked=false;
 const out=await run({write:async()=>({model:'writer',value:{claims:[{text:'Unfounded',evidence:['unknown']}]}}),verify:async()=>{checked=true;return verified;}});
 assert.equal(out.status,'insufficient');assert.equal(checked,false);
});

test('partial answers omit unsupported claims and expose only supporting passages',async()=>{
 const out=await run({...deps,write:async()=>({model:'writer',value:{claims:[...draft.value.claims,{text:'It works equally well at night.',evidence:['s1p1']}]}}),
 verify:async()=>({model:'checker',value:{checks:[...verified.value.checks,{id:'c2',status:'contradicted',evidence:[]}]}})});
 assert.equal(out.status,'ready');assert.equal(out.limited,true);assert.equal(out.claims.length,1);
 assert.ok(!JSON.stringify(out).includes('equally well'));
});

test('no evidence, unavailable models and a same-model checker never publish an unchecked answer',async()=>{
 let calls=0;
 assert.equal((await generateAnswer({} as any,testConfig,'q',[],{deps:{write:async()=>{calls++;return draft;}}})).status,'insufficient');
 assert.equal(calls,0);
 assert.equal((await run({...deps,verify:async()=>{throw new Error('down');}})).status,'unavailable');
 assert.equal((await run({...deps,verify:async()=>({...verified,model:'writer'})})).status,'unavailable');
});

test('cancellation and deadlines finish even if a model hangs; cancelled work never starts verification',async()=>{
 const control=new AbortController();let checked=false;
 const task=generateAnswer({} as any,testConfig,'solar',sources,{signal:control.signal,deps:{write:async()=>new Promise(()=>{}),verify:async()=>{checked=true;return verified;}}});
 control.abort();assert.equal((await task).status,'cancelled');assert.equal(checked,false);
 const out=await generateAnswer({} as any,{...testConfig,ANSWER_TIMEOUT_MS:15},'solar',sources,{deps:{write:async()=>new Promise(()=>{})}});
 assert.equal(out.status,'unavailable');
});

test('answer plans preserve dates and distinguish resource finding, comparisons and fresh facts',()=>{
 assert.equal(answerIntent('find the full match from 2010').intent,'resource_finding');
 assert.deepEqual(answerIntent('Compare 2025 vs 2026 versions currently'),{intent:'comparison',freshness:'current',years:['2025','2026']});
});

test('citation learning is separate from relevance and only rewards actually cited sources',async()=>{
 const learned:any[]=[];
 await generateAnswer({} as any,testConfig,'solar',sources,{field:'science',deps:{...deps,learn:async(field,rows)=>{learned.push({field,rows});}}});
 assert.deepEqual(learned,[{field:'answer_science',rows:[{url:row(1).url,relevance:9}]}]);
});

test('Web reviews expose results while checking citations, bind answers to the owner and support cancellation',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const token=startWebReview({} as any,testConfig,'solar',[row(1)],{owner:'owner-a',screener:undefined,refill:null,log:()=>{},
 pages:{check:async()=>page()},judge:{judge:async(_q,cs)=>({model:'judge',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:9,reason:'Relevant',momentKeys:[]}]))})},
 answerDeps:{...deps,verify:async()=>{await gate;return verified;}}})!;
 try{
   for(let i=0;i<100&&webReviewState(token,'owner-a')?.answer?.status!=='checking';i++)await new Promise(r=>setTimeout(r,5));
   const state=webReviewState(token,'owner-a')!;
   assert.equal(state.status,'complete');assert.equal(state.results.length,1);assert.equal(state.answer?.status,'checking');
   assert.equal(webReviewState(token,'owner-b'),null);assert.equal(webReviewState(token),null);
   assert.equal(cancelWebAnswer(token,'owner-b'),false);
   assert.ok(!JSON.stringify(webReviewSnapshot(state)).includes('fetched_at'),'unpublished evidence stays private');
   assert.equal(cancelWebAnswer(token,'owner-a'),true);assert.equal(state.answer?.status,'cancelled');
 }finally{release();}
});

test('page reading retains long evidence only when requested, without changing the ranking excerpt',async()=>{
 const text=passage.repeat(20);
 const transport=async(url:string)=>({url,contentType:'text/html',text:url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':`<html><title>Solar</title><body><p>${text}</p></body></html>`});
 const a=await new PageChecker(testConfig,transport,{evidence:true}).check(row(1).url);
 const b=await new PageChecker(testConfig,transport,{}).check(row(1).url);
 assert.ok(a.evidence!.text.length>800);assert.equal(a.text,b.text);assert.equal(b.evidence,undefined);
});

test('citation learning skips routed sites, so a routed site cannot keep itself routed',async()=>{
 const learned:any[]=[];
 await generateAnswer({} as any,testConfig,'solar',sources,{field:'science',routed:new Set([row(1).url]),deps:{...deps,learn:async(field,rows)=>{learned.push({field,rows});}}});
 assert.deepEqual(learned,[]);
});

test('function words do not pick passages, and PDFs carry no claimed publication date',()=>{
 const text='How does the thing go. '.repeat(150)+'Solar cost compare. '.repeat(100);
 const found=collectAnswerSources('how does the cost of solar compare',[row(1)],new Map([[row(1).url,{...page(),evidence:{...page().evidence!,text}}]]),8);
 assert.ok(found[0].passages.every(p=>p.text.includes('Solar cost')));
 const pdf=collectAnswerSources('solar',[{...row(1),published:'2020-01-01'}],new Map([[row(1).url,{...page(),pdf:{} as any,meta:{published:'2019-01-01'}}]]),8);
 assert.equal(pdf[0].published,null);
});

test('a slow answer frees its relevance review slot for other searches',async()=>{
 const gates:(()=>void)[]=[];
 const judge={judge:async(_q:string,cs:any[])=>({model:'judge',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:9,reason:'Relevant',momentKeys:[]}]))})};
 const base={screener:undefined,refill:null,log:()=>{},pages:{check:async()=>page()},judge};
 const slow={...base,answerDeps:{...deps,write:()=>new Promise<any>(r=>gates.push(()=>r(draft)))}};
 const tokens=Array.from({length:4},()=>startWebReview({} as any,testConfig,'solar',[row(1)],slow)!);
 try{
   for(let i=0;i<100&&gates.length<4;i++)await new Promise(r=>setTimeout(r,5));
   assert.equal(gates.length,4);
   const next=webReviewState(startWebReview({} as any,testConfig,'solar',[row(1)],{...base,answer:false})!)!;
   for(let i=0;i<100&&!next.results[0]?.judgement;i++)await new Promise(r=>setTimeout(r,5));
   assert.ok(!next.providers.some(p=>p.provider==='web_review'),'the fifth search is still reviewed');
   assert.equal(next.results[0].judgement?.relevance,9);
 }finally{gates.forEach(g=>g());for(const t of tokens)cancelWebAnswer(t,undefined as any);}
});
