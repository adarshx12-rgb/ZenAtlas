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
 {dimension:'relationship' as const,status:'supported' as const,field:'comments' as const,quote:'The ending reveals that the narrator was a ghost.'},
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
test('quotes must use visible excerpts without completing truncated titles',()=>{
 const listed={...candidate,title:'5 Underrated Network OSINT Tools on GitHub You ... - YouTube',comments:[]};
 const quoting=(quote:string)=>checks().map(c=>c.dimension==='intent'?{...c,field:'title' as const,quote}:c.dimension==='subject'?{...c,field:'title' as const,quote:'OSINT Tools'}:{...c,field:'title' as const,quote:'on GitHub'});
 assert.equal(groundedIntent(listed,quoting('5 Underrated Network OSINT Tools on GitHub')),true);
 assert.equal(groundedIntent(listed,quoting('5 Underrated Network OSINT Tools on GitHub You Need')),false);
 assert.equal(groundedIntent(listed,quoting('Underrated OSINT tools that expose private phone numbers')),false);
});
test('missing evidence caps a verdict below display eligibility and every explicit mismatch wins',async()=>{
 const answer=async(c:JudgeCandidate,rows:any[]|undefined,kind:'videos'|'websites'|'mixed'='videos',relevance=10)=>{
   const client={models:['fixture'],json:async()=>({model:'fixture',value:{verdicts:[{key:c.key,relevance,reason:'Fixture',intent_checks:rows,moment_keys:[]}]}})} as unknown as ModelClient;
   return (await new ModelJudge(client,testConfig).judge('ghost videos with insane plot twist',[c],{kind,criteria:[]})).verdicts.get(c.key)!;
 };
 assert.equal((await answer(candidate,checks())).relevance,8,'verified matches keep the evidence ceiling');
 assert.equal((await answer(candidate,undefined)).relevance,5,'missing quotes cap the diagnostic verdict');
 assert.equal((await answer(candidate,checks().filter(c=>c.dimension!=='relationship'))).relevance,5,'legacy checks cannot bypass the relationship requirement');
 assert.equal((await answer(candidate,checks().map(c=>c.dimension==='intent'?{...c,quote:'never said'}:c))).relevance,5);
 assert.equal((await answer(candidate,checks(),'videos',3)).relevance,3,'the cap never raises a low score');
 assert.equal((await answer(candidate,checks().map(c=>c.dimension==='intent'?{...c,status:'mismatch'}:c))).relevance,4);
 assert.equal((await answer(candidate,checks().map(c=>c.dimension==='format'?{...c,status:'mismatch'}:c))).relevance,4,
   'a video is the wrong format when videos were not what the request lacked');
 for(const kind of ['websites','mixed'] as const)
   assert.equal((await answer(candidate,checks().map(c=>c.dimension==='format'?{...c,status:'mismatch'}:c),kind)).relevance,4,
     'planner kind cannot excuse an explicit mismatch against the request');
});
test('relevance never depends on hard-coded title rules for particular queries',async()=>{
 const funny={...candidate,title:'The Funniest Ghost Plot Twist Ever!',comments:['The ending reveals that the narrator was a ghost.']};
 const client={models:['fixture'],json:async()=>({model:'fixture',value:{verdicts:[{key:'r1',relevance:7,reason:'Fixture',moment_keys:[],
   intent_checks:[{dimension:'subject',status:'supported',field:'title',quote:'Ghost'},{dimension:'intent',status:'supported',field:'comments',quote:'the narrator was a ghost'},
     {dimension:'relationship',status:'supported',field:'comments',quote:'The ending reveals that the narrator was a ghost.'},
     {dimension:'format',status:'supported',field:'title',quote:'Plot Twist'}]}]}})} as unknown as ModelClient;
 assert.equal((await new ModelJudge(client,testConfig).judge('ghost videos with insane plot twist',[funny])).verdicts.get('r1')!.relevance,7);
});

test('relationship evidence preserves participant order and negation',()=>{
 const clip={...candidate,description:'The crowd reacts to the commentator during the match.'};
 const relationship=(quote:string)=>checks().map(c=>c.dimension==='relationship'?{...c,field:'description' as const,quote}:c);
 assert.equal(groundedIntent(clip,relationship('The crowd reacts to the commentator during the match.')),true);
 assert.equal(groundedIntent(clip,relationship('The commentator reacts to the crowd during the match.')),false,
   'identical words in a different order do not support the claimed relationship');
 assert.equal(groundedIntent({...clip,description:'The commentator does not react to the crowd during the match.'},
   relationship('The commentator does react to the crowd during the match.')),false);
});

test('WWE relationship mismatches and unknowns cannot keep high scores or appear as filler',async()=>{
 const db=await database();
 try {
   const descriptions=[
     'WWE commentators shout in shock as a wrestler returns during the match.',
     'WWE commentator audio dubbed over unrelated video game footage.',
     'WWE commentary bloopers and funny lines.',
   ];
   const statuses=['supported','mismatch','unknown'] as const;
   const client={models:['fixture'],json:async(_bucket:string,system:string,_text:string,schema:any)=>{
     assert.match(system,/who does what, to whom or what, and in which context/);
     assert.match(system,/dubbed over gameplay or unrelated fails is a relationship mismatch/);
     assert.ok(schema.properties.verdicts.items.properties.intent_checks.items.properties.dimension.enum.includes('relationship'));
     return {model:'fixture',value:{verdicts:descriptions.map((description,i)=>({key:`r${i+1}`,relevance:10,reason:'Fixture',moment_keys:[],
       intent_checks:['subject','intent','relationship','format'].map(dimension=>({dimension,
         status:dimension==='relationship'?statuses[i]:'supported',field:'description',quote:description}))}))}};
   }} as unknown as ModelClient;
   const results=descriptions.map((description,i)=>({...judged(['Match reactions','Gaming edit','Bloopers'][i]),description}));
   const out=await applySignals(db,testConfig,'wwe commentators gone crazy moments',results,{judge:new ModelJudge(client,testConfig)});
   assert.deepEqual(out.results.map(r=>r.title),['Match reactions']);
   assert.deepEqual(out.judged.map(v=>v.relevance),[6,4,5]);
   const onlyWrong=await new ModelJudge(client,testConfig).judge('wwe commentators gone crazy moments',
     descriptions.map((description,i)=>({...candidate,key:`r${i+1}`,description})));
   assert.equal(onlyWrong.verdicts.get('r2')?.intentChecks?.find(c=>c.dimension==='relationship')?.status,'mismatch',
     'rejected relationship evidence is retained for inspection');
 } finally {await db.close();}
});
const judged=(title:string):Result=>({id:crypto.randomUUID(),source_id:crypto.randomUUID(),source_name:'Fixture',title,canonical_url:`https://example.org/${encodeURIComponent(title)}`,
 description:null,creator:null,published_at:null,duration:null,language:null,thumbnail:null,embeddable:null,rights_status:'unknown',license_url:null,
 availability:'unknown',evidence:'metadata_match',moments:[],origin:'discovery',verified_at:null});
const scoring=(scores:number[])=>({judge:{judge:async(_q:string,c:JudgeCandidate[])=>({model:'test',
 verdicts:new Map(c.map(x=>[x.key,{key:x.key,relevance:scores[Number(x.key.slice(1))-1],reason:'Fixture',momentKeys:[]}]))})}});
test('uncertain and tangential matches never fill the main results',async()=>{
 const db=await database();
 try {
   const out=await applySignals(db,testConfig,'exact event',[judged('Plausible'),judged('Tangential')],scoring([5,4]));
   assert.deepEqual(out.results,[]);
   assert.deepEqual(out.closest.map(r=>r.title),['Plausible','Tangential']);
   assert.ok(out.providers.some(p=>p.provider==='relevance_filter'));
 }finally{await db.close();}
});
test('an entirely rejected pool stays empty instead of resurrecting closest matches',async()=>{
 const db=await database();
 try {
   const titles=['A','B','C','D','E','F','G'];
   const out=await applySignals(db,testConfig,'exact event',titles.map(judged),scoring([3,4,2,4,3,3,3]));
   assert.deepEqual(out.results,[]);
   assert.deepEqual(out.closest.map(r=>r.title),['B','D','A','E','F','G']);
   assert.match(out.providers.find(p=>p.provider==='relevance_filter')!.message,/No sufficiently supported matches/);
   assert.equal(out.judged.length,7,'rejected verdicts remain available for diagnostics');
   const none=await applySignals(db,testConfig,'exact event',[judged('Contradicted')],scoring([2]));
   assert.deepEqual(none.results,[]);
 }finally{await db.close();}
});

test('uncertain matches are excluded even when only one supported result remains',async()=>{
 const db=await database();
 try {
   const many=await applySignals(db,{...testConfig,JUDGE_CANDIDATES:20},'exact event',[...Array.from({length:12},(_,i)=>judged('Verified '+i)),judged('Unverified')],
     scoring([...Array(12).fill(6),5]));
   assert.deepEqual(many.results.map(r=>r.title),Array.from({length:12},(_,i)=>'Verified '+i),'enough verified matches leave no room for guesses');
   const few=await applySignals(db,{...testConfig,JUDGE_CANDIDATES:20},'exact event',[judged('Verified'),...Array.from({length:12},(_,i)=>judged('Unverified '+i))],
     scoring([7,...Array(12).fill(5)]));
   assert.equal(few.results.length,1);
   assert.equal(few.results[0].title,'Verified');
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
