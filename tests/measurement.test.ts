import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCosts,scoreAnswers,type AnswerEvalRow} from '../src/evaluation.js';
import {traceMetrics,type SearchTrace,type TraceEntry} from '../src/learning.js';
import {traceOf} from '../src/discovery.js';
import {searchInput,type Result} from '../src/types.js';

test('cost attribution excludes other searches and preserves missing prices',()=>{
 const lines=[{event:'model_cost',trace_id:'a',bucket:'writer',cost:0.03},
   {event:'model_cost',trace_id:'b',bucket:'writer',cost:10},
   {event:'model_cost',trace_id:'a',bucket:'verifier',cost:null}];
 assert.deepEqual(summarizeCosts(lines,'a'),{cost_usd:null,reported_cost_usd:0.03,by_role:{writer:0.03,verifier:null},calls:2,unpriced_calls:1,scope:'trace'});
 assert.equal(summarizeCosts(lines).cost_usd,null);
 assert.equal(summarizeCosts([],'a').cost_usd,null);
 assert.equal(summarizeCosts([{...lines[0],cost:0}],'a').cost_usd,0);
});

test('failed requests stay in answer denominators; incomplete grades never claim full accuracy',()=>{
 const base:AnswerEvalRow={id:'a',kind:'factual',answer_ms:100,cost_usd:null,answer_cost_usd:null,proposed:2,
   answer:{status:'ready',claims:[{text:'one'},{text:'two'}]}};
 const rows=[base,{...base,id:'b',answer:null,error:'HTTP 500'}, {...base,id:'c',kind:'skip',answer:null,error:'timeout'}];
 const scores=scoreAnswers(rows,{a:{claims:{one:2},useful:2}});
 assert.equal(scores.answered,'1/2');assert.equal(scores.skipped_ok,'0/1');assert.equal(scores.errors,2);
 assert.equal(scores.claim_grade,null);assert.equal(scores.wrong,null);assert.equal(scores.ungraded,1);assert.equal(scores.search_usd,null);
 assert.equal(scoreAnswers(rows,{a:{claims:{one:2,two:0},useful:2}}).wrong,0.5);
});

const entry=(url:string,over:Partial<TraceEntry>={}):TraceEntry=>({url,title:url,site:'example.org',round:0,relevance:8,reason:null,basis:null,shown:true,rank:1,badges:[],...over});
const trace=(pool:TraceEntry[]):SearchTrace=>({query:'test',depth:'quick',plan:{kind:'videos',criteria:[],model:null},searches:[],rounds:0,providers:[],pool});
test('shown results owe each requirement; unknown exclusions, absent evidence and provisional support receive no credit',()=>{
 const t=trace([entry('one',{decision:{status:'verified',contradicted:[],unconfirmed:[],requirements:[
   {id:'R1',status:'supported',excerpt:'evidence',method:'judge'},{id:'R2',status:'unknown',excerpt:null,method:null}]}}),
   entry('two',{findings:[{requirement_id:'R1',status:'supported',method:'search_snippet',access:'ok',provisional:true,excerpt:'title'}]})]);
 t.contract={requirements:[{id:'R1',hardness:'hard',scope:'each'},{id:'R2',hardness:'hard',scope:'each'}]} as any;
 const m=traceMetrics(t);assert.equal(m.requirement_satisfaction,0.25);assert.equal(m.unknown_rate,0.75);
 assert.equal(m.verified,1);assert.equal(m.high_scoring,2);
 assert.equal(traceMetrics({...t,pool:[]}).requirement_satisfaction,0);
});

test('trace construction keeps main and closest ranks separate and includes earlier displayed results',()=>{
 const result=(id:string)=>({id,canonical_url:`https://example.org/${id}`,title:id,badges:[]}) as unknown as Result;
 const main=result('main'),closest=result('closest'),hidden=result('hidden');
 const t=traceOf(searchInput.parse({q:'test'}),{kind:'videos',criteria:[],model:null,searches:[]},[],0,[],[],[closest,hidden],new Map(),
   [{id:closest.id,relevance:5},{id:hidden.id,relevance:2}] as any,[main],new Map(),[closest]);
 assert.equal(t.pool.find(p=>p.url===main.canonical_url)?.placement,'main');
 assert.equal(t.pool.find(p=>p.url===closest.canonical_url)?.closest_rank,1);
 const m=traceMetrics(t);assert.equal(m.shown,1);assert.equal(m.closest,1);assert.equal(m.rejected,1);assert.equal(m.available,2);
});
