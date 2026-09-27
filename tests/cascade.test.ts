import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cascadeReview, flagsFor, makeStrongJudge, type CascadeOptions} from '../src/cascade.js';
import {tierConfig} from '../src/tiers.js';
import type {Judge, JudgeCandidate, Verdict} from '../src/judge.js';
import type {JevRecord} from '../src/jev-judge.js';
import {testConfig} from './helpers.js';

const text='The authors ran both databases in production for two years under heavy writes.';
const cand=(key:string,page=true):JudgeCandidate=>({key,kind:'website',site:'s.example',url:`https://s.example/${key}`,title:`Page ${key}`,channel:null,official:false,
 duration:null,live:null,description:null,comments:[],moments:[],discussions:[],...(page?{page:{status:'checked',title:`Page ${key}`,description:null,text,libraries:[]}}:{})});
const v=(key:string,relevance:number,extra:Partial<Verdict>={}):Verdict=>({key,relevance,reason:`r${relevance}`,momentKeys:[],...extra});
const opts:CascadeOptions={border:[4,7],auditRate:0.1,confidence:0.8,random:()=>0.5,log:()=>{}};
const jev=(outcome:JevRecord['outcome'],requirements:JevRecord['requirements']={}):JevRecord=>({outcome,requirements});
const strongSeat=(scores:Record<string,number>,seen:JudgeCandidate[][]=[]):Judge=>({async judge(_q,cs,ctx){seen.push(cs);assert.ok(ctx!.criteria.some(c=>/flagged as uncertain/.test(c)));
 return {model:'strong',verdicts:new Map(cs.filter(c=>c.key in scores).map(c=>[c.key,v(c.key,scores[c.key])]))};}});

test('only borderline scores go to the Strong judge; clear ones stand',()=>{
 assert.deepEqual(flagsFor(cand('a'),v('a',5),undefined,0,opts),['borderline']);
 assert.deepEqual(flagsFor(cand('a'),v('a',7),undefined,0,opts),['borderline'],'a confident 7 is still re-checked');
 assert.deepEqual(flagsFor(cand('a'),v('a',2),undefined,0,opts),[]);
 assert.deepEqual(flagsFor(cand('a'),v('a',9),undefined,0,opts),[]);
});

test('Jev confidence routes work but is never evidence: rejections stand only on a mismatch snippet',()=>{
 assert.deepEqual(flagsFor(cand('a'),v('a',4),jev('rejected',{R1:{choice:'mismatch',confidence:0.9}}),1,opts),[]);
 assert.deepEqual(flagsFor(cand('a'),v('a',4),jev('rejected',{R1:{choice:'unknown',confidence:0.95}}),1,opts),['jev_reject_unbacked']);
});

test('settled verdicts are audited at the configured rate only',()=>{
 assert.deepEqual(flagsFor(cand('a'),v('a',8),jev('settled'),1,{...opts,random:()=>0.05}),['settle_audit']);
 assert.deepEqual(flagsFor(cand('a'),v('a',8),jev('settled'),1,{...opts,random:()=>0.5}),[]);
});

test('a Scorer verdict against snippet-backed evidence, or confident without a grounded quote, is flagged',()=>{
 assert.ok(flagsFor(cand('a'),v('a',9),jev('forwarded',{R1:{choice:'mismatch',confidence:0.9}}),1,opts).includes('conflicts_with_evidence'));
 assert.ok(flagsFor(cand('a'),v('a',2),jev('would_settle',{R1:{choice:'s1',confidence:0.9}}),1,opts).includes('conflicts_with_evidence'));
 assert.deepEqual(flagsFor(cand('a'),v('a',9,{requirementChecks:[{id:'R1',status:'supported',field:'page',quote:'not on the page'}]}),undefined,1,opts),['unbacked']);
 assert.deepEqual(flagsFor(cand('a'),v('a',9,{requirementChecks:[{id:'R1',status:'supported',field:'page',quote:'ran both databases in production'}]}),undefined,1,opts),[]);
 assert.deepEqual(flagsFor(cand('a',false),v('a',9),undefined,1,opts),[],'nothing was read, so a missing quote is not suspicious');
});

test('the Strong judge sees only flagged candidates and its verdict is final; a failed batch keeps the first score',async()=>{
 const candidates=['a','b','c'].map(k=>cand(k)), seen:JudgeCandidate[][]=[];
 const scored=new Map([['a',v('a',9)],['b',v('b',6)],['c',v('c',2)]]);
 const out=await cascadeReview('q',candidates,scored,undefined,{kind:'websites',criteria:[]},undefined,strongSeat({b:3},seen),opts);
 assert.deepEqual(seen.flat().map(c=>c.key),['b']);
 assert.equal(out.verdicts.get('b')!.relevance,3);
 assert.equal(out.verdicts.get('a')!.relevance,9);
 assert.deepEqual(out.records.get('b'),{scorer:6,strong:3,flags:['borderline']});
 const failing:Judge={async judge(){throw new Error('down');}};
 const kept=await cascadeReview('q',candidates,scored,undefined,undefined,undefined,failing,opts);
 assert.equal(kept.verdicts.get('b')!.relevance,6);
 assert.equal(kept.providers[0]!.status,'partial');
});

test('one log line per review with counts and reasons, never the query',async()=>{
 const lines:Record<string,unknown>[]=[];
 await cascadeReview('secret query',[cand('a')],new Map([['a',v('a',5)]]),undefined,undefined,undefined,strongSeat({a:6}),{...opts,log:l=>lines.push(l)});
 assert.equal(lines.length,1);
 assert.equal(lines[0]!.event,'cascade');
 assert.deepEqual(lines[0]!.reasons,{borderline:1});
 assert.ok(!JSON.stringify(lines).includes('secret'));
});

test('Strong judge models: SSJ3 terra first; SSJ1 gemini-3.5-flash-lite first; never the Scorer main model; off for the council',()=>{
 const config={...testConfig,OPENROUTER_API_KEY:'k',JUDGE_MODELS:'google/gemini-3.5-flash-lite'};
 assert.deepEqual((makeStrongJudge({} as any,config) as any).client.models,['openai/gpt-5.6-terra','mistralai/mistral-medium-3.1','openai/gpt-5.4-mini']);
 const ssj1=tierConfig(config,'ssj1');
 assert.equal((makeStrongJudge({} as any,ssj1) as any).client.models[0],'google/gemini-3.5-flash-lite');
 assert.ok(!(makeStrongJudge({} as any,{...config,CASCADE_STRONG_MODELS:'google/gemini-3.5-flash-lite,openai/gpt-5.6-terra'}) as any).client.models.includes('google/gemini-3.5-flash-lite'));
 assert.equal(makeStrongJudge({} as any,{...config,JUDGE_ARCHITECTURE:'council'}),undefined);
});
