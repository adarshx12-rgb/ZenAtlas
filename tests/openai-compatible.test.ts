import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {OpenAICompatibleClient} from '../src/openai-compatible.js';
import {UpstreamError} from '../src/http.js';

const config={...testConfig,OPENROUTER_API_KEY:'or-key',OPENROUTER_SITE_URL:'http://127.0.0.1:3000',OPENROUTER_SITE_NAME:'ZenAtlas'};
const SCHEMA={type:'object',properties:{ok:{type:'boolean'},items:{type:'array',items:{type:'object',
 properties:{name:{type:'string'}},required:['name']}}},required:['ok','items']};
const answer=(value:unknown)=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]});
// Each test below uses its own model name: coolingUntil in model-client.ts is module-level state shared for the whole
// file, so reusing a name would leak one test's rate-limit or cooldown into another.

test('the OpenAI-compatible client sends a strict schema, images and the OpenRouter headers',async()=>{
 const db=await database();
 try{
   let sent:any,url='';
   const transport=async(u:string,options:any)=>{url=u;sent=options;return answer({ok:true,items:[]});};
   const reply=await new OpenAICompatibleClient(db,config,['vendor/model-a:free'],transport as any)
     .json('planner_calls','be helpful','the request',SCHEMA,
       [{label:'Screenshot for candidate k1:',mimeType:'image/jpeg',data:Buffer.from('jpegbytes')}]);
   assert.deepEqual([reply.model,reply.value],['vendor/model-a:free',{ok:true,items:[]}]);
   assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
   assert.equal(sent.trustedOrigin,'https://openrouter.ai');
   assert.equal(sent.token,'or-key','the transport turns the token into an Authorization header only on the trusted origin');
   assert.deepEqual([sent.headers['HTTP-Referer'],sent.headers['X-Title']],['http://127.0.0.1:3000','ZenAtlas']);
   assert.equal(sent.body.model,'vendor/model-a:free');
   assert.deepEqual(sent.body.messages[0],{role:'system',content:'be helpful'});
   assert.deepEqual(sent.body.messages[1].content[0],{type:'text',text:'the request'});
   assert.deepEqual(sent.body.messages[1].content[1],{type:'text',text:'Screenshot for candidate k1:'});
   assert.equal(sent.body.messages[1].content[2].image_url.url,`data:image/jpeg;base64,${Buffer.from('jpegbytes').toString('base64')}`);
   // Strict structured output rejects any object schema that does not forbid extra keys, at every depth.
   const json=sent.body.response_format.json_schema;
   assert.equal(json.strict,true);
   assert.equal(json.schema.additionalProperties,false);
   assert.equal(json.schema.properties.items.items.additionalProperties,false);
   assert.deepEqual(json.schema.required,['ok','items'],'the caller\'s own schema is otherwise untouched');
   // Without images the user message stays a plain string, which every backend accepts.
   const plain=async(_u:string,options:any)=>{sent=options;return answer({ok:false,items:[]});};
   await new OpenAICompatibleClient(db,config,['vendor/model-a:free'],plain as any).json('planner_calls','s','t',SCHEMA);
   assert.equal(sent.body.messages[1].content,'t');
 }finally{await db.close();}
});

test('a reply that is not usable JSON is a malformed response',async()=>{
 const db=await database();
 try{
   const notJSON=async()=>({choices:[{finish_reason:'stop',message:{content:'I cannot help with that.'}}]});
   await assert.rejects(new OpenAICompatibleClient(db,config,['vendor/model-b:free'],notJSON as any).json('planner_calls','s','t',SCHEMA),
     /malformed_response/,'prose instead of JSON');
   const wrongShape=async()=>({id:'gen-1',error:{message:'no endpoints found'}});
   await assert.rejects(new OpenAICompatibleClient(db,config,['vendor/model-c:free'],wrongShape as any).json('planner_calls','s','t',SCHEMA),
     /malformed_response/,'valid JSON that is not a completion');
   const truncated=async()=>({choices:[{finish_reason:'length',message:{content:'{"ok":'}}]});
   await assert.rejects(new OpenAICompatibleClient(db,config,['vendor/model-d:free'],truncated as any).json('planner_calls','s','t',SCHEMA),
     /model_output_incomplete/,'a reply cut off by the token cap is reported as such, not as bad JSON');
 }finally{await db.close();}
});

test('a rate-limited model is set aside and the next one is tried first afterwards',async()=>{
 const db=await database();
 try{
   const tried:string[]=[];
   const transport=async(_u:string,options:any)=>{
     tried.push(options.body.model);
     if(options.body.model==='vendor/limited:free')throw new UpstreamError('rate_limited',429);
     return answer({ok:true,items:[]});
   };
   const client=new OpenAICompatibleClient(db,config,['vendor/limited:free','vendor/spare:free'],transport as any);
   const first=await client.json('planner_calls','s','t',SCHEMA);
   assert.deepEqual([first.model,tried],['vendor/spare:free',['vendor/limited:free','vendor/spare:free']]);
   const rows=Object.fromEntries((await db.query("SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider LIKE 'openrouter:%'")).rows.map(r=>[r.provider,r]));
   assert.deepEqual([rows['openrouter:vendor/limited:free'].failure_count,rows['openrouter:vendor/limited:free'].last_error_code],[1,'rate_limited']);
   assert.equal(rows['openrouter:vendor/spare:free'].failure_count,0);
   tried.length=0;
   const second=await client.json('planner_calls','s','t',SCHEMA);
   assert.deepEqual([second.model,tried],['vendor/spare:free',['vendor/spare:free']],'the cooling model is not tried again while it is set aside');
 }finally{await db.close();}
});
