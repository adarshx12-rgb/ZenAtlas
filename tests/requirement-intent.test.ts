import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeContract} from '../src/search-contract.js';
import {rulesContract, hardEach, DRAFT_INSTRUCTION} from '../src/requirements.js';
import {applySceneVerdict} from '../src/scene-verification.js';
import type {JudgeCandidate, Verdict} from '../src/judge.js';

const DAY='2026-09-29';
const req=(text:string,kind:'subject'|'property',hardness:'hard'|'preferred'='hard')=>({text,source_quote:text,kind,hardness,scope:'each' as const,evidence:''});

test('properties only watching can confirm are preferred unless the request insists; subjects stay hard',()=>{
 const q='video of a cat knocking a glass off a table in slow motion';
 const c=completeContract(rulesContract(q,DAY,{requirements:[req('cat knocks a glass off a table','subject'),req('in slow motion','property')]}),'videos');
 assert.deepEqual(hardEach(c).filter(r=>r.kind!=='format').map(r=>r.text),['cat knocks a glass off a table']);
 assert.equal(c.requirements.find(r=>r.text==='in slow motion')!.hardness,'preferred');
 const insist=completeContract(rulesContract('cat knocking a glass off a table, must be in slow motion',DAY,
   {requirements:[req('cat knocks a glass off a table','subject'),req('in slow motion','property')]}),'videos');
 assert.equal(insist.requirements.find(r=>r.text==='in slow motion')!.hardness,'hard','"must" keeps it hard');
 const music=completeContract(rulesContract('bicycle seatpost removal with heat, exclude background music',DAY,
   {requirements:[req('removes a stuck seatpost using heat','subject'),req('Not background music','property')]}),'videos');
 assert.equal(music.requirements.find(r=>/music/.test(r.text))!.hardness,'preferred');
});

test('the planner is told to keep the intent and accept equivalent wording',()=>{
 assert.match(DRAFT_INSTRUCTION,/equivalent/i);
 assert.match(DRAFT_INSTRUCTION,/gives/);
 assert.match(DRAFT_INSTRUCTION,/only watching/i);
});

const candidate:JudgeCandidate={key:'r1',kind:'video',site:'youtube.com',url:'https://www.youtube.com/watch?v=aaaaaaaaaaa',title:'Free Solo - Trailer',
 channel:'National Geographic',official:true,duration:'2:30',live:null,description:null,comments:[],moments:[],discussions:[]};
const result:any={id:'x',title:'Free Solo - Trailer',canonical_url:candidate.url,moments:[],badges:[],evidence:'metadata_match'};
const plan:any={deadline:new Date().toISOString(),context:{kind:'videos',criteria:[]},entries:[]};
const verdict=(dimension:'subject'|'format',relevance=3):Verdict=>({key:'r1',relevance,reason:'A trailer for the documentary, not the film itself',momentKeys:[],
 intentChecks:(['subject','intent','relationship','format'] as const).map(d=>({dimension:d,status:d===dimension?'mismatch' as const:'supported' as const,field:'title' as const,quote:'Free Solo - Trailer'}))});

test('a scene re-check that disputes only the format keeps the video as a closest match; a wrong subject removes it',()=>{
 const format=applySceneVerdict(result,candidate,verdict('format'),'m',plan,[],[]);
 assert.equal(format.verified,false);
 assert.equal(format.excluded,false,'a trailer of the right documentary stays visible as a closest match');
 assert.match(format.result.judgement!.reason,/trailer/i,'with the reason it was not verified');
 assert.equal(applySceneVerdict(result,candidate,verdict('subject'),'m',plan,[],[]).excluded,true);
 assert.equal(applySceneVerdict(result,candidate,verdict('format',1),'m',plan,[],[]).excluded,true,'a near-zero score still goes');
});

test('the judge is told which properties are only preferences, so their absence never makes intent unknown',async()=>{
 const {ModelJudge}=await import('../src/judge.js');
 const {testConfig}=await import('./helpers.js');
 let system='',text='';
 const client:any={models:['m'],async json(_b:string,s:string,t:string){system=s;text=t;return {model:'m',value:{verdicts:[]}};}};
 const ctx={kind:'videos' as const,criteria:[],preferences:['in slow motion']};
 await new ModelJudge(client,testConfig).judge('video of a cat knocking a glass off a table in slow motion',[candidate],ctx).catch(()=>{});
 assert.match(text,/Preferences: \["in slow motion"\]/);
 assert.match(system,/preferences/i);
 await new ModelJudge(client,testConfig).judge('q',[candidate],{kind:'videos',criteria:[]}).catch(()=>{});
 assert.doesNotMatch(text,/Preferences:/,'no preferences, no line');
});

test('preferred requirements reach the judge context as preferences',async()=>{
 const {preferencesOf}=await import('../src/search-contract.js');
 const c=completeContract(rulesContract('video of a cat knocking a glass off a table in slow motion',DAY,{requirements:[req('cat knocks a glass off a table','subject'),req('in slow motion','property')]}),'videos');
 assert.deepEqual(preferencesOf(c),['in slow motion']);
});
