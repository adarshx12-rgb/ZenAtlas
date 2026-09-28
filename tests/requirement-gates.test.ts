import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enforceRequirements, type JudgeCandidate, type JudgeContext, type Verdict} from '../src/judge.js';
import {completeContract, judgeRequirements} from '../src/search-contract.js';
import {rulesContract, hardEach, DRAFT_INSTRUCTION} from '../src/requirements.js';

const DAY='2026-09-28';
// The 5:15 Hindi explainer from the 2026-09-27 reworded probe: every requirement but the channel exclusion was grounded.
const upi=(description_source:'api'|'search'='api'):JudgeCandidate=>({key:'u',kind:'video',site:'youtube.com',url:'https://www.youtube.com/watch?v=x',
 title:'UPI क्या है? | Unified Payments Interface पूरी जानकारी हिंदी में',channel:'Computer Academy',official:false,duration:'5:15',live:null,
 description:'UPI कैसे काम करता है?',description_source,comments:[],moments:[],discussions:[],
 transcripts:[{start:0,end:9,text:'नमस्ते। अच्छा कभी सोचा है कि भारत में पेमेंट इतनी जल्दी कैसे हो जाती है?'}],
 facts:[{id:'R1',status:'supported',field:'facts',quote:'5:15'}]});
const reqs:NonNullable<JudgeContext['requirements']>=[
 {id:'R1',text:'Duration below 10 min',evidence:'Platform duration',kind:'duration'},
 {id:'R2',text:'Hindi language',evidence:'Speech',kind:'property'},
 {id:'R3',text:'Not a mainstream news channel',evidence:'Channel identity',kind:'property',polarity:'exclude'}];
const checked=(extra:Verdict['requirementChecks']=[]):Verdict=>({key:'u',relevance:9,reason:'Hindi UPI explainer.',momentKeys:[],requirementChecks:[
 {id:'R1',status:'supported',field:'facts',quote:'5:15'},
 {id:'R2',status:'supported',field:'transcripts',quote:'भारत में पेमेंट इतनी जल्दी'},
 {id:'R3',status:'unknown',field:'',quote:''},...extra]});

test('an unchecked content exclusion leaves a result shown, naming the open question',()=>{
 const out=enforceRequirements(upi(),checked(),reqs);
 assert.equal(out.relevance,9);
 assert.match(out.reason,/Not checked: Not a mainstream news channel/);
});

test('an exclusion contradicted by grounded evidence still rejects',()=>{
 const c={...upi(),comments:['This is an Aaj Tak news bulletin']};
 const v=checked();v.requirementChecks![2]={id:'R3',status:'mismatch',field:'comments',quote:'Aaj Tak news bulletin'};
 assert.ok(enforceRequirements(c,v,reqs).relevance<=4);
});

test('a provenance exclusion stays strict when unchecked',()=>{
 const strict=reqs.map(r=>r.id==='R3'?{...r,text:'not AI-generated',evidence_kind:'provenance' as const}:r);
 assert.equal(enforceRequirements(upi(),checked(),strict).relevance,5);
});

test('support only from a title or search snippet counts as weak evidence, not none',()=>{
 const subject=[{id:'R4',text:'Explains how UPI works',evidence:'Content',kind:'subject'}];
 const all=[...reqs,...subject];
 const byTitle=enforceRequirements(upi(),checked([{id:'R4',status:'supported',field:'title',quote:'Unified Payments Interface'}]),all);
 assert.equal(byTitle.relevance,6);
 assert.match(byTitle.reason,/title or search snippet/);
 const bySnippet=enforceRequirements(upi('search'),checked([{id:'R4',status:'supported',field:'description',quote:'UPI कैसे काम करता है?'}]),all);
 assert.equal(bySnippet.relevance,6);
 const byApi=enforceRequirements(upi('api'),checked([{id:'R4',status:'supported',field:'description',quote:'UPI कैसे काम करता है?'}]),all);
 assert.equal(byApi.relevance,9);
});

test('a truly unknown hard requirement still caps at 5',()=>{
 const all=[...reqs,{id:'R4',text:'Explains how UPI works',evidence:'Content',kind:'subject'}];
 assert.equal(enforceRequirements(upi(),checked([{id:'R4',status:'unknown',field:'',quote:''}]),all).relevance,5);
});

test('the planner marks negated requirements as exclusions, except provenance',()=>{
 const q='hindi explainer on how UPI works, under 10 minutes, not from big news channels';
 const c=completeContract(rulesContract(q,DAY,{requirements:[
   {text:'how UPI works',source_quote:'how UPI works',kind:'subject',hardness:'hard',scope:'each',evidence:''},
   {text:'Not from big news channels',source_quote:'not from big news channels',kind:'property',hardness:'hard',scope:'each',evidence:''}]}),'videos');
 const news=c.requirements.find(r=>/news/.test(r.text))!;
 assert.equal(news.polarity,'exclude');
 assert.equal(judgeRequirements(c).find(r=>r.id===news.id)!.polarity,'exclude');
 assert.equal(c.requirements.find(r=>r.text==='how UPI works')!.polarity,undefined);
 const images=completeContract(rulesContract('bicycle not AI-generated',DAY),'images');
 assert.ok(images.requirements.filter(r=>/AI/.test(r.text)).every(r=>r.polarity===undefined));
});

test('a bare year names the event and is not its own hard requirement',()=>{
 const q='clip from the first Falcon Heavy launch in 2018 where the two side boosters touch down together';
 const c=completeContract(rulesContract(q,DAY,{requirements:[
   {text:'first Falcon Heavy launch',source_quote:'first Falcon Heavy launch',kind:'subject',hardness:'hard',scope:'each',evidence:''},
   {text:'2018',source_quote:'2018',kind:'subject',hardness:'hard',scope:'each',evidence:''},
   {text:'two side boosters touch down together',source_quote:'two side boosters touch down together',kind:'subject',hardness:'hard',scope:'each',evidence:''}]}),'videos');
 assert.ok(!hardEach(c).some(r=>r.text==='2018'));
 assert.match(c.requirements.find(r=>/first Falcon Heavy/.test(r.text))!.text,/2018/,'the year stays attached to the event');
});

test('a query clause restating an existing requirement is not added again',()=>{
 const q='clip from the first Falcon Heavy launch in 2018 where the two side boosters touch down together';
 const c=completeContract(rulesContract(q,DAY,{requirements:[
   {text:'first Falcon Heavy launch',source_quote:'first Falcon Heavy launch',kind:'subject',hardness:'hard',scope:'each',evidence:''},
   {text:'two side boosters touch down together',source_quote:'two side boosters touch down together',kind:'subject',hardness:'hard',scope:'each',evidence:''}]}),'videos');
 assert.ok(!c.requirements.some(r=>r.text==='where the two side boosters touch down together'));
});

test('the planner is told to write requirements in English and keep years with their event',()=>{
 assert.match(DRAFT_INSTRUCTION,/in English/);
 assert.match(DRAFT_INSTRUCTION,/year/);
});

test('the final decision verifies a result whose only open requirement is a content exclusion',async()=>{
 const {decide}=await import('../src/evidence.js');
 const q='hindi explainer on how UPI works, not from big news channels';
 const c=completeContract(rulesContract(q,DAY,{requirements:[
   {text:'how UPI works',source_quote:'how UPI works',kind:'subject',hardness:'hard',scope:'each',evidence:''},
   {text:'Not from big news channels',source_quote:'not from big news channels',kind:'property',hardness:'hard',scope:'each',evidence:''}]}),'videos');
 const subject=c.requirements.find(r=>r.text==='how UPI works')!,news=c.requirements.find(r=>r.polarity==='exclude')!;
 const open=decide(c,[],[{id:subject.id,status:'supported',field:'transcripts',quote:'UPI'}]);
 assert.equal(open.status,'verified');
 assert.ok(open.notes.some(n=>/Could not check: Not from big news channels/.test(n)));
 const contradicted=decide(c,[],[{id:subject.id,status:'supported',field:'transcripts',quote:'UPI'},{id:news.id,status:'mismatch',field:'comments',quote:'Aaj Tak'}]);
 assert.equal(contradicted.status,'excluded');
 const unknownSubject=decide(c,[],[]);
 assert.equal(unknownSubject.status,'uncertain');
});

test('an unconfirmed requirement caps a score at 5 but never raises a rejection to it',()=>{
 const open:Verdict['requirementChecks']=[{id:'R1',status:'unknown',field:'',quote:''},{id:'R2',status:'unknown',field:'',quote:''},{id:'R3',status:'unknown',field:'',quote:''}];
 const c={...upi(),facts:[]};
 assert.equal(enforceRequirements(c,{key:'u',relevance:2,reason:'English, not Hindi.',momentKeys:[],requirementChecks:open},reqs).relevance,2);
 assert.equal(enforceRequirements(c,{key:'u',relevance:9,reason:'Hindi UPI explainer.',momentKeys:[],requirementChecks:open},reqs).relevance,5);
});

test('a rejection citing real metadata the gate cannot use keeps its low score',()=>{
 const c={...upi(),facts:[],channel:'ABP NEWS'};
 const v:Verdict={key:'u',relevance:3,reason:'From ABP News.',momentKeys:[],requirementChecks:[{id:'R1',status:'unknown',field:'',quote:''},
  {id:'R2',status:'unknown',field:'',quote:''},{id:'R3',status:'mismatch',field:'facts',quote:'ABP NEWS'}]};
 assert.equal(enforceRequirements(c,v,reqs).relevance,3);
 const made={...v,requirementChecks:[...v.requirementChecks!.slice(0,2),{id:'R3',status:'mismatch' as const,field:'facts',quote:'Aaj Tak'}]};
 assert.equal(enforceRequirements(c,made,reqs).relevance,5);
});

test('re-applying the gate does not repeat the open-exclusion note',()=>{
 const once=enforceRequirements(upi(),checked(),reqs);
 assert.equal(enforceRequirements(upi(),once,reqs).reason,once.reason);
});
