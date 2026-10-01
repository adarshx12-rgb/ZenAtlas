import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchSearXNG} from '../src/providers.js';
import {UpstreamError} from '../src/http.js';
import {testConfig} from './helpers.js';

test('a CAPTCHA pauses queued queries for only that engine and allows a probe after cooldown',async t=>{
 t.mock.timers.enable({apis:['Date']});
 const config={...testConfig,SEARXNG_BASE_URL:'http://captcha.test',SEARXNG_BLOCK_COOLDOWN_SECONDS:60};
 const calls:string[]=[];
 let captcha=true;
 const transport=async(url:string)=>{
   const engine=new URL(url).searchParams.get('engines')!;calls.push(engine);
   return engine==='blocked'&&captcha ? {results:[],unresponsive_engines:[['blocked','Suspended: CAPTCHA']]}
     : {results:[{url:`https://example.org/${engine}`,title:'Useful source'}]};
 };
 const [a,b]=await Promise.all(['first','second'].map(query=>searchSearXNG(config,{query,engines:['blocked','healthy']},transport)));
 assert.equal(calls.filter(e=>e==='blocked').length,1,'the queued query does not repeat the blocked request');
 assert.equal(calls.filter(e=>e==='healthy').length,2);
 assert.equal(a.results.length,1);assert.equal(b.results.length,1);
 assert.match(b.status.message,/CAPTCHA; cooling down until/);
 captcha=false;t.mock.timers.tick(60001);
 const recovered=await searchSearXNG(config,{query:'third',engines:['blocked']},transport);
 assert.equal(recovered.status.status,'ok');assert.equal(recovered.results.length,1);
 assert.equal(calls.filter(e=>e==='blocked').length,2);
});

test('HTTP rate limits and access refusals are not retried and are shared across callers',async()=>{
 for(const [code,status]of [['rate_limited',429],['upstream_failure',403]] as const){
   const config={...testConfig,SEARXNG_BASE_URL:`http://refusal-${status}.test`};let calls=0;
   const transport=async()=>{calls++;throw new UpstreamError(code,status);};
   const a=await searchSearXNG(config,{query:'video',engines:['google']},transport);
   const b=await searchSearXNG({...config},{query:'document',engines:['google'],safeSearch:'2'},transport);
   assert.equal(calls,1);assert.equal(a.status.status,'partial');
   assert.match(b.status.message,/cooling down/);
 }
});

test('JSON-reported HTTP refusals also pause the affected engine',async()=>{
 for(const [code,reason]of [['429','rate-limited'],['403','access denied']]){
   const config={...testConfig,SEARXNG_BASE_URL:`http://payload-${code}.test`};let calls=0;
   const transport=async()=>{calls++;return {results:[],unresponsive_engines:[['google',`HTTP error [${code}]`]]};};
   await searchSearXNG(config,{query:'a',engines:['google']},transport);
   const second=await searchSearXNG(config,{query:'b',engines:['google']},transport);
   assert.equal(calls,1);assert.ok(second.status.message.includes(`${reason}; cooling down`));
 }
});

test('per-engine pacing spaces requests without serializing independent engines',async()=>{
 const config={...testConfig,SEARXNG_BASE_URL:'http://pacing.test',SEARXNG_MIN_INTERVAL_MS:40};
 const calls:{engine:string;at:number}[]=[];
 const transport=async(url:string)=>{calls.push({engine:new URL(url).searchParams.get('engines')!,at:Date.now()});return {results:[]};};
 await Promise.all(['a','b'].map(query=>searchSearXNG(config,{query,engines:['one','two']},transport)));
 for(const engine of ['one','two']){
   const times=calls.filter(c=>c.engine===engine).map(c=>c.at);
   assert.equal(times.length,2);assert.ok(times[1]-times[0]>=35,'leave a gap between requests');
 }
 assert.deepEqual(new Set(calls.slice(0,2).map(c=>c.engine)),new Set(['one','two']));
});

test('queue deadlines return promptly and expired queued work never sends a request',async()=>{
 const config={...testConfig,SEARXNG_BASE_URL:'http://queue-deadline.test',SEARXNG_SEARCH_TIMEOUT_MS:1000};
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;
 const transport=async()=>{calls++;await gate;return {results:[]};};
 const first=searchSearXNG(config,{query:'first',engines:['busy']},transport);
 try{
   const second=await searchSearXNG(config,{query:'second',engines:['busy'],deadline:Date.now()+30},transport);
   assert.match(second.status.message,/deadline/);assert.equal(calls,1);
 }finally{release();}
 await first;
 await new Promise(r=>setImmediate(r));
 assert.equal(calls,1,'no late request after the occupied lane becomes free');
});

test('slow engines have a total deadline while healthy engines retain results and strict search parameters',async()=>{
 const config={...testConfig,SEARXNG_BASE_URL:'http://slow-deadline.test',SEARXNG_SEARCH_TIMEOUT_MS:100};
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const out=await searchSearXNG(config,{query:'notes',engines:['slow','healthy'],safeSearch:'2',language:'hi',page:'2'},async(url,options)=>{
   const p=new URL(url).searchParams;
   assert.equal(p.get('safesearch'),'2');assert.equal(p.get('language'),'hi');assert.equal(p.get('pageno'),'2');
   assert.equal(p.get('categories'),null);assert.ok(options!.timeoutMs!<=100);
   if(p.get('engines')==='slow')await gate;
   return {results:[{url:'https://example.org/notes',title:'Notes'}]};
 });
 release();
 assert.equal(out.results.length,1);assert.match(out.status.message,/Slow \(search deadline reached\)/);
});

test('engine results are interleaved with independent per-engine limits',async()=>{
 const config={...testConfig,SEARXNG_BASE_URL:'http://interleave.test'};
 const out=await searchSearXNG(config,{query:'sources',engines:['one','two'],maxResultsPerEngine:2},async url=>{
   const engine=new URL(url).searchParams.get('engines');return {results:[1,2,3].map(n=>`${engine}-${n}`)};
 });
 assert.deepEqual(out.results,['one-1','two-1','one-2','two-2']);
});
