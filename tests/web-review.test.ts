import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {reviewWeb, startWebReview, webReviewState, webReviewMetrics} from '../src/web-review.js';
import type {Judge, JudgeCandidate, JudgeContext} from '../src/judge.js';
import type {WebResult} from '../src/web.js';

const db={} as any;
const result=(n:number):WebResult=>({id:`id${n}`,title:`Page ${n}`,url:`https://s${n}.example/p`,source_name:`s${n}.example`,snippet:`About ${n}`,
 published:null,doc_type:null,access:null,engine:'brave',preview:null});
const scoring=(scores:Record<string,number>,calls:{candidates:JudgeCandidate[];context?:JudgeContext}[]=[]):Judge=>({async judge(_q,candidates,context){
 calls.push({candidates,context});
 return {model:'f',verdicts:new Map(candidates.map(c=>[c.key,{key:c.key,relevance:scores[c.title]??0,reason:`r ${c.title}`,momentKeys:[]}])),
   jev:new Map(candidates.map(c=>[c.key,{outcome:c.title==='Page 2'?'would_settle':'forwarded'}]))};}});
const page={status:'checked' as const,title:'T',description:null,text:'Full page text',libraries:[],badges:[]};
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));};

test('every page is read and judged with the web criteria; the metrics line carries counts, never the query',async()=>{
 const calls:any[]=[],read:string[]=[],lines:any[]=[];
 const out=await reviewWeb(db,testConfig,'secret query',[result(1),result(2),result(3)],{judge:scoring({'Page 1':3,'Page 2':8,'Page 3':6},calls),screener:undefined,
   pages:{check:async url=>{read.push(url);return page;}},log:l=>lines.push(l)});
 assert.equal(read.length,3);
 assert.deepEqual(out.results.map(r=>r.title),['Page 2','Page 3']);
 assert.equal(calls[0].candidates[0].page.text,'Full page text');
 assert.ok(calls[0].context.criteria.some((c:string)=>/accurate/.test(c)));
 assert.match(calls[0].context.requirements[0].text,/secret query/);
 assert.deepEqual(lines,[{event:'web_review',judged:3,jev_rejected:0,jev_would_settle:1,settle_agreement:1}]);
});

test('a page that cannot be read in time is judged on its title and snippet',async()=>{
 const calls:any[]=[];
 const started=Date.now();
 await reviewWeb(db,{...testConfig,WEB_REVIEW_READ_MS:50},'q',[result(1)],{judge:scoring({'Page 1':7},calls),screener:undefined,log:()=>{},
   pages:{check:()=>new Promise(()=>{})}});
 assert.ok(Date.now()-started<1000);
 assert.equal(calls[0].candidates[0].page,undefined);
});

test('metrics: agreement is the share of would-settle pages the LLM judge scored 7 or more',()=>{
 assert.deepEqual(webReviewMetrics([{url:'a',relevance:8,jev:{outcome:'would_settle'}},{url:'b',relevance:5,jev:{outcome:'would_settle'}},
   {url:'c',relevance:2,jev:{outcome:'rejected'}},{url:'d',relevance:null}]),{judged:4,jev_rejected:1,jev_would_settle:2,settle_agreement:0.5});
 assert.equal(webReviewMetrics([]).settle_agreement,null);
});

test('reviews run in the background by token; nothing starts when disabled, without a judge, or with no results',async()=>{
 const judge=scoring({'Page 1':9});
 const deps={judge,screener:undefined,pages:{check:async()=>page},log:()=>{}};
 const token=startWebReview(db,testConfig,'q',[result(1)],deps)!;
 assert.equal(webReviewState(token)!.status,'running');
 await until(()=>webReviewState(token)!.status==='complete');
 assert.deepEqual(webReviewState(token)!.results.map(r=>r.judgement?.relevance),[9]);
 assert.equal(startWebReview(db,{...testConfig,WEB_REVIEW_ENABLED:false},'q',[result(1)],deps),null);
 assert.equal(startWebReview(db,testConfig,'q',[],deps),null);
 assert.equal(startWebReview(db,testConfig,'q',[result(1)],{...deps,judge:undefined}),null);
 assert.equal(webReviewState('00000000-0000-4000-8000-000000000000'),null);
});

// Leaves four reviews hanging: keep it last.
test('at most four reviews run at once; a fifth completes at once with the search results',async()=>{
 const hang:Judge={judge:()=>new Promise(()=>{})};
 const deps={judge:hang,screener:undefined,pages:{check:async()=>page},log:()=>{}};
 for(let i=0;i<4;i++)startWebReview(db,testConfig,'q',[result(1)],deps);
 const busy=webReviewState(startWebReview(db,testConfig,'q',[result(1)],deps)!)!;
 assert.equal(busy.status,'complete');
 assert.deepEqual(busy.results.map(r=>r.title),['Page 1']);
 assert.equal(busy.providers[0].status,'unavailable');
});
