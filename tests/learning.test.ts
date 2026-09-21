import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {traceMetrics,saveTrace,auditTrace,reviewAudits,auditReport,criticClient,type SearchTrace,type TraceEntry} from '../src/learning.js';
import {claim,enqueue} from '../src/queue.js';
import {createApp} from '../src/app.js';
import {workOnce} from '../src/worker.js';
import {contentInput,searchInput,type SourceAdapter} from '../src/types.js';

const entry=(title:string,over:Partial<TraceEntry>={}):TraceEntry=>({url:`https://site${title.length}.example.org/${encodeURIComponent(title)}`,title,
 site:`site${title.length}.example.org`,round:0,relevance:7,reason:'TEST',basis:'metadata',shown:true,rank:null,badges:[],...over});
const trace=(pool:TraceEntry[],rounds=0):SearchTrace=>({query:'underrated osint tools',depth:'deep',plan:{kind:'mixed',criteria:['Is an OSINT tool'],model:'planner'},
 searches:[{query:'underrated osint tools',target:'videos',round:0}],rounds,providers:[{provider:'searxng',status:'ok',message:'TEST'}],
 pool:pool.map((p,i)=>({...p,rank:p.shown?i+1:null}))});
const critic=(answers:unknown[])=>{const asked:{bucket:string;text:string}[]=[];
 return {asked,client:{models:['anthropic/claude-sonnet-5'],json:async(bucket:string,_system:string,text:string)=>{asked.push({bucket,text});
   const value=answers.shift();if(value instanceof Error)throw value;return {model:'anthropic/claude-sonnet-5',value};}}};};

test('search metrics show late finds, near-duplicate uploads, evidence strength and what was rejected',()=>{
 const m=traceMetrics(trace([
   entry('Booker T WWE NXT Funny Commentary Moments Part 17',{relevance:8,basis:'viewer_claims'}),
   entry('Booker T WWE NXT Funny Commentary Moments Part 18',{relevance:8,round:2,url:'https://www.youtube.com/watch?v=p18'}),
   entry('Craziest announcer reactions',{relevance:5,badges:['Possible match'],round:2,url:'https://www.youtube.com/watch?v=c1'}),
   entry('Greatest calls',{relevance:6,basis:'direct_evidence'}),
   entry('Off topic',{relevance:3,shown:false}),entry('Contradicted',{relevance:1,shown:false}),entry('Unchecked',{relevance:null,shown:false}),
 ],2));
 assert.deepEqual({shown:m.shown,verified:m.verified,possible:m.possible,rejected:m.rejected,near_misses:m.near_misses,unjudged:m.unjudged},
   {shown:4,verified:3,possible:1,rejected:2,near_misses:1,unjudged:1});
 assert.equal(m.last_round_share,0.5);
 assert.equal(m.duplicate_groups.length,1);assert.equal(m.duplicate_groups[0].length,2);
 assert.deepEqual(m.basis,{metadata:2,viewer_claims:1,direct_evidence:1});
 assert.equal(traceMetrics(trace([entry('Only')])).last_round_share,null,'no follow-up rounds means depth cannot be read from rounds');
});

test('an audit keeps only claims about real candidates, and a missing source counts only when a probe finds relevant results',async()=>{
 const db=await database();
 try{
   const pool=[entry('Hidden OSINT tools',{url:'https://www.youtube.com/watch?v=h1'}),entry('Best tools of the year',{url:'https://tools.example.com/best',relevance:5}),
     entry('Awesome OSINT list',{url:'https://github.com/x/awesome-osint',shown:false,relevance:4})];
   const id=await saveTrace(db,null,trace(pool));
   const {client,asked}=critic([
     {topic:'OSINT tools',
      best_results:{score:1.7,confidence:0.8,summary:'Mostly on target',misranked:[{url:'https://tools.example.com/best',action:'remove',why:'Hand tools'},
        {url:'https://invented.example.com/x',action:'promote',why:'Not in the pool'},{url:'https://github.com/x/awesome-osint',action:'promote',why:'Relevant list'}]},
      missing_sources:{confidence:0.7,sources:[{domain:'github.com',why:'Tools live there',probe_query:'osint tool'},
        {domain:'https://www.reddit.com/r/OSINT',why:'Community picks',probe_query:'underrated tools'},{domain:'not a domain!',why:'x',probe_query:'y'}]},
      search_depth:{verdict:'too_shallow',confidence:0.6,why:'Late rounds still found results'},
      quality:{score:0.6,confidence:0.7,issues:[{kind:'off_tone',urls:['https://tools.example.com/best','https://nowhere.example/'],note:'Hardware tools'}]},
      lessons:[{lesson:'Include GitHub topic pages for tool queries. '.repeat(7),applies_to:'planner',confidence:0.8}]},
     {verdicts:[{key:'p1',relevant:true,why:'An OSINT tool'},{key:'p2',relevant:true,why:'Another'},{key:'p3',relevant:false,why:'Unrelated'}]},
   ]);
   const probed:string[]=[];
   const probe=async(query:string)=>{probed.push(query);return query.endsWith('site:github.com')
     ?[{url:'https://github.com/a/tool',title:'Tool A'},{url:'https://github.com/b/tool',title:'Tool B'},{url:'https://github.com/c/tool',title:'Tool C'},
       {url:'https://github.com/x/awesome-osint',title:'Already seen'}]
     :[{url:'https://www.cisa.gov/topics/cybersecurity',title:'Off-site result the engine ignored site: for'}];};
   const out=await auditTrace(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true},id,{client,probe});
   assert.equal(out.status,'complete');
   const row=(await db.query('SELECT * FROM search_audits WHERE trace_id=$1',[id])).rows[0];
   assert.equal(row.model,'anthropic/claude-sonnet-5');
   assert.deepEqual(row.audit.best_results.misranked.map((m:any)=>m.url),['https://tools.example.com/best','https://github.com/x/awesome-osint'],'invented URLs are dropped');
   assert.equal(row.audit.best_results.score,1,'scores are clamped to 0-1');
   assert.deepEqual(row.audit.quality.issues[0].urls,['https://tools.example.com/best']);
   assert.deepEqual(probed,['osint tool site:github.com','underrated tools site:reddit.com'],'domains are normalised and invalid ones skipped');
   assert.deepEqual(row.probes.map((p:any)=>[p.domain,p.status,p.relevant]),[['github.com','confirmed',2],['reddit.com','no_results',0]]);
   assert.ok(!asked[1].text.includes('Already seen'),'results already in the pool are not re-checked');
   assert.ok(!asked[1].text.includes('Off-site'),'a probe only counts results from the source it tests');
   assert.match(asked[0].text,/^Today: \d{4}-\d{2}-\d{2}$/m,'the critic knows the date, so recent uploads are not called future-dated');
   assert.equal(row.audit.lessons[0].lesson.length,'Include GitHub topic pages for tool queries.'.repeat(7).length+6,'lessons are kept whole');
   assert.ok(asked.every(a=>a.bucket==='critic_calls'));
 }finally{await db.close();}
});

test('audits stop at the daily critic budget and failures are recorded, not retried forever',async()=>{
 const db=await database();
 try{
   const id=await saveTrace(db,null,trace([entry('Anything')]));
   const skipped=await auditTrace(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true,CRITIC_DAILY_BUDGET:0},id,{client:critic([]).client,probe:async()=>[]});
   assert.deepEqual([skipped.status,skipped.code],['skipped','budget_exhausted']);
   const other=await saveTrace(db,null,trace([entry('Other')]));
   const failed=await auditTrace(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true},other,{client:critic([{not:'an audit'}]).client,probe:async()=>[]});
   assert.deepEqual([failed.status,failed.code],['failed','malformed_audit']);
 }finally{await db.close();}
});

test('a finished discovery search is recorded and, with the critic on, queued for one audit',async()=>{
 const db=await database();
 try{
   const provider:SourceAdapter={name:'general',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[contentInput.parse({url:'https://general.example.org/1',title:'Moon launch footage'})],next_cursor:null,
       status:{provider:'general',status:'ok',message:'TEST'}};}};
   const deps={planner:{async plan(q:string){return {kind:'videos' as const,searches:[{query:q,target:'videos' as const}],criteria:[],model:'m'};}},
     judge:{async judge(_q:string,c:any[]){return {model:'j',verdicts:new Map(c.map(x=>[x.key,{key:x.key,relevance:7,reason:'TEST',momentKeys:[]}]))};}}};
   await enqueue(db,'discovery','discovery:moon',searchInput.parse({q:'moon launch'}));
   await workOnce(db,{...testConfig,CRITIC_ENABLED:true,OPENROUTER_API_KEY:'k'},[provider],undefined,deps as any);
   const trace=(await db.query('SELECT id,query FROM search_traces')).rows[0];
   assert.equal(trace.query,'moon launch');
   assert.deepEqual((await db.query("SELECT payload FROM jobs WHERE kind='audit'")).rows.map((r:any)=>r.payload),[{trace_id:trace.id}]);
 }finally{await db.close();}
});
test('the critic has room to think: its own output cap, budget and timeout, separate from live judging',async()=>{
 const db=await database();
 try{
   const sent:any[]=[];
   const client=criticClient(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_DAILY_BUDGET:7,CRITIC_TIMEOUT_MS:90000},'anthropic/claude-sonnet-5',
     (async(_url:string,options:any)=>{sent.push(options);return {choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]};}) as any);
   assert.deepEqual((await client.json('critic_calls','system','text',{type:'object'})).value,{ok:true});
   assert.deepEqual([sent[0].body.model,sent[0].body.max_tokens,sent[0].timeoutMs],['anthropic/claude-sonnet-5',16000,90000]);
   assert.equal((await db.query("SELECT used FROM budgets WHERE bucket='critic_calls'")).rows[0].used,1);
 }finally{await db.close();}
});
test('the critic lane never delays searches, and searches never wait behind audits',async()=>{
 const db=await database();
 try{
   await enqueue(db,'audit','audit:one',{trace_id:crypto.randomUUID()});
   assert.equal(await claim(db),null,'the search worker leaves audits alone');
   await enqueue(db,'discovery','discovery:one',{q:'x'});
   assert.equal((await claim(db,'critic'))?.kind,'audit');
   assert.equal((await claim(db,'critic')),null,'and the critic lane never takes discovery work');
   assert.equal((await claim(db))?.kind,'discovery');
 }finally{await db.close();}
});

test('the weekly check marks each critic finding as supported or not, and stores its agreement rate',async()=>{
 const db=await database();
 try{
   const id=await saveTrace(db,null,trace([entry('Hidden OSINT tools',{url:'https://www.youtube.com/watch?v=h1'})]));
   await auditTrace(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true},id,{probe:async()=>[],client:critic([{topic:'OSINT',
     best_results:{score:0.8,confidence:0.8,summary:'Fine',misranked:[]},missing_sources:{confidence:0.2,sources:[]},
     search_depth:{verdict:'enough',confidence:0.7,why:'Saturated'},quality:{score:0.7,confidence:0.6,issues:[]},
     lessons:[{lesson:'Keep GitHub in tool searches',applies_to:'sources',confidence:0.9}]}]).client});
   const {client}=critic([{findings:[{key:'best_results',verdict:'supported',why:'OK'},{key:'search_depth',verdict:'unsupported',why:'Only one round ran'},
     {key:'lesson1',verdict:'supported',why:'OK'}]}]);
   const reviewed=await reviewAudits(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true},{client});
   assert.equal(reviewed,1);
   const row=(await db.query('SELECT review,review_model,reviewed_at FROM search_audits WHERE trace_id=$1',[id])).rows[0];
   assert.ok(row.reviewed_at);assert.equal(row.review_model,'anthropic/claude-sonnet-5');
   assert.equal(row.review.agreement,2/3);
   assert.equal(await reviewAudits(db,{...testConfig,OPENROUTER_API_KEY:'k',CRITIC_ENABLED:true},{client:critic([]).client}),0,'an audit is reviewed once');
   const report=await auditReport(db);
   assert.deepEqual([report.summary.audits.complete,report.summary.review,report.summary.depth.enough],[1,{reviewed:1,agreement:2/3},1]);
   assert.deepEqual([report.audits[0].audit.topic,report.audits[0].feedback],['OSINT',{useful:0,not_useful:0,missing:[]}]);
 }finally{await db.close();}
});

test('searchers can rate any result, say why, and report what was missing; admins see audits with that feedback',async()=>{
 const db=await database();const app=await createApp(db,testConfig);
 try{
   const saved=await fixture(db,'bedroom tour','A bedroom tour');
   const started=await app.inject('/api/search?q=bedroom&mode=catalogue');
   const cookie=String(started.headers['set-cookie']).split(';')[0],search=started.json();
   const send=(payload:unknown,headers:Record<string,string>={cookie,'x-requested-with':'CreatorSearch'})=>
     app.inject({method:'POST',url:`/api/search/${search.search_id}/feedback`,headers,payload:payload as any});
   assert.equal((await send({url:saved.canonical_url,useful:false,reason:'low_quality'})).statusCode,204);
   assert.equal((await send({url:saved.canonical_url,useful:false,reason:'off_topic'})).statusCode,204,'a second vote replaces the first');
   assert.equal((await send({url:saved.canonical_url,kind:'open'})).statusCode,204);
   assert.equal((await send({kind:'missing',note:'Nothing from r/OSINT'})).statusCode,204);
   assert.equal((await send({url:'https://elsewhere.example.com/x',useful:true})).statusCode,403,'only results of this search');
   assert.equal((await send({url:saved.canonical_url,useful:true},{'x-requested-with':'CreatorSearch'})).statusCode,404,'only the searcher');
   assert.equal((await send({url:saved.canonical_url,reason:'off_topic'})).statusCode,400,'a vote needs a verdict');
   const rows=(await db.query('SELECT kind,url,useful,reason,note,query FROM result_feedback ORDER BY kind')).rows;
   assert.deepEqual(rows.map((r:any)=>[r.kind,r.useful,r.reason,r.note,r.query]),
     [['missing',null,null,'Nothing from r/OSINT','bedroom'],['open',null,null,null,'bedroom'],['vote',false,'off_topic',null,'bedroom']]);
   assert.deepEqual((await db.query('SELECT useful FROM feedback')).rows,[{useful:false}],'catalogue results still get personal ranking feedback');

   assert.equal((await app.inject('/api/admin/audits')).statusCode,403);
   const report=(await app.inject({url:'/api/admin/audits',headers:{authorization:`Bearer ${testConfig.ADMIN_TOKEN}`}})).json();
   assert.deepEqual(report.summary.feedback,{votes:1,useful:0,not_useful:1,opens:1,missing:1});
   assert.deepEqual(report.audits,[]);
 }finally{await app.close();await db.close();}
});
