import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ModelJudge,type JudgeCandidate} from '../src/judge.js';
import type {ModelClient} from '../src/model-client.js';
import {testConfig} from './helpers.js';

const candidate:JudgeCandidate={key:'r1',kind:'website',site:'www.smithsonianmag.com',url:'https://www.smithsonianmag.com/roswell',
 title:'What really happened at Roswell',channel:null,official:false,duration:null,live:null,description:null,comments:[],moments:[],discussions:[],
 page:{status:'checked',title:'What really happened at Roswell',description:null,text:'In July 1947 a rancher found debris near Roswell, New Mexico.',libraries:[],screenshot:false}};
const intent=['subject','intent','relationship','format'].map(dimension=>({dimension,status:'supported',field:'page',quote:'debris near Roswell'}));
const requirements=[{id:'R1',text:'Is an article',evidence:'page type'},{id:'R2',text:'About the 1947 Roswell incident',evidence:'describes the incident'}];

test('the judge checks each shared requirement by ID, and an unquoted "supported" counts as unknown',async()=>{
 let seen:{system:string;text:string;schema:any}|undefined;
 const client={models:['fixture'],json:async(_b:string,system:string,text:string,schema:any)=>{seen={system,text,schema};
   return {model:'fixture',value:{verdicts:[{key:'r1',relevance:8,reason:'Describes the incident',moment_keys:[],lesser_known:false,intent_checks:intent,
     requirement_checks:[{id:'R1',status:'supported',field:'title',quote:'this is an article'},{id:'R2',status:'supported',field:'page',quote:'In July 1947 a rancher found debris'},
       {id:'R9',status:'supported',field:'title',quote:'Roswell'}]}]}};}} as unknown as ModelClient;
 const out=await new ModelJudge(client,testConfig).judge('rosswell ufo incident real article',[candidate],{kind:'mixed',criteria:[],requirements});
 assert.deepEqual(seen!.schema.properties.verdicts.items.properties.requirement_checks.items.properties.id.enum,['R1','R2']);
 assert.match(seen!.text,/Requirements: .*"R1"/);
 assert.match(seen!.system,/requirement_checks/);
 const v=out.verdicts.get('r1')!;
 assert.deepEqual(v.requirementChecks,[{id:'R1',status:'unknown',field:'title',quote:'this is an article'},
   {id:'R2',status:'supported',field:'page',quote:'In July 1947 a rancher found debris'}],'invented quotes and unknown IDs are not evidence');
 assert.equal(v.relevance,5,'an unsupported hard requirement caps even a confident intent match');
});

test('without requirements the judge asks exactly what it asked before',async()=>{
 let schema:any;
 const client={models:['fixture'],json:async(_b:string,_s:string,_t:string,s:any)=>{schema=s;
   return {model:'fixture',value:{verdicts:[{key:'r1',relevance:6,reason:'x',moment_keys:[],lesser_known:false,intent_checks:intent}]}};}} as unknown as ModelClient;
 const out=await new ModelJudge(client,testConfig).judge('roswell',[candidate],{kind:'videos',criteria:[]});
 assert.equal(schema.properties.verdicts.items.properties.requirement_checks,undefined);
 assert.equal(out.verdicts.get('r1')!.requirementChecks,undefined);
});

test('the judge is told never to reveal the name lead or linked sites in the reason searchers see',async()=>{
 let system='';
 const client={models:['m'],async json(_b:string,s:string){system=s;return {model:'m',value:{verdicts:[{key:'r1',relevance:7,reason:'r',moment_keys:[],lesser_known:false}]}};}} as unknown as ModelClient;
 await new ModelJudge(client,testConfig).judge('roswell',[{...candidate,linked_from:['news.example.org']}],{kind:'videos',criteria:[],identified:['Roswell']});
 assert.match(system,/never mention[^.]*(Likely refers to|linked_from)/i);
});

test('the judge is told how creators word the request, so "fan" can satisfy "subscriber"',async()=>{
 let text='';
 const client={models:['m'],async json(_b:string,_s:string,t:string){text=t;return {model:'m',value:{verdicts:[{key:'r1',relevance:7,reason:'r',moment_keys:[],lesser_known:false}]}};}} as unknown as ModelClient;
 await new ModelJudge(client,testConfig).judge('mr beast giving ps5 to his subscriber',[candidate],{kind:'videos',criteria:[],wording:[{request:'subscriber',creators:['fan','viewer']}]} as any);
 assert.match(text,/subscriber/);assert.match(text,/"fan"/);assert.match(text,/same thing unless the request insists/i);
});
