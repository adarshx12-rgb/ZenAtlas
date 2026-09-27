import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {rewriteQuery, clearRewriteCache, keepsMeaning} from '../src/query-rewrite.js';

const db={} as any;
const config={...testConfig,QUERY_REWRITE_TIMEOUT_MS:300};
const answer=(value:unknown)=>({model:async()=>value,log:()=>{}});

test('typos are fixed, the topic is named and two extra searches come back',async()=>{
 clearRewriteCache();
 const out=await rewriteQuery(db,config,'Gen X Soft Clubl design style catalouge','docs',answer({corrected:'Gen X Soft Club design style catalogue',
   topic:'Gen X Soft Club',topic_kind:'internet aesthetic',searches:['"Gen X Soft Club" aesthetic examples','Gen X Soft Club aesthetic archive']}));
 assert.deepEqual(out,{query:'Gen X Soft Clubl design style catalouge',corrected:'Gen X Soft Club design style catalogue',changed:true,
   topic:'Gen X Soft Club',topic_kind:'internet aesthetic',searches:['"Gen X Soft Club" aesthetic examples','Gen X Soft Club aesthetic archive']});
});

test('a rewrite that changes what was asked is refused: another name, a dropped or added year, extra ideas',()=>{
 assert.ok(keepsMeaning('pyhton asyncio tutorial','python asyncio tutorial'));
 assert.ok(keepsMeaning('harry poter and the philospher stone 1997 first edtion',"Harry Potter and the Philosopher's Stone 1997 first edition"));
 assert.ok(keepsMeaning('mcdonalds anual report 2019',"McDonald's annual report 2019"));
 assert.ok(keepsMeaning('cottagecore interior desgin ideas','cottagecore interior design ideas'));
 assert.ok(!keepsMeaning('mcdonalds anual report 2019',"McDonald's annual report 2020"),'a year changed');
 assert.ok(!keepsMeaning('kerala sslc 2024 question paper','kerala sslc question paper'),'a year dropped');
 assert.ok(!keepsMeaning('elden ring boss guide','dark souls boss guide'),'a different name');
 assert.ok(!keepsMeaning('rtx 5090 teardown','rtx 5090 teardown video with benchmarks and review'),'ideas added');
});

test('a drifted rewrite falls back to the query as typed; searches that drop a year are left out',async()=>{
 clearRewriteCache();
 const drifted=await rewriteQuery(db,config,'elden ring boss guide','web',answer({corrected:'dark souls boss guide',topic:'Dark Souls',topic_kind:'video game',searches:['a','b']}));
 assert.deepEqual([drifted.corrected,drifted.changed,drifted.searches],['elden ring boss guide',false,[]]);
 clearRewriteCache();
 const years=await rewriteQuery(db,config,'IPCC AR6 synthesis report 2023','docs',answer({corrected:'IPCC AR6 synthesis report 2023',topic:'IPCC AR6',
   topic_kind:'climate report',searches:['"IPCC AR6" synthesis report 2023','IPCC sixth assessment synthesis']}));
 assert.deepEqual([years.changed,years.searches],[false,['"IPCC AR6" synthesis report 2023']]);
});

test('any failure, a slow model or a malformed reply gives the query as typed, and failures are not cached',async()=>{
 clearRewriteCache();
 const plain=(q:string)=>({query:q,corrected:q,changed:false,topic:null,topic_kind:null,searches:[]});
 assert.deepEqual(await rewriteQuery(db,config,'some query','web',{model:async()=>{throw new Error('down');},log:()=>{}}),plain('some query'));
 assert.deepEqual(await rewriteQuery(db,config,'some query','web',{model:()=>new Promise(r=>setTimeout(()=>r({}),2000)),log:()=>{}}),plain('some query'));
 assert.deepEqual(await rewriteQuery(db,config,'some query','web',answer({corrected:42})),plain('some query'));
 let calls=0;
 const counting={model:async()=>{calls++;return {corrected:'some query',topic:null,topic_kind:null,searches:['some query guide','some query explained']};},log:()=>{}};
 await rewriteQuery(db,config,'some query','web',counting);await rewriteQuery(db,config,'Some  Query','web',counting);
 assert.equal(calls,1,'a good rewrite is cached by normalised query');
 assert.deepEqual(await rewriteQuery(db,{...config,QUERY_REWRITE_ENABLED:false},'other query','web',counting),plain('other query'));
 assert.equal(calls,1,'disabled: the model is never asked');
});

test('one log line per rewrite, never the query text',async()=>{
 clearRewriteCache();
 const lines:unknown[]=[];
 await rewriteQuery(db,config,'pyhton asyncio tutorial','docs',{model:async()=>({corrected:'python asyncio tutorial',topic:'asyncio',topic_kind:'Python library',
   searches:['"asyncio" python tutorial','python asyncio guide']}),log:l=>lines.push(l)});
 assert.equal(lines.length,1);
 const line=lines[0] as Record<string,unknown>;
 assert.deepEqual([line.event,line.changed,line.outcome,line.searches],['query_rewrite',true,'rewritten',2]);
 assert.ok(!JSON.stringify(line).includes('asyncio'));
});

import {tierConfig} from '../src/tiers.js';
test('each tier keeps its own rewrites, and the log names the tier',async()=>{
 clearRewriteCache();
 let calls=0;const lines:any[]=[];
 const deps={model:async()=>{calls++;return {corrected:'python asyncio tutorial',topic:null,topic_kind:null,searches:['python asyncio guide','asyncio tutorial examples']};},log:(l:any)=>lines.push(l)};
 await rewriteQuery(db,config,'pyhton asyncio tutorial','docs',deps);
 await rewriteQuery(db,tierConfig(config,'ssj1'),'pyhton asyncio tutorial','docs',deps);
 assert.equal(calls,2,'an SSJ3 rewrite is not reused for SSJ1');
 assert.deepEqual(lines.map(l=>l.tier),['ssj3','ssj1']);
});
