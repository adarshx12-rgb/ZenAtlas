import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {identify, grounded, clearIdentifyCache} from '../src/identify.js';

const db={} as any;
const config={...testConfig,IDENTIFY_TIMEOUT_MS:300};
const answer=(value:unknown)=>({model:async()=>value,log:()=>{}});
const material=[
 {title:'Free Solo | Official Trailer | National Geographic',description:'Alex Honnold attempts to climb El Capitan without a rope.',creator:'National Geographic'},
 {title:'Alex Honnold climbs El Capitan without ropes',description:null,creator:'Climbing Daily'},
];

test('a name is grounded only when every word of it appears in one result',()=>{
 assert.ok(grounded('Free Solo',material));
 assert.ok(grounded('Alex Honnold',material));
 assert.ok(!grounded('The Dawn Wall',material),'a name the results never mention');
 assert.ok(!grounded('Free Solo Honnold Capitan Nat Geo',material),'words spread over results, some missing');
 assert.ok(!grounded('the',material),'no content words');
});

test('a known item comes back with grounded names and searches that use them',async()=>{
 clearIdentifyCache();
 const out=await identify(db,config,'documentary about the guy who climbed El Capitan without ropes',material,answer({kind:'known_item',confidence:0.9,
   names:['Free Solo','The Dawn Wall','Free Solo | Official Trailer | National Geographic'],searches:['Free Solo full documentary','Dawn Wall documentary','El Capitan climbing films']}));
 assert.deepEqual(out,{kind:'known_item',confidence:0.9,names:['Free Solo'],searches:['Free Solo full documentary']});
});

test('exploratory requests keep no searches; a known item without a grounded name is not confident',async()=>{
 clearIdentifyCache();
 const open=await identify(db,config,'underrated osint tools',material,answer({kind:'exploratory',confidence:0.8,names:[],searches:['osint tools list']}));
 assert.deepEqual(open,{kind:'exploratory',confidence:0.8,names:[],searches:[]});
 clearIdentifyCache();
 const unnamed=await identify(db,config,'that climbing film',material,answer({kind:'known_item',confidence:0.95,names:['Meru'],searches:['Meru documentary']}));
 assert.deepEqual(unnamed,{kind:'known_item',confidence:0,names:[],searches:[]});
});

test('failures, slow or malformed replies give null and are not cached',async()=>{
 clearIdentifyCache();
 const lines:unknown[]=[];
 assert.equal(await identify(db,config,'q one',material,{model:async()=>{throw new Error('down');},log:l=>lines.push(l)}),null);
 assert.equal(await identify(db,config,'q one',material,{model:()=>new Promise(r=>setTimeout(()=>r({}),1000)),log:()=>{}}),null);
 assert.equal(await identify(db,config,'q one',material,answer({kind:'maybe'})),null);
 const ok=await identify(db,config,'q one',material,answer({kind:'exploratory',confidence:0.5,names:[],searches:[]}));
 assert.equal(ok?.kind,'exploratory');
 assert.deepEqual(lines.map((l:any)=>l.outcome),['failed']);
});

test('switched off, or with no results to read, nothing is asked',async()=>{
 clearIdentifyCache();
 let asked=0;const model=async()=>{asked++;return {kind:'exploratory',confidence:1,names:[],searches:[]};};
 assert.equal(await identify(db,{...config,IDENTIFY_ENABLED:false},'q',material,{model,log:()=>{}}),null);
 assert.equal(await identify(db,config,'q',[],{model,log:()=>{}}),null);
 assert.equal(asked,0);
});
