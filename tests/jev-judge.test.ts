import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JevJudge,snippetsOf} from '../src/jev-judge.js';
import {groundedQuote,type Judge,type JudgeCandidate} from '../src/judge.js';
import type {DB} from '../src/db.js';
import type {fetchJSON} from '../src/http.js';
import {testConfig} from './helpers.js';

const config={...testConfig,OPENROUTER_API_KEY:'k'};
const db:DB={async query<T>(){return {rows:[{used:1}] as T[]};},async transaction(fn){return fn(db);},async close(){}};
const requirements=[{id:'R1',text:'About the 1947 Roswell incident',evidence:'describes it'},{id:'R2',text:'Is an article',evidence:'page type'}];
const context={kind:'mixed' as const,criteria:[],requirements};
const base=(key:string,p:Partial<JudgeCandidate>={}):JudgeCandidate=>({key,kind:'website',site:'example.org',url:`https://example.org/${key}`,
 title:`Search title ${key}`,channel:null,official:false,duration:null,live:null,description:'Search snippet about Roswell',
 description_source:'search',comments:[],moments:[],discussions:[],...p});
const inspected=(key:string)=>base(key,{page:{status:'checked',title:'What happened at Roswell',description:null,
 text:'In July 1947 a rancher found debris near Roswell. This article reviews the records.',libraries:[]}});

test('snippets come only from inspected content, each an exact excerpt of its field',()=>{
 const snips=snippetsOf(inspected('a'));
 assert.ok(snips.length>=2);
 assert.ok(!snips.some(s=>s.text.includes('Search snippet')),'search snippets are never evidence');
 assert.ok(!snips.some(s=>s.text.includes('Search title')));
 const c=inspected('a');
 for(const s of snips)assert.ok(groundedQuote(c,{status:'supported',field:s.field,quote:s.text}),s.text);
 assert.deepEqual(snippetsOf(base('b')),[],'nothing inspected, nothing to quote');
 const api=base('c',{description:'Official upload. Filmed in 2024.',description_source:'api',comments:['Great footage of the launch']});
 assert.deepEqual(snippetsOf(api).map(s=>s.field),['description','description','comments']);
});

type Reply=(body:any)=>any;
const jev=(reply:Reply)=>(async(_url:string,options?:any)=>reply(options!.body)) as typeof fetchJSON;
const confident=(body:any,level=4,choice='s1',conf=0.95)=>{
 const answers:any={relevance:{type:'score',score:level,confidence:conf,probabilities:{[String(level)]:conf}},lesser:{type:'noul',noul:0.2}};
 for(const r of requirements)answers[`req_${r.id}`]={type:'choice',choice,confidence:conf,probabilities:{[choice]:conf}};
 assert.ok(Object.keys(body.questions).includes('req_R1'));
 return {model:'typesafe/jev-1.13',answers};
};

test('confident, snippet-backed matches are settled by Jev; the rest go to the LLM judge in small batches',async()=>{
 const forwarded:string[][]=[];
 const inner:Judge={async judge(_q,cs){forwarded.push(cs.map(c=>c.key));
   return {model:'llm',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:6,reason:'llm',momentKeys:[]}]))};}};
 const transport=jev(body=>body.state.candidate.key==='a'?confident(body):confident(body,2,'unknown',0.6));
 const cs=[inspected('a'),inspected('b'),...Array.from({length:7},(_,i)=>base(`n${i}`))];
 const out=await new JevJudge(db,config,inner,transport).judge('roswell article',cs,context);
 const a=out.verdicts.get('a')!;
 assert.equal(a.relevance,9,'level 4 maps to 9.5, capped by the evidence ceiling for a checked page (10), rounded down');
 assert.ok(a.requirementChecks!.every(c=>c.status==='supported'&&groundedQuote(inspected('a'),c)),'settled verdicts carry grounded quotes');
 assert.match(a.reason,/^Jev: /);
 assert.deepEqual(forwarded.flat().sort(),['b',...Array.from({length:7},(_,i)=>`n${i}`)].sort());
 assert.ok(forwarded.every(b=>b.length<=6));
 assert.equal((out.jev!.get('a') as any).outcome,'settled');
 assert.equal((out.jev!.get('n0') as any).outcome,'forwarded','no inspected snippets: Jev is not asked');
});

test('would-reject stays in shadow by default and rejects only when switched on; failures always forward',async()=>{
 const inner:Judge={async judge(_q,cs){return {model:'llm',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:7,reason:'llm',momentKeys:[]}]))};}};
 const reject=jev(body=>confident(body,0,'mismatch',0.9));
 const shadow=await new JevJudge(db,config,inner,reject).judge('roswell article',[inspected('a')],context);
 assert.deepEqual([shadow.verdicts.get('a')!.reason,(shadow.jev!.get('a') as any).outcome],['llm','would_reject']);
 const live=await new JevJudge(db,{...config,JEV_JUDGE_REJECT:true},inner,reject).judge('roswell article',[inspected('a')],context);
 assert.ok(live.verdicts.get('a')!.relevance<=4);
 assert.ok(live.verdicts.get('a')!.requirementChecks!.some(c=>c.status==='mismatch'));
 let calls=0;
 const reset=jev(()=>{calls++;const e:any=new Error('socket hang up');e.code='ECONNRESET';throw e;});
 const failed=await new JevJudge(db,config,inner,reset).judge('roswell article',[inspected('a')],context);
 assert.deepEqual([failed.verdicts.get('a')!.reason,(failed.jev!.get('a') as any).outcome,calls],['llm','failed',2],'one retry after a reset, then the LLM judge');
 const malformed=await new JevJudge(db,config,inner,jev(()=>({model:'m',answers:{}}))).judge('q',[inspected('a')],context);
 assert.equal(malformed.verdicts.get('a')!.reason,'llm');
 const broke=await new JevJudge(db,{...config,JEV_JUDGE_DAILY_BUDGET:0},inner,jev(body=>confident(body))).judge('q',[inspected('a')],context);
 assert.equal((broke.jev!.get('a') as any).outcome,'budget_exhausted');
 const plain=await new JevJudge(db,config,inner,jev(body=>confident(body))).judge('q',[inspected('a')],{kind:'videos',criteria:[]});
 assert.equal(plain.verdicts.get('a')!.reason,'llm','without a contract Jev does not settle anything');
});

test('gate mode: a confident match still goes to the LLM judge with Jev findings; unreliable pages are rejected',async()=>{
 const seen:JudgeCandidate[]=[];
 const inner:Judge={async judge(_q,cs){seen.push(...cs);return {model:'llm',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:7,reason:'llm',momentKeys:[]}]))};}};
 const asked:any[]=[];
 const transport=jev(body=>{asked.push(body);const r=confident(body);r.answers.accuracy={type:'noul',noul:body.state.candidate.key==='bad'?0.1:0.9};return r;});
 const out=await new JevJudge(db,{...config,JEV_JUDGE_REJECT:true},inner,transport,{settle:false,accuracy:true})
   .judge('roswell article',[inspected('a'),inspected('bad')],context);
 assert.equal(out.verdicts.get('a')!.reason,'llm','a confident match is not settled by Jev');
 assert.deepEqual([(out.jev!.get('a') as any).outcome,(out.jev!.get('a') as any).accuracy],['would_settle',0.9]);
 assert.deepEqual(seen.map(c=>[c.key,c.jev_check]),[['a',{relevance:4,accuracy:0.9}]]);
 assert.equal(out.verdicts.get('bad')!.reason,'Jev: unreliable information.');
 assert.ok(out.verdicts.get('bad')!.relevance<=4);
 assert.equal((out.jev!.get('bad') as any).outcome,'rejected');
 assert.ok(asked.every(b=>b.questions.accuracy?.type==='noul'));
});

test('default mode asks no accuracy question and attaches nothing to candidates',async()=>{
 const seen:JudgeCandidate[]=[];
 const inner:Judge={async judge(_q,cs){seen.push(...cs);return {model:'llm',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:7,reason:'llm',momentKeys:[]}]))};}};
 const transport=jev(body=>{assert.equal(body.questions.accuracy,undefined);return confident(body,2,'unknown',0.6);});
 await new JevJudge(db,config,inner,transport).judge('q',[inspected('a')],context);
 assert.equal(seen[0].jev_check,undefined);
});
