import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {ruleMode, chooseMode, clearModeCache, type ModeDeps} from '../src/mode-router.js';

const db={} as any;
const config={...testConfig,MODE_JEV_CONFIDENCE:0.7,MODE_ROUTER_TIMEOUT_MS:300};
const quiet={log:()=>{}};

test('rules: a format the query names decides the mode; conflicting or no format words decide nothing',()=>{
 assert.equal(ruleMode('funny cat videos'),'videos');
 assert.equal(ruleMode('messi goal clip 2022'),'videos');
 assert.equal(ruleMode('mountain sunset wallpapers 4k'),'images');
 assert.equal(ruleMode('photos of the eiffel tower at night'),'images');
 assert.equal(ruleMode('income tax form 16 pdf'),'docs');
 assert.equal(ruleMode('attention is all you need research paper'),'docs');
 assert.equal(ruleMode('ncert physics class 12 ebook'),'docs');
 assert.equal(ruleMode('best websites for learning japanese'),'web');
 assert.equal(ruleMode('latest news on the mars mission'),'web');
 assert.equal(ruleMode('video editing websites'),null,'two modes named: not a rule decision');
 assert.equal(ruleMode('how does photosynthesis work'),null);
 assert.equal(ruleMode('toilet paper price'),null,'"paper" alone is not a document request');
});

test('rules decide without asking any model',async()=>{
 clearModeCache();
 const deps:ModeDeps={...quiet,jev:async()=>{throw new Error('not asked');},model:async()=>{throw new Error('not asked');}};
 assert.deepEqual(await chooseMode(db,config,'cat videos',deps),{mode:'videos',source:'rules',confidence:null});
});

test('Jev decides when confident; otherwise the fallback model decides',async()=>{
 clearModeCache();
 const asked:string[]=[];
 const deps=(confidence:number):ModeDeps=>({...quiet,jev:async()=>{asked.push('jev');return {choice:'web',confidence};},model:async()=>{asked.push('model');return 'docs';}});
 assert.deepEqual(await chooseMode(db,config,'how does photosynthesis work',deps(0.9)),{mode:'web',source:'jev',confidence:0.9});
 assert.deepEqual(asked,['jev']);
 assert.deepEqual(await chooseMode(db,config,'manorama yearbook 2018',deps(0.5)),{mode:'docs',source:'model',confidence:null});
 assert.deepEqual(asked,['jev','jev','model']);
});

test('Jev failing goes to the model; both failing, or too slow, stays on videos',async()=>{
 clearModeCache();
 const fail=async()=>{throw new Error('down');};
 assert.deepEqual(await chooseMode(db,config,'q one',{...quiet,jev:fail,model:async()=>'images'}),{mode:'images',source:'model',confidence:null});
 assert.deepEqual(await chooseMode(db,config,'q two',{...quiet,jev:fail,model:fail}),{mode:'videos',source:'default',confidence:null});
 const started=Date.now();
 const hang=()=>new Promise<never>(()=>{});
 assert.deepEqual(await chooseMode(db,config,'q three',{...quiet,jev:hang,model:hang}),{mode:'videos',source:'default',confidence:null});
 assert.ok(Date.now()-started<1000,'the time limit covers every step');
 assert.equal((await chooseMode(db,{...config,MODE_ROUTER_ENABLED:false},'q four',{...quiet,jev:async()=>({choice:'web',confidence:1})})).source,'default');
});

test('answers are cached per query (case and spacing ignored); only decisions from a model or rules, never the fallback',async()=>{
 clearModeCache();
 let calls=0;
 const deps:ModeDeps={...quiet,jev:async()=>{calls++;return {choice:'web',confidence:0.95};}};
 await chooseMode(db,config,'How does  photosynthesis work',deps);
 await chooseMode(db,config,'how does photosynthesis work',deps);
 assert.equal(calls,1);
 let fails=0;
 const failing:ModeDeps={...quiet,jev:async()=>{fails++;throw new Error('x');},model:async()=>{throw new Error('x');}};
 await chooseMode(db,config,'uncached query',failing);await chooseMode(db,config,'uncached query',failing);
 assert.equal(fails,2,'a fallback answer is not cached');
});

test('one log line per decision: which step decided, never the query',async()=>{
 clearModeCache();
 const lines:any[]=[];
 await chooseMode(db,config,'secret words',{log:l=>lines.push(l),jev:async()=>({choice:'images',confidence:0.8})});
 assert.deepEqual(lines,[{event:'mode_route',mode:'images',source:'jev',confidence:0.8}]);
});

test('the Jev request carries the query as state and the four modes; Jev gets half the time limit',async()=>{
 const {modeDeps}=await import('../src/mode-router.js');
 const sent:any[]=[];
 const transport=(async(url:string,options:any)=>{sent.push({url,options});return {model:'jev',answers:{mode:{type:'choice',choice:'docs',confidence:0.82}}};}) as any;
 const db={async query(){return {rows:[{used:1}]};}} as any;
 const deps=modeDeps(db,{...config,OPENROUTER_API_KEY:'k',MODE_ROUTER_TIMEOUT_MS:3000},transport);
 assert.deepEqual(await deps.jev!('annual report 2018'),{type:'choice',choice:'docs',confidence:0.82});
 assert.match(sent[0].url,/\/alpha\/decisions$/);
 assert.deepEqual(Object.keys(sent[0].options.body.questions.mode.criteria),['videos','web','images','docs']);
 assert.equal(sent[0].options.body.state.request,'annual report 2018');
 assert.equal(sent[0].options.timeoutMs,1500);
 assert.ok(deps.model,'the fallback model is configured by default');
});
