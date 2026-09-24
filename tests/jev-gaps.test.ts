import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JevGapChooser,makeGapChooser} from '../src/exploration.js';
import type {DB} from '../src/db.js';
import type {fetchJSON} from '../src/http.js';
import {normaliseContract} from '../src/requirements.js';
import {coverage} from '../src/evidence.js';
import type {GapCandidate,KeyedGap} from '../src/gaps.js';
import {testConfig} from './helpers.js';

const config={...testConfig,OPENROUTER_API_KEY:'test-key'};
const db:DB={async query<T>(){return {rows:[{used:1}] as T[]};},async transaction(fn){return fn(db);},async close(){}};
const contract=normaliseContract('official whatsapp chat ui interface from over past 3 years','2026-09-24',{
 entities:[{name:'WhatsApp',kind:'product'}],official_domains:['whatsapp.com']});
const gaps:KeyedGap[]=coverage(contract,[],1).gaps.map(g=>({...g,key:g.item?`${g.requirement_id}:${g.item}`:g.requirement_id}));
const cand=(url:string,from:string|null=null):GapCandidate=>({url,title:'Chat themes to reflect your style',description:'New chat themes',published_at:'2025-02-13',
 from_url:from,context:from?'WhatsApp blog index':undefined,target:'web'});
const answer=(choice:string,confidence=0.9,options:string[]=[])=>({type:'choice',choice,confidence,
 probabilities:Object.fromEntries(options.map(o=>[o,o===choice?confidence:(1-confidence)/Math.max(1,options.length-1)]))});

test('Jev gets the contract, current coverage, the gaps and each candidate\'s context, and says which gap it would close',async()=>{
 let body:any;
 const transport:typeof fetchJSON=async(url,options)=>{
   assert.equal(url,'https://openrouter.ai/api/alpha/decisions');body=options!.body;
   const opts=Object.keys(body.questions.c0.criteria);
   return {model:'typesafe/jev-1.13',answers:{c0:answer('g2',0.92,opts),c1:answer('none',0.8,opts)}};
 };
 const out=await new JevGapChooser(db,config,transport).choose(contract,gaps,['R1: 0 supported'],
   [cand('https://blog.whatsapp.com/chat-themes','https://blog.whatsapp.com/'),cand('https://www.youtube.com/watch?v=abc')]);
 assert.deepEqual(body.state.requirements.map((r:any)=>r.id),contract.requirements.filter(r=>r.hardness==='hard'||r.scope==='set').map(r=>r.id));
 assert.equal(body.state.search_date,'2026-09-24');
 assert.deepEqual(body.state.coverage,['R1: 0 supported']);
 assert.equal(Object.keys(body.state.gaps).length,gaps.length);
 assert.deepEqual(body.state.candidates.c0,{url:'https://blog.whatsapp.com/chat-themes',domain:'blog.whatsapp.com',title:'Chat themes to reflect your style',
   description:'New chat themes',published_at:'2025-02-13',known_format:'website',linked_from:'https://blog.whatsapp.com/',link_context:'WhatsApp blog index'});
 assert.equal(body.state.candidates.c1.known_format,'video');
 assert.deepEqual(Object.keys(body.questions.c0.criteria),[...gaps.map((_,i)=>`g${i+1}`),'none']);
 assert.match(body.questions.c0.instructions,/state\.candidates\.c0/);
 assert.deepEqual(out.decisions,[{url:'https://blog.whatsapp.com/chat-themes',gap:gaps[1].key,confidence:0.92},
   {url:'https://www.youtube.com/watch?v=abc',gap:null,confidence:0.8}]);
});

test('low confidence chooses nothing; malformed answers fail only their batch; budget and configuration gate calls',async()=>{
 const low:typeof fetchJSON=async(_u,o)=>({model:'m',answers:{c0:answer('g1',0.3,Object.keys((o!.body as any).questions.c0.criteria))}});
 const out=await new JevGapChooser(db,config,low).choose(contract,gaps,[],[cand('https://a.example/x')]);
 assert.equal(out.decisions[0].gap,null,'below JEV_EXPLORATION_CONFIDENCE a choice is not acted on');
 const bad:typeof fetchJSON=async()=>({model:'m',answers:{}});
 const many=Array.from({length:25},(_,i)=>cand(`https://a.example/${i}`));
 await assert.rejects(new JevGapChooser(db,config,bad).choose(contract,gaps,[],many),/malformed_response/);
 await assert.rejects(new JevGapChooser(db,{...config,JEV_EXPLORATION_DAILY_BUDGET:0},low).choose(contract,gaps,[],[cand('https://a.example/x')]),/budget_exhausted/);
 assert.equal(makeGapChooser(db,testConfig),undefined);
 assert.ok(makeGapChooser(db,config));
});
