import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.js';
import {verdictKey,recallVerdicts,rememberVerdicts,portable,restore} from '../src/verdict-cache.js';

const base={tier:'ssj3',version:'v',models:'m',request:'cat glass',contract:'[]',url:'https://www.youtube.com/watch?v=aaaaaaaaaaa',fingerprint:'f1'};

test('a verdict is remembered per request, contract, judge setup, address and evidence',()=>{
 const k=verdictKey(base);
 assert.equal(k,verdictKey({...base,request:'Cat   GLASS'}),'request case and spacing do not matter');
 for(const change of [{fingerprint:'f2'},{contract:'["R1"]'},{url:'https://x.example/'},{models:'other'},{version:'v2'},{tier:'ssj1'},{request:'dog glass'}])
   assert.notEqual(verdictKey({...base,...change}),k,JSON.stringify(change));
});

test('moment keys are stored relative to the candidate and come back on its new key',()=>{
 const v={key:'r3',relevance:8,reason:'r',momentKeys:['r3m1','r3m2'],requirementChecks:[]};
 const kept=portable(v);
 assert.deepEqual(kept.momentKeys,['m1','m2']);
 assert.deepEqual(restore(kept,'r9'),{...v,key:'r9',momentKeys:['r9m1','r9m2']});
});

test('remembered verdicts come back until they expire, and a new verdict replaces an old one',async()=>{
 const db=await database();
 try{
   const k1=verdictKey(base),k2=verdictKey({...base,fingerprint:'f2'});
   assert.equal((await recallVerdicts(db,[k1])).size,0);
   await rememberVerdicts(db,[{key:k1,verdict:portable({key:'r1',relevance:7,reason:'first',momentKeys:[]}),model:'judge-a'}],24);
   await rememberVerdicts(db,[{key:k1,verdict:portable({key:'r1',relevance:8,reason:'second',momentKeys:[]}),model:'judge-b'},
     {key:k2,verdict:portable({key:'r2',relevance:4,reason:'other',momentKeys:[]}),model:'judge-a'}],24);
   const got=await recallVerdicts(db,[k1,k2]);
   assert.equal(got.get(k1)?.verdict.relevance,8);assert.equal(got.get(k1)?.model,'judge-b');assert.equal(got.size,2);
   await db.query("UPDATE judge_verdicts SET expires_at=now()-interval '1 minute' WHERE key=$1",[k2]);
   assert.deepEqual([...(await recallVerdicts(db,[k1,k2])).keys()],[k1],'an expired verdict is not reused');
 }finally{await db.close();}
});
