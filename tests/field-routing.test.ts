import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {cleanSite,routeFields,learnFieldSources,clearRouteCache,learningField,learnedSites} from '../src/field-routing.js';

const config={...testConfig,FIELD_ROUTING_ENABLED:true,FIELD_ROUTING_SITES:2,QUERY_REWRITE_TIMEOUT_MS:1000} as any;

test('a named site is a bare, real-looking domain that is neither a general platform nor a blocked host',()=>{
 assert.equal(cleanSite('https://www.RBI.org.in/Scripts/x.aspx'),'rbi.org.in');
 assert.equal(cleanSite('huggingface.co'),'huggingface.co');
 assert.equal(cleanSite('youtube.com'),null,'a video platform the normal searches already cover');
 assert.equal(cleanSite('en.wikipedia.org'),null);
 assert.equal(cleanSite('libgen.is'),null,'a shadow library is never searched');
 assert.equal(cleanSite('not a domain'),null);
 assert.equal(cleanSite('localhost'),null);
});

test('sites learned for the field come first, the model\'s fill the rest, and invalid ones are dropped',async()=>{
 const db=await database();
 try{
   clearRouteCache();
   for(let i=0;i<3;i++) await learnFieldSources(db,'finance',[{url:'https://www.rbi.org.in/a',relevance:9}]);
   await learnFieldSources(db,'finance',[{url:'https://spam-rates.example/x',relevance:9},{url:'https://spam-rates.example/y',relevance:2}]);
   const route=await routeFields(db,config,'current RBI repo rate','web',{log:()=>{},model:async()=>({field:'finance',sites:['youtube.com','cleartax.in','rbi.org.in']})});
   assert.deepEqual(route,{field:'finance',sites:['rbi.org.in','cleartax.in'],learned:['rbi.org.in']});
   const counts=(await db.query("SELECT domain,good,poor FROM field_sources WHERE field='finance' ORDER BY domain")).rows;
   assert.deepEqual(counts,[{domain:'rbi.org.in',good:3,poor:0},{domain:'spam-rates.example',good:1,poor:0}],
     'one count per site and search: a page judged good and another judged poor counts once, as good');
 }finally{await db.close();}
});

test('routing is off by default, skips site-scoped requests, and a failing model means no route',async()=>{
 const db=await database();
 try{
   clearRouteCache();
   let called=0;const model=async()=>{called++;return {field:'finance',sites:['rbi.org.in']};};
   assert.deepEqual(await routeFields(db,testConfig,'repo rate','web',{log:()=>{},model}),{field:null,sites:[],learned:[]});
   assert.deepEqual((await routeFields(db,config,'repo rate site:rbi.org.in','web',{log:()=>{},model})).sites,[]);
   assert.equal(called,0);
   assert.deepEqual(await routeFields(db,config,'repo rate today','web',{log:()=>{},model:async()=>{throw new Error('down');}}),{field:null,sites:[],learned:[]});
   assert.deepEqual(await routeFields(db,config,'some other thing','web',{log:()=>{},model:async()=>({field:'not-a-field',sites:['rbi.org.in']})}),
     {field:null,sites:['rbi.org.in'],learned:[]},'an unknown field still searches its sites but teaches nothing');
 }finally{await db.close();}
});

test('images learn their sites apart from the other tabs: a good article site is not a good picture archive',async()=>{
 const db=await database();
 try{
   clearRouteCache();
   for(let i=0;i<2;i++) await learnFieldSources(db,learningField('nature','web'),[{url:'https://articles.example/a',relevance:9}]);
   for(let i=0;i<2;i++) await learnFieldSources(db,learningField('nature','images'),[{url:'https://pictures.example/a',relevance:9}]);
   const route=await routeFields(db,config,'snow leopard photo','images',{log:()=>{},model:async()=>({field:'nature',sites:['wild.example']})});
   assert.deepEqual(route,{field:'nature',sites:['pictures.example','wild.example'],learned:['pictures.example']});
   assert.equal(learningField(null,'images'),null);
 }finally{await db.close();}
});

test('claim-supported source history is separate from relevance and helps route Web answers',async()=>{
 const db=await database();
 try{
   clearRouteCache();
   for(let i=0;i<2;i++)await learnFieldSources(db,'answer_science',[{url:'https://primary.example/report',relevance:9}]);
   assert.deepEqual(await learnedSites(db,'science',4),[]);
   const route=await routeFields(db,config,'solar efficiency','web',{log:()=>{},model:async()=>({field:'science',sites:['secondary.example']})});
   assert.deepEqual(route.sites,['primary.example','secondary.example']);
   const images=await routeFields(db,config,'solar diagram','images',{log:()=>{},model:async()=>({field:'science',sites:[]})});
   assert.deepEqual(images.sites,[]);
 }finally{await db.close();}
});
