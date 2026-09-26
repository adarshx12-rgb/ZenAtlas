import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewResults, type Reviewable} from '../src/review.js';
import type {Judge, JudgeCandidate, JudgeContext, Verdict} from '../src/judge.js';

const item=(n:number):Reviewable=>({url:`https://s${n}.example/p`,title:`Page ${n}`,source_name:`s${n}.example`,snippet:`About ${n}`,published:null,engine:'brave',doc_type:null});
const judgeOf=(scores:Record<string,number|undefined>,calls:{candidates:JudgeCandidate[];context?:JudgeContext}[]=[]):Judge=>({async judge(_q,candidates,context){
 calls.push({candidates,context});
 return {model:'fake',verdicts:new Map(candidates.flatMap(c=>scores[c.title]===undefined?[]:[[c.key,{key:c.key,relevance:scores[c.title]!,reason:`r ${c.title}`,momentKeys:[]} as Verdict]]))};}});
const plan=(judge:Judge,extra={})=>({noun:'pages',criteria:['c'],requirement:{text:'R',evidence:'E'},textPool:40,reviewPool:40,
 read:async()=>new Map(),judge,keepUnjudged:true,...extra});

test('rejects 4 and below, ranks the rest, and keeps unjudged items after them when asked',async()=>{
 const calls:any[]=[];
 const out=await reviewResults('q',[item(1),item(2),item(3),item(4)],plan(judgeOf({'Page 1':4,'Page 2':6,'Page 3':9},calls)));
 assert.deepEqual(out.results.map(r=>[r.title,r.judgement?.relevance]),[['Page 3',9],['Page 2',6],['Page 4',undefined]]);
 assert.equal(out.removed,1);
 assert.match(out.providers.at(-1)!.message,/4 pages were checked for relevance; 1 did not match; 1 could not be checked/);
 assert.deepEqual(calls[0].context.requirements,[{id:'R1',text:'R',evidence:'E'}]);
 assert.deepEqual(out.trace.map(t=>t.relevance),[4,6,9,null]);
});

test('without keepUnjudged an unscored item is removed; a mismatch is removed whatever its score',async()=>{
 const judge:Judge={async judge(_q,cs){return {model:'f',verdicts:new Map([[cs[0].key,{key:cs[0].key,relevance:8,reason:'x',momentKeys:[],
   intentChecks:[{dimension:'subject' as const,status:'mismatch' as const,field:'title' as const,quote:'x'}]}]])};}};
 const out=await reviewResults('q',[item(1),item(2)],plan(judge,{keepUnjudged:false}));
 assert.deepEqual(out.results,[]);assert.equal(out.removed,2);
});

test('a failing judge returns the items in search order and says so; read text reaches the judge',async()=>{
 const failing:Judge={async judge(){throw new Error('down');}};
 const out=await reviewResults('q',[item(1),item(2)],plan(failing));
 assert.deepEqual(out.results.map(r=>r.title),['Page 1','Page 2']);
 assert.match(out.providers[0].message,/pages are shown in search order/);
 const calls:any[]=[];
 await reviewResults('q',[item(1)],plan(judgeOf({'Page 1':7},calls),{read:async(xs:Reviewable[])=>new Map(xs.map(x=>[x.url,{status:'checked' as const,title:'T',description:null,text:'Body',libraries:[],badges:[]}]))}));
 assert.equal(calls[0].candidates[0].page.text,'Body');
});

test('the screener orders the list only when it is longer than the text pool',async()=>{
 const screened:number[]=[];
 const screener={screen:async(_q:string,leads:any[])=>{screened.push(leads.length);return {screened:leads.length,promising:new Set([item(3).url])};}};
 const calls:any[]=[];
 await reviewResults('q',[item(1),item(2),item(3)],plan(judgeOf({},calls),{screener,textPool:2}));
 assert.deepEqual(screened,[3]);assert.equal(calls[0].candidates[0].title,'Page 3');
 await reviewResults('q',[item(1),item(2)],plan(judgeOf({}),{screener,textPool:2}));
 assert.deepEqual(screened,[3]);
});

test('an item whose text could not be read is marked as a lead, whatever its score',async()=>{
 const read=async(xs:Reviewable[])=>new Map(xs.filter(x=>x.title==='Page 1').map(x=>[x.url,{status:'checked' as const,title:'T',description:null,text:'Body',libraries:[],badges:[]}]));
 const out=await reviewResults('q',[item(1),item(2)],plan(judgeOf({'Page 1':8,'Page 2':7}),{read}));
 assert.deepEqual(out.results.map(r=>[r.title,r.lead??false]),[['Page 1',false],['Page 2',true]]);
});
