import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transcriptChunks,musicOnly,chooseSceneWindow,chooseSceneWindows,covered} from '../src/scene-window.js';
import {testConfig} from './helpers.js';

const seg=(start:number,text:string)=>({start,end:start+8,text});
const config={...testConfig,OPENROUTER_API_KEY:'k'};
const db={async query(){return {rows:[{used:1}]};}} as any;
const webcast=[seg(10,'welcome to the falcon heavy test flight'),...Array.from({length:120},(_,i)=>seg(60+i*15,`telemetry update ${i}`)),
 seg(1740,'side boosters are coming in for landing'),seg(1760,'the falcons have landed')];

test('multiple requirements select separate original-timeline intervals with retained cue IDs',async()=>{
 const segments=webcast.map((s,i)=>({...s,id:`cue-${i}`}));
 const chunks=transcriptChunks(segments,2059);
 const requirements=[{id:'R1',text:'launch'},{id:'R2',text:'landing'}];
 const transport=(async()=>({answers:{R1:{choice:chunks[0].id,confidence:.95},R2:{choice:chunks.at(-2)!.id,confidence:.9}}})) as any;
 const windows=await chooseSceneWindows(db,config,'launch and landing',segments,2059,requirements,transport);
 assert.equal(windows.length,2);assert.deepEqual(windows.map(w=>w.requirement_ids),[['R1'],['R2']]);
 assert.ok(windows[0].end<windows[1].start);assert.ok(windows[0].cue_ids.includes('cue-0'));
 const missing=(async()=>({answers:{R1:{choice:chunks[0].id,confidence:.95},R2:{choice:'none',confidence:.99}}})) as any;
 assert.deepEqual(await chooseSceneWindows(db,config,'launch and landing',segments,2059,requirements,missing),[],
   'one unlocated requirement needs whole-video analysis');
 let calls=0;
 assert.deepEqual(await chooseSceneWindows(db,config,'dancing',[seg(0,'[Music]')],600,[],(async()=>{calls++;}) as any),[]);
 assert.equal(calls,0,'music-only tracks bypass the locator');
});

test('transcripts are cut into about 40 chunks on the video timeline, text trimmed',()=>{
 const chunks=transcriptChunks(webcast,2059);
 assert.ok(chunks.length<=40&&chunks.length>20);
 assert.equal(chunks[0]!.start,0);
 assert.ok(chunks.every(c=>c.text.length<=400&&c.end>c.start));
 assert.ok(chunks.some(c=>c.text.includes('falcons have landed')));
});

test('lyrics-free music and bracketed sound cues are not a transcript to steer by',()=>{
 assert.ok(musicOnly([seg(0,'[Music]'),seg(10,'♪ ♪'),seg(20,'[Applause]')]));
 assert.ok(!musicOnly(webcast));
});

test('Jev picks the chunk; a confident pick becomes a padded window on the video timeline',async()=>{
 let body:any;
 const transport=(async(_url:string,o:any)=>{body=o.body;const land=Object.entries(o.body.state.video.transcript).find(([,c]:any)=>c.text.includes('landed'))![0];
  return {model:'jev',answers:{window:{type:'choice',choice:land,confidence:0.9}}};}) as any;
 const w=await chooseSceneWindow(db,config,'both side boosters land at the same time',webcast,2059,transport);
 assert.ok(w&&w.start<1740&&w.end>1768&&w.end<=2059&&w.end-w.start<400,JSON.stringify(w));
 assert.ok('none' in body.questions.window.criteria,'Jev may say the transcript does not point to it');
});

test('no window for short videos, music, "none", low confidence or a failing call',async()=>{
 const pick=(choice:string,confidence:number)=>(async()=>({model:'jev',answers:{window:{type:'choice',choice,confidence}}})) as any;
 assert.equal(await chooseSceneWindow(db,config,'q',webcast.slice(0,20),300,pick('c1',0.9)),null,'short videos are analysed whole');
 assert.equal(await chooseSceneWindow(db,config,'q',[seg(0,'[Music]'),seg(900,'♪')],2000,pick('c1',0.9)),null);
 assert.equal(await chooseSceneWindow(db,config,'q',webcast,2059,pick('none',0.95)),null);
 assert.equal(await chooseSceneWindow(db,config,'q',webcast,2059,pick('c30',0.4)),null);
 assert.equal(await chooseSceneWindow(db,config,'q',webcast,2059,(async()=>{throw new Error('down');}) as any),null);
 assert.equal(await chooseSceneWindow(db,config,'q',[],2059,pick('c1',0.9)),null);
});

test('a window is covered when an earlier analysis inspected all of it',()=>{
 assert.ok(covered({start:100,end:200},[[[0,2059]]]));
 assert.ok(!covered({start:100,end:200},[[[0,150]],[[180,300]]]));
 assert.ok(!covered({start:100,end:200},[]));
});

test('probability spread over neighbouring chunks still makes a window, widened only as far as needed',async()=>{
 const probabilities:Record<string,number>={none:0.01};
 const chunks=transcriptChunks(webcast,2059);
 chunks.forEach(c=>probabilities[c.id]=0);
 const at=(i:number)=>chunks[i]!.id;
 const top=chunks.length-3;
 Object.assign(probabilities,{[at(top)]:0.52,[at(top-2)]:0.3,[at(top-3)]:0.08,[at(top-1)]:0.01});
 const transport=(async()=>({model:'jev',answers:{window:{type:'choice',choice:at(top),confidence:0.49,probabilities}}})) as any;
 const w=await chooseSceneWindow(db,config,'boosters land',webcast,2059,transport);
 assert.ok(w,'0.52 alone is below the bar, but with its neighbours it clears it');
 assert.equal(w!.start,chunks[top-2]!.start-60);
 assert.equal(w!.end,Math.min(2059,chunks[top]!.end+60));
 const flat=Object.fromEntries(chunks.map(c=>[c.id,1/chunks.length]));
 assert.equal(await chooseSceneWindow(db,config,'q',webcast,2059,(async()=>({model:'jev',answers:{window:{type:'choice',choice:at(3),confidence:0.03,probabilities:flat}}})) as any),null,
  'probability spread thinly over the whole video is not a window');
});
