import {test} from 'node:test';
import assert from 'node:assert/strict';
import {councilReview, makeCouncil, disputed} from '../src/council.js';
import type {Judge, JudgeCandidate, JudgeContext, Verdict} from '../src/judge.js';
import {testConfig} from './helpers.js';

const cand=(key:string):JudgeCandidate=>({key,kind:'video',site:'youtube.com',url:`https://youtube.com/watch?v=${key}`,title:`Video ${key}`,
 channel:null,official:false,duration:null,live:null,description:null,comments:[],moments:[],discussions:[]});
const v=(key:string,relevance:number,extra:Partial<Verdict>={}):Verdict=>({key,relevance,reason:`r${relevance}`,momentKeys:[],...extra});
const seat=(scores:Record<string,number>,seen:JudgeCandidate[][]=[],model='seat'):Judge=>({async judge(_q,cs){seen.push(cs);
 return {model,verdicts:new Map(cs.filter(c=>c.key in scores).map(c=>[c.key,v(c.key,scores[c.key],{reason:`${model} says ${scores[c.key]}`})]))};}});
const quiet={log:()=>{}};

test('the checker sees only the top candidates the scorer rated 3 or more, never the scorer verdicts',async()=>{
 const candidates=['a','b','c','d'].map(cand);
 const scorer=new Map([['a',v('a',9)],['b',v('b',7)],['c',v('c',2)],['d',v('d',8)]]);
 const seen:JudgeCandidate[][]=[];
 await councilReview('q',candidates,scorer,undefined,undefined,{checker:seat({a:9,b:7,d:8},seen)},{top:2,...quiet});
 assert.deepEqual(seen[0].map(c=>c.key),['a','d'],'the two highest, in score order');
 assert.ok(seen[0].every(c=>!('council' in c)),'the second opinion is independent');
});

test('agreement keeps the scorer verdict at the mean score; a dispute goes to the chair, who sees both verdicts',async()=>{
 const candidates=['a','b'].map(cand);
 const scorer=new Map([['a',v('a',9)],['b',v('b',8)]]);
 const chairSaw:JudgeCandidate[][]=[];
 const out=await councilReview('q',candidates,scorer,undefined,undefined,
  {checker:seat({a:8,b:4},[],'checker'),chair:seat({b:5},chairSaw,'chair')},{top:15,...quiet});
 assert.equal(out.verdicts.get('a')!.relevance,8,'floor of (9+8)/2');
 assert.equal(out.verdicts.get('a')!.reason,'r9');
 assert.deepEqual(chairSaw[0].map(c=>c.key),['b']);
 assert.deepEqual((chairSaw[0][0] as any).council,{first:{relevance:8,reason:'r8'},second:{relevance:4,reason:'checker says 4'}});
 assert.equal(out.verdicts.get('b')!.relevance,5);
 assert.deepEqual(out.records.get('b'),{scorer:8,checker:4,chair:5,disputed:true});
});

test('disputes include an intent mismatch or a requirement conflict even when the scores are close',()=>{
 const mismatch={dimension:'subject' as const,status:'mismatch' as const,field:'title' as const,quote:''};
 assert.ok(disputed(v('a',6),v('a',5,{intentChecks:[mismatch]}),2));
 const req=(status:'supported'|'mismatch')=>({requirementChecks:[{id:'R1',status,field:'title',quote:'x'}]});
 assert.ok(disputed(v('a',7,req('supported')),v('a',7,req('mismatch')),2));
 assert.ok(!disputed(v('a',7,req('supported')),v('a',6,req('supported')),2));
});

test('without a chair, a dispute keeps the more cautious score; without a checker, the scorer stands and says so',async()=>{
 const candidates=['a'].map(cand);
 const scorer=new Map([['a',v('a',9)]]);
 const failing:Judge={async judge(){throw new Error('down');}};
 const cautious=await councilReview('q',candidates,scorer,undefined,undefined,{checker:seat({a:3}),chair:failing},{top:15,...quiet});
 assert.equal(cautious.verdicts.get('a')!.relevance,3);
 assert.match(cautious.verdicts.get('a')!.reason,/more cautious/);
 const alone=await councilReview('q',candidates,scorer,undefined,undefined,{checker:failing},{top:15,...quiet});
 assert.equal(alone.verdicts.get('a')!.relevance,9);
 assert.equal(alone.providers[0].provider,'council');
 assert.equal(alone.providers[0].status,'partial');
});

test('the chair is told what it is doing through the criteria; one log line per run, never the query',async()=>{
 const lines:any[]=[];const contexts:(JudgeContext|undefined)[]=[];
 const chair:Judge={async judge(_q,cs,ctx){contexts.push(ctx);return {model:'chair',verdicts:new Map(cs.map(c=>[c.key,v(c.key,6)]))};}};
 await councilReview('secret',[cand('a'),cand('b')],new Map([['a',v('a',9)],['b',v('b',8)]]),{kind:'videos',criteria:['c1']},undefined,
  {checker:seat({a:9,b:2},[],'luna'),chair},{top:15,log:l=>lines.push(l)});
 assert.ok(contexts[0]!.criteria.some(c=>/two judges/i.test(c)));
 assert.ok(contexts[0]!.criteria.includes('c1'));
 const [{checker_ms,chair_ms,...rest}]=lines;
 assert.deepEqual(rest,{event:'council',checked:2,disputed:1,chaired:1,agreement:0.5,checker:'luna',chair:'chair'});
 assert.ok(Number.isInteger(checker_ms)&&Number.isInteger(chair_ms),'each step is timed');
});

test('seats come from settings; the checker never reuses a scorer model',()=>{
 const config={...testConfig,OPENROUTER_API_KEY:'k',JUDGE_MODELS:'google/gemini-3.8-flash,openai/gpt-5.6-luna',
  COUNCIL_CHECKER_MODELS:'openai/gpt-5.6-luna,qwen/qwen3.7-plus',COUNCIL_CHAIR_MODELS:'anthropic/claude-sonnet-5'};
 const seats=makeCouncil({} as any,config)!;
 assert.deepEqual((seats.checker as any).client.models,['qwen/qwen3.7-plus']);
 assert.deepEqual((seats.chair as any).client.models,['anthropic/claude-sonnet-5']);
 assert.equal((seats.checker as any).client.config.JUDGE_TIMEOUT_MS,config.COUNCIL_CHECKER_TIMEOUT_MS,'the checker gets its own time limit');
 assert.equal((seats.chair as any).client.config.JUDGE_TIMEOUT_MS,config.COUNCIL_CHAIR_TIMEOUT_MS);
 assert.deepEqual([testConfig.COUNCIL_CHECKER_MODELS,testConfig.COUNCIL_CHECKER_TIMEOUT_MS,testConfig.COUNCIL_CHAIR_TIMEOUT_MS],
  ['openai/gpt-5.6-luna,openai/gpt-5.4-mini,qwen/qwen3.7-plus',35000,45000],'defaults chosen by the 2026-09-26 seat benchmark');
 assert.equal(makeCouncil({} as any,{...config,COUNCIL_ENABLED:false}),null);
 assert.equal(makeCouncil({} as any,{...config,OPENROUTER_API_KEY:''}),null);
});

test('video searches pass their scored candidates through the council: a disputed top result is settled by the chair',async()=>{
 const {database,fixture}=await import('./helpers.js');
 const {applySignals}=await import('../src/signals.js');
 const db=await database();
 try {
  const item=await fixture(db,'Attack on Titan opening 1 fan upload');
  const scorer:Judge={async judge(_q,cs){return {model:'scorer',verdicts:new Map(cs.map(c=>[c.key,v(c.key,9)]))};}};
  const out=await applySignals(db,testConfig,'attack on titan opening 1',[item],
   {judge:scorer,council:{checker:seat({},[],'checker'),chair:seat({},[],'chair')}} as any);
  assert.equal(out.results.length,1,'no checker verdict for this key: the scorer verdict stands');
  const disputedOut=await applySignals(db,testConfig,'attack on titan opening 1',[item],
   {judge:scorer,council:{checker:{async judge(_q:string,cs:JudgeCandidate[]){return {model:'checker',verdicts:new Map(cs.map((c:JudgeCandidate)=>[c.key,v(c.key,3)]))};}},
    chair:{async judge(_q:string,cs:JudgeCandidate[]){return {model:'chair',verdicts:new Map(cs.map((c:JudgeCandidate)=>[c.key,v(c.key,4,{reason:'Fan re-upload, not the official opening.'})]))};}}}} as any);
  assert.equal(disputedOut.results.length,0,'the chair scored it 4: tangential, removed');
 } finally {await db.close();}
});

test('Docs and Web reviews pass their judged items through the council too',async()=>{
 const {reviewResults}=await import('../src/review.js');
 const item=(n:number)=>({url:`https://s${n}.example/p`,title:`Page ${n}`,source_name:`s${n}.example`,snippet:null,published:null,engine:'brave',doc_type:null});
 const scorer=seat({'d1':9,'d2':8});
 const judge:Judge={async judge(_q,cs){return {model:'scorer',verdicts:new Map(cs.map(c=>[c.key,v(c.key,c.title==='Page 1'?9:8)]))};}};
 const out=await reviewResults('q',[item(1),item(2)],{noun:'pages',criteria:[],requirement:{text:'R',evidence:'E'},textPool:40,reviewPool:40,
  read:async()=>new Map(),judge,keepUnjudged:true,council:{checker:seat({d1:2,d2:8},[],'checker'),chair:seat({d1:3},[],'chair')},councilTop:15,log:()=>{}} as any);
 assert.deepEqual(out.results.map(r=>[r.title,r.judgement?.relevance]),[['Page 2',8]],'page 1 was disputed and the chair rejected it');
 void scorer;
});

test('the checker and the chair judge in small parallel batches, so one long call cannot time out the whole council',async()=>{
 const keys=Array.from({length:12},(_,i)=>`k${i}`);
 const candidates=keys.map(cand);
 const scorer=new Map(keys.map(k=>[k,v(k,9)]));
 const checkerBatches:number[]=[],chairBatches:number[]=[];
 const checker:Judge={async judge(_q,cs){checkerBatches.push(cs.length);return {model:'checker',verdicts:new Map(cs.map(c=>[c.key,v(c.key,2)]))};}};
 const chair:Judge={async judge(_q,cs){chairBatches.push(cs.length);return {model:'chair',verdicts:new Map(cs.map(c=>[c.key,v(c.key,7)]))};}};
 const out=await councilReview('q',candidates,scorer,undefined,undefined,{checker,chair},{top:12,...quiet});
 assert.deepEqual(checkerBatches.sort(),[2,5,5]);
 assert.deepEqual(chairBatches.sort(),[3,3,3,3]);
 assert.ok(keys.every(k=>out.verdicts.get(k)!.relevance===7));
 const oneFails:Judge={async judge(_q,cs){if(cs.some(c=>c.key==='k0'))throw new Error('timeout');return {model:'checker',verdicts:new Map(cs.map(c=>[c.key,v(c.key,9)]))};}};
 const partial=await councilReview('q',candidates,scorer,undefined,undefined,{checker:oneFails},{top:12,...quiet});
 assert.equal(partial.records.size,7,'a failed batch only leaves its own candidates with one opinion');
});
