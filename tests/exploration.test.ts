import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JevExplorer,makeExplorer,exploreSources,explorationPicks,type ExplorationCandidate,type ExplorationDecision,type Explorer} from '../src/exploration.js';
import type {DB} from '../src/db.js';
import type {fetchJSON} from '../src/http.js';
import {UpstreamError} from '../src/http.js';
import type {PageEvidence} from '../src/pages.js';
import {testConfig} from './helpers.js';

const config={...testConfig,OPENROUTER_API_KEY:'test-key'};
const db:DB={async query<T>(){return {rows:[{used:1}] as T[]};},async transaction(fn){return fn(db);},async close(){}};
const candidate=(url:string):ExplorationCandidate=>({url,title:'Moon launch archive',description:'Original recordings and references',published_at:'2024-05-09T00:00:00Z',from_url:null});
const decision=(url:string,choice:ExplorationDecision['choice']='useful'):ExplorationDecision=>({url,model:'test',choice,confidence:0.95,
 probabilities:{useful:choice==='useful'?0.98:0.01,uncertain:choice==='uncertain'?0.98:0.01,irrelevant:choice==='irrelevant'?0.98:0.01}});
const checked=(links:{url:string;title:string}[]=[]):PageEvidence=>({status:'checked',title:'Moon launch original footage',description:'An original moon launch recording.',text:'Source references',libraries:[],badges:[],links});
const useful:Explorer={async assess(_q,candidates){return {decisions:candidates.map(c=>decision(c.url)),failed_batches:0};}};

test('exploration uses native OpenRouter decisions with source, date and link context',async()=>{
 const c={...candidate('https://archive.example.org/collection'),from_url:'https://publisher.example.org/references',context:'Original publisher archive'};
 const transport:typeof fetchJSON=async(url,options)=>{
   assert.equal(url,'https://openrouter.ai/api/alpha/decisions');assert.equal(options?.token,'test-key');
   const body=options!.body as any;
   assert.equal(body.state.candidates.c0.url,c.url);assert.equal(body.state.candidates.c0.linked_from,c.from_url);
   assert.equal(body.state.candidates.c0.published_at,c.published_at);assert.equal(body.state.current_date,new Date().toISOString().slice(0,10));
   assert.match(body.questions.c0.instructions,/state\.candidates\.c0/);
   return {model:'typesafe/jev-1.13',answers:{c0:{type:'choice',...decision(c.url)}}};
 };
 const result=await new JevExplorer(db,config,transport).assess('moon launch',[c]);
 assert.equal(result.decisions[0].choice,'useful');assert.equal(result.failed_batches,0);
 assert.equal(makeExplorer(db,testConfig),undefined);
 assert.equal(makeExplorer(db,{...config,JEV_EXPLORATION_ENABLED:false}),undefined);
});

test('selection preserves an uncertain slot and favors diverse domains without selecting confident irrelevance',()=>{
 const cs=['https://a.example.org/1','https://a.example.org/2','https://b.example.org/1','https://c.example.org/1','https://d.example.org/1'].map(candidate);
 const ds=cs.map((c,i)=>decision(c.url,i===3?'uncertain':i===4?'irrelevant':'useful'));
 assert.deepEqual(explorationPicks(cs,ds,3,0.65,new Set()).map(c=>c.url),[cs[0].url,cs[2].url,cs[3].url]);
});

test('two bounded rounds follow real outbound references, reject unsafe destinations and stop at robots denial',async()=>{
 const root=candidate('https://source.example.org/index');const calls:string[]=[];
 const check=async(url:string)=>{
   calls.push(url);
   if(url===root.url)return checked([
     {url:'https://original.example.org/footage',title:'Original launch recording'},
     {url:'https://blocked.example.org/page',title:'Historical archive'},
     {url:'http://127.0.0.1/private',title:'Private'},
     {url:'https://source.example.org/index#again',title:'Cycle'},
     {url:'https://source.example.org/login',title:'Login'},
   ]);
   if(url.includes('blocked.'))return {...checked([{url:'https://never.example.org/page',title:'Never follow'}]),status:'robots_disallowed' as const};
   return checked([{url:root.url,title:'Cycle'}]);
 };
 const out=await exploreSources('moon launch',[root],useful,check,config,4);
 assert.deepEqual(calls,[root.url,'https://original.example.org/footage','https://blocked.example.org/page']);
 assert.deepEqual(out.items.map(i=>i.url),['https://original.example.org/footage']);
 assert.equal(out.trace.rounds.length,2);
 assert.equal(out.trace.visited[1].from_url,root.url);
 assert.equal(out.trace.visited[2].status,'robots_disallowed');
});

test('failed batches preserve successful decisions, while full failure and budget exhaustion halt exploration',async()=>{
 let calls=0;
 const transport:typeof fetchJSON=async(_url,options)=>{
   if(++calls===2)throw new UpstreamError('timeout');
   return {model:'test',answers:Object.fromEntries(Object.keys((options!.body as any).questions).map(k=>[k,{type:'choice',...decision('unused')}]))};
 };
 const cs=Array.from({length:21},(_,i)=>candidate(`https://source.example.org/${i}`));
 const out=await new JevExplorer(db,config,transport).assess('query',cs);
 assert.equal(out.decisions.length,20);assert.equal(out.failed_batches,1);
 let fetched=0;
 const failed=await exploreSources('query',cs,{async assess(){throw new UpstreamError('timeout');}},async()=>{fetched++;return checked();},config,4);
 assert.equal(failed.trace.error,'timeout');assert.equal(fetched,0);assert.deepEqual(failed.items,[]);
 await assert.rejects(new JevExplorer(db,{...config,JEV_EXPLORATION_DAILY_BUDGET:0},transport).assess('query',[cs[0]]),/budget_exhausted/);
 const expired=await exploreSources('query',cs,useful,async()=>{fetched++;return checked();},config,4,0);
 assert.equal(expired.trace.rounds.length,0);assert.equal(fetched,0);
});

test('missing or invented response keys cannot choose destinations',async()=>{
 const explorer=new JevExplorer(db,config,async()=>({model:'test',answers:{invented:{type:'choice',...decision('unused')}}}));
 await assert.rejects(explorer.assess('query',[candidate('https://source.example.org/')]),/malformed_response/);
});
