import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanDecision,mergeReviewed,makeRefillPlanner} from '../src/refill.js';
import {reviewWeb} from '../src/web-review.js';
import type {Judge} from '../src/judge.js';
import type {WebResult} from '../src/web.js';
import {testConfig} from './helpers.js';

const page=(url:string,title=url):WebResult=>({id:url,url,title,source_name:new URL(url).hostname,snippet:null,published:null,doc_type:null,access:null,engine:'brave',preview:null});
const judge:Judge={async judge(_q,cs){return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:c.url!.includes('usda.gov')?9:c.url!.includes('spam')?2:7,reason:'r',momentKeys:[]}]))};}};
const base={judge,pages:{check:async()=>({status:'unavailable' as const,title:null,description:null,text:null,libraries:[],badges:[]})},screener:undefined,council:null,strong:null,log:()=>{}};

test('planner decisions are cleaned: at most the allowed searches, no repeats of what already ran, no empty ones',()=>{
 const d=cleanDecision({complete:false,missing:'a food-safety authority',searches:['site:fsis.usda.gov cooked rice fridge','cooked rice fridge','',' x '.repeat(100),'site:foodsafety.gov rice']},['cooked rice fridge'],2);
 assert.deepEqual(d.searches,['site:fsis.usda.gov cooked rice fridge','site:foodsafety.gov rice']);
 assert.deepEqual(cleanDecision({complete:true,missing:'',searches:['q']},[],2).searches,[],'a complete list asks for nothing');
 assert.equal(cleanDecision('nonsense',[],2).searches.length,0);
});

test('the Web review asks the planner once, searches only for what is missing, and merges new pages without repeats',async()=>{
 const asked:{kept:string[]}[]=[], searched:string[][]=[];
 const out=await reviewWeb({} as any,testConfig,'how long can cooked rice be kept',[page('https://recipes.example/rice'),page('https://spam.example/x')],{...base,
  refill:async(_q,kept)=>{asked.push({kept:kept.map(k=>k.host)});return {complete:false,missing:'a food-safety authority',searches:['site:fsis.usda.gov cooked rice']};},
  fetch:async s=>{searched.push(s);return [page('https://recipes.example/rice'),page('https://www.fsis.usda.gov/leftovers')];}});
 assert.equal(asked.length,1);
 assert.deepEqual(asked[0]!.kept,['recipes.example'],'the planner sees what was kept, never removed pages');
 assert.deepEqual(searched,[['site:fsis.usda.gov cooked rice']]);
 assert.deepEqual(out.results.map(r=>r.url),['https://www.fsis.usda.gov/leftovers','https://recipes.example/rice'],'new page judged, merged and ranked; no duplicate');
 assert.ok(out.providers.some(p=>p.provider==='refill'&&/food-safety authority/.test(p.message)));
});

test('a complete list, a failing planner or no planner leaves the review as it was',async()=>{
 for(const refill of [async()=>({complete:true,missing:'',searches:[]}),async()=>{throw new Error('down');},null]){
  let fetched=0;
  const out=await reviewWeb({} as any,testConfig,'q',[page('https://recipes.example/rice')],{...base,refill:refill as any,fetch:async()=>{fetched++;return [];}});
  assert.equal(fetched,0);
  assert.deepEqual(out.results.map(r=>r.url),['https://recipes.example/rice']);
 }
});

test('merging keeps judged results ranked (canonical boost included) and unjudged ones after',()=>{
 const a={...page('https://a.example/1'),judgement:{relevance:8,reason:''}}, b={...page('https://b.gov/2'),judgement:{relevance:7,reason:''}}, u=page('https://u.example/3');
 assert.deepEqual(mergeReviewed('q',[a,u],[b]).map(r=>r.url),['https://b.gov/2','https://a.example/1','https://u.example/3']);
});

test('the refill planner uses the planner models and is off without them',()=>{
 assert.equal(makeRefillPlanner({} as any,{...testConfig,OPENROUTER_API_KEY:'k',PLANNER_MODELS:''}),undefined);
 assert.ok(makeRefillPlanner({} as any,{...testConfig,OPENROUTER_API_KEY:'k',PLANNER_MODELS:'google/gemma-4-31b-it'}));
 assert.equal(makeRefillPlanner({} as any,{...testConfig,OPENROUTER_API_KEY:'k',PLANNER_MODELS:'google/gemma-4-31b-it',REFILL_ENABLED:false}),undefined);
});
