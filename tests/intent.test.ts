import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groundedIntent,ModelJudge,type JudgeCandidate} from '../src/judge.js';
import type {ModelClient} from '../src/model-client.js';
import {testConfig,database} from './helpers.js';
import {applySignals} from '../src/signals.js';
import type {Result} from '../src/types.js';
import {fixture} from './helpers.js';
import {SearchService} from '../src/search.js';

const candidate:JudgeCandidate={key:'r1',kind:'video',site:'www.youtube.com',url:'https://www.youtube.com/watch?v=AAAAAAAAAA1',
 title:'A serious ghost story with a reveal',channel:null,official:false,duration:null,live:null,description:null,
 comments:['The ending reveals that the narrator was a ghost.'],moments:[],discussions:[]};
const checks=()=>[
 {dimension:'subject' as const,status:'supported' as const,field:'title' as const,quote:'ghost story'},
 {dimension:'intent' as const,status:'supported' as const,field:'comments' as const,quote:'the narrator was a ghost'},
 {dimension:'format' as const,status:'supported' as const,field:'title' as const,quote:'A serious ghost story'},
];
test('each intent dimension needs a real quote from that candidate',()=>{
 assert.equal(groundedIntent(candidate,checks()),true);
 assert.equal(groundedIntent(candidate,checks().slice(0,2)),false);
 assert.equal(groundedIntent(candidate,[checks()[0],checks()[0],checks()[2]]),false);
 assert.equal(groundedIntent(candidate,checks().map(c=>c.dimension==='intent'?{...c,quote:'A fabricated twist that was never supplied'}:c)),false);
 assert.equal(groundedIntent(candidate,checks().map(c=>c.dimension==='intent'?{...c,status:'unknown'}:c)),false);
 assert.equal(groundedIntent({...candidate,comments:[]},checks()),false,'another result cannot supply its evidence');
 assert.equal(groundedIntent(candidate,checks().map(c=>c.dimension==='subject'?{...c,quote:'ghost'}:c)),true,'short exact subject names are valid evidence');
});
test('a quote survives title truncation and site suffixes but an invented one does not',()=>{
 const listed={...candidate,title:'5 Underrated Network OSINT Tools on GitHub You ... - YouTube',comments:[]};
 const quoting=(quote:string)=>checks().map(c=>c.dimension==='intent'?{...c,field:'title' as const,quote}:c.dimension==='subject'?{...c,field:'title' as const,quote:'OSINT Tools'}:{...c,field:'title' as const,quote:'on GitHub'});
 assert.equal(groundedIntent(listed,quoting('5 Underrated Network OSINT Tools on GitHub You Need')),true);
 assert.equal(groundedIntent(listed,quoting('Underrated OSINT tools that expose private phone numbers')),false);
});
test('unverified quotes rank a result lower instead of removing it; explicit mismatches remove it',async()=>{
 const answer=async(c:JudgeCandidate,rows:any[]|undefined,kind:'videos'|'websites'|'mixed'='videos',relevance=10)=>{
   const client={models:['fixture'],json:async()=>({model:'fixture',value:{verdicts:[{key:c.key,relevance,reason:'Fixture',intent_checks:rows,moment_keys:[]}]}})} as unknown as ModelClient;
   return (await new ModelJudge(client,testConfig).judge('ghost videos with insane plot twist',[c],{kind,criteria:[]})).verdicts.get(c.key)!;
 };
 assert.equal((await answer(candidate,checks())).relevance,8,'verified matches keep the evidence ceiling');
 assert.equal((await answer(candidate,undefined)).relevance,5,'missing quotes cap the score but keep the result');
 assert.equal((await answer(candidate,checks().map(c=>c.dimension==='intent'?{...c,quote:'never said'}:c))).relevance,5);
 assert.equal((await answer(candidate,checks(),'videos',3)).relevance,3,'the cap never raises a low score');
 assert.equal((await answer(candidate,checks().map(c=>c.dimension==='intent'?{...c,status:'mismatch'}:c))).relevance,4);
 assert.equal((await answer(candidate,checks().map(c=>c.dimension==='format'?{...c,status:'mismatch'}:c))).relevance,4,
   'a video is the wrong format when videos were not what the request lacked');
 for(const kind of ['websites','mixed'] as const)
   assert.equal((await answer(candidate,checks().map(c=>c.dimension==='format'?{...c,status:'mismatch'}:c),kind)).relevance,5,
     'a video presenting the requested items is never removed for being a video');
});
test('relevance never depends on hard-coded title rules for particular queries',async()=>{
 const funny={...candidate,title:'The Funniest Ghost Plot Twist Ever!',comments:['The ending reveals that the narrator was a ghost.']};
 const client={models:['fixture'],json:async()=>({model:'fixture',value:{verdicts:[{key:'r1',relevance:7,reason:'Fixture',moment_keys:[],
   intent_checks:[{dimension:'subject',status:'supported',field:'title',quote:'Ghost'},{dimension:'intent',status:'supported',field:'comments',quote:'the narrator was a ghost'},
     {dimension:'format',status:'supported',field:'title',quote:'Plot Twist'}]}]}})} as unknown as ModelClient;
 assert.equal((await new ModelJudge(client,testConfig).judge('ghost videos with insane plot twist',[funny])).verdicts.get('r1')!.relevance,7);
});
const judged=(title:string):Result=>({id:crypto.randomUUID(),source_id:crypto.randomUUID(),source_name:'Fixture',title,canonical_url:`https://example.org/${encodeURIComponent(title)}`,
 description:null,creator:null,published_at:null,duration:null,language:null,thumbnail:null,embeddable:null,rights_status:'unknown',license_url:null,
 availability:'unknown',evidence:'metadata_match',moments:[],origin:'discovery',verified_at:null});
const scoring=(scores:number[])=>({judge:{judge:async(_q:string,c:JudgeCandidate[])=>({model:'test',
 verdicts:new Map(c.map(x=>[x.key,{key:x.key,relevance:scores[Number(x.key.slice(1))-1],reason:'Fixture',momentKeys:[]}]))})}});
test('plausible matches stay, tangential ones go',async()=>{
 const db=await database();
 try {
   const out=await applySignals(db,testConfig,'exact event',[judged('Plausible'),judged('Tangential')],scoring([5,4]));
   assert.deepEqual(out.results.map(r=>r.title),['Plausible']);
   assert.ok(out.providers.some(p=>p.provider==='relevance_filter'));
 }finally{await db.close();}
});
test('when every candidate is rejected, the closest few are shown and labelled, but contradicted ones never are',async()=>{
 const db=await database();
 try {
   const titles=['A','B','C','D','E','F','G'];
   const out=await applySignals(db,testConfig,'exact event',titles.map(judged),scoring([3,4,2,4,3,3,3]));
   assert.deepEqual(out.results.map(r=>r.title),['B','D','A','E','F'],'best five by relevance, keeping the original order for ties');
   assert.ok(out.results.every(r=>r.badges?.includes('Closest match')));
   assert.equal(out.providers.find(p=>p.provider==='relevance_filter')?.status,'partial');
   const none=await applySignals(db,testConfig,'exact event',[judged('Contradicted')],scoring([2]));
   assert.deepEqual(none.results,[]);
 }finally{await db.close();}
});

test('unverified matches only fill a short list, and are labelled as possible matches',async()=>{
 const db=await database();
 try {
   const many=await applySignals(db,{...testConfig,JUDGE_CANDIDATES:20},'exact event',[...Array.from({length:12},(_,i)=>judged('Verified '+i)),judged('Unverified')],
     scoring([...Array(12).fill(6),5]));
   assert.deepEqual(many.results.map(r=>r.title),Array.from({length:12},(_,i)=>'Verified '+i),'enough verified matches leave no room for guesses');
   const few=await applySignals(db,{...testConfig,JUDGE_CANDIDATES:20},'exact event',[judged('Verified'),...Array.from({length:12},(_,i)=>judged('Unverified '+i))],
     scoring([7,...Array(12).fill(5)]));
   assert.equal(few.results.length,10);
   assert.equal(few.results[0].title,'Verified');
   assert.ok(few.results.slice(1).every(r=>r.badges?.includes('Possible match')));
   assert.ok(!few.results[0].badges?.includes('Possible match'));
 }finally{await db.close();}
});
test('a planner guess of websites never tells the judge to reject videos',async()=>{
 const db=await database();
 try {
   const seen:string[]=[];
   const judge={judge:async(_q:string,c:JudgeCandidate[],context?:{kind:string})=>{seen.push(context!.kind);
     return {model:'test',verdicts:new Map(c.map(x=>[x.key,{key:x.key,relevance:6,reason:'Fixture',momentKeys:[]}]))};}};
   await applySignals(db,testConfig,'underrated osint tools',[judged('A tool')],{judge},{kind:'websites',criteria:[],targets:new Map()});
   await applySignals(db,testConfig,'ghost story',[judged('A story')],{judge},{kind:'videos',criteria:[],targets:new Map()});
   assert.deepEqual(seen,['mixed','videos']);
 }finally{await db.close();}
});
test('auto mode does not spend a discovery job when the catalogue already covers the query, even with a judge configured',async()=>{
 const db=await database();
 try {
   await fixture(db,'ghost story reveal','A serious ghost story reveal');
   await fixture(db,'ghost story compilation','Several related ghost stories');
   const service=new SearchService(db,{...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',GEMINI_API_KEY:'fixture-key',
     COVERAGE_MIN_RESULTS:1,COVERAGE_MIN_SOURCES:1,COVERAGE_MIN_SCORE:0});
   const started=await service.start({q:'ghost story'},'precision-test');
   const row=(await db.query('SELECT job_id FROM searches WHERE id=$1',[started.search_id])).rows[0];
   assert.equal(row.job_id,null);
   assert.equal(started.results.length,2);
 }finally{await db.close();}
});
