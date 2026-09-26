import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decide} from '../src/evidence.js';

const contract=(texts:string[])=>({requirements:texts.map((text,i)=>({id:`R${i+1}`,text,kind:'property',hardness:'hard',scope:'each',evidence:'e'}))}) as any;

test('an exclusion the evidence cannot confirm is waived with a note, not counted as unverified',()=>{
 const c=contract(['removes a stuck seatpost using heat','exclude background music','not from big news channels','No talking']);
 const d=decide(c,[],[{id:'R1',status:'supported',field:'title',quote:'heat gun'}]);
 assert.equal(d.status,'verified');
 assert.deepEqual(d.requirements.map(r=>r.status),['supported','waived','waived','waived']);
 assert.deepEqual(d.unconfirmed,[]);
 assert.ok(d.notes.some(n=>/Could not check: exclude background music/.test(n)));
});

test('an exclusion the evidence contradicts still removes the result; ordinary unknown requirements stay unverified',()=>{
 const c=contract(['how UPI works','not from big news channels']);
 const excluded=decide(c,[],[{id:'R1',status:'supported',field:'title',quote:'UPI'},{id:'R2',status:'mismatch',field:'channel',quote:'ABP NEWS'}]);
 assert.equal(excluded.status,'excluded');
 const unknown=decide(c,[],[]);
 assert.equal(unknown.status,'uncertain');
 assert.deepEqual(unknown.unconfirmed,['R1']);
});

test('the judge is told to prefer official or canonical copies, and that an unknown exclusion does not lower a score',async()=>{
 const {ModelJudge}=await import('../src/judge.js');
 const {testConfig}=await import('./helpers.js');
 let system='';
 const client={models:['m'],async json(_bucket:string,s:string){system=s;return {model:'m',value:{verdicts:[]}};}} as any;
 await new ModelJudge(client,testConfig).judge('q',[{key:'c1',kind:'video',site:'youtube.com',title:'t',channel:null,official:false,duration:null,live:null,description:null,comments:[],moments:[],discussions:[]}]);
 assert.match(system,/official or canonical/i);
 assert.match(system,/re-upload, mirror, excerpt, compilation or re-edit of the same work scores at most 7/);
 assert.match(system,/unknown exclusion must not lower the score/i);
 assert.doesNotMatch(system,/For film or TV scene requests, prefer candidates marked official\./);
});
