import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,testConfig} from './helpers.js';
import {createApp} from '../src/app.js';
import {ingest} from '../src/catalogue.js';
import {contentInput} from '../src/types.js';

const write={'x-requested-with':'CreatorSearch'};
const auth={authorization:`Bearer ${testConfig.ADMIN_TOKEN}`};
const policy=(overrides:Record<string,unknown>={})=>({status:'active',metadata:true,transcripts:false,video_analysis:false,
 retention_days:30,adapter:'link_only',feed_url:null,review_note:'TEST: approved from the admin page.',...overrides});

async function setup(){
 const db=await database();const app=await createApp(db,testConfig);
 await fixture(db);
 for(const [i,host] of ['alpha.example.org','beta.example.org','beta.example.org','gamma.example.net'].entries())
   await ingest(db,contentInput.parse({url:`https://${host}/watch/${i}`,title:`Lead ${i}`}),{method:'search'});
 return {db,app};
}

test('admin source list requires the token and supports status, search, sort, paging and saved counts',async()=>{
 const {db,app}=await setup();
 try{
   assert.equal((await app.inject('/api/admin/sources')).statusCode,403);
   const all=await app.inject({url:'/api/admin/sources?sort=seen',headers:auth});
   assert.equal(all.statusCode,200);assert.equal(all.headers['x-total-count'],'4');
   const rows=all.json();
   assert.equal(rows[0].domain,'beta.example.org','most-seen first');
   assert.equal(rows.find((r:any)=>r.domain==='videos.example.com').saved_videos,1);
   assert.ok(!('total_rows' in rows[0]));
   const candidates=(await app.inject({url:'/api/admin/sources?status=candidate&sort=domain&limit=2&offset=1',headers:auth}));
   assert.equal(candidates.headers['x-total-count'],'3');
   assert.deepEqual(candidates.json().map((r:any)=>r.domain),['beta.example.org','gamma.example.net']);
   const search=await app.inject({url:'/api/admin/sources?q=EXAMPLE.ORG',headers:auth});
   assert.deepEqual(search.json().map((r:any)=>r.domain).sort(),['alpha.example.org','beta.example.org']);
   assert.equal((await app.inject({url:'/api/admin/sources?q=%25',headers:auth})).headers['x-total-count'],'0','LIKE wildcards are literal');
   assert.equal((await app.inject({url:'/api/admin/sources?status=nope',headers:auth})).statusCode,400);
   const summary=(await app.inject({url:'/api/admin/sources/summary',headers:auth})).json();
   assert.deepEqual(summary,{statuses:{active:1,candidate:3},rules:0,saved_videos:1});
 }finally{await app.close();await db.close();}
});

test('bulk review applies one validated policy to many websites',async()=>{
 const {db,app}=await setup();
 try{
   const ids=(await db.query("SELECT id FROM sources WHERE status='candidate' AND domain LIKE '%.example.org'")).rows.map(r=>r.id);
   assert.equal((await app.inject({method:'POST',url:'/api/admin/sources/bulk',headers:write,payload:{ids,policy:policy()}})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:'/api/admin/sources/bulk',headers:{...write,...auth},payload:{ids,policy:policy({review_note:'short'})}})).statusCode,400);
   assert.equal((await app.inject({method:'POST',url:'/api/admin/sources/bulk',headers:{...write,...auth},
     payload:{ids:Array.from({length:101},()=>crypto.randomUUID()),policy:policy()}})).statusCode,400,'batches are bounded');
   const response=await app.inject({method:'POST',url:'/api/admin/sources/bulk',headers:{...write,...auth},payload:{ids:[...ids,ids[0]],policy:policy()}});
   assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{updated:2});
   assert.deepEqual((await db.query('SELECT DISTINCT status FROM sources WHERE id=ANY($1::uuid[])',[ids])).rows,[{status:'active'}]);
 }finally{await app.close();await db.close();}
});

test('the admin page can switch viewer comment timestamps on, and a rejected field is named',async()=>{
 const {db,app}=await setup();
 try{
   const headers={...write,...auth};
   const source=(await db.query("SELECT id FROM sources WHERE domain='videos.example.com'")).rows[0].id;
   const saved=await app.inject({method:'PATCH',url:`/api/admin/sources/${source}`,headers,payload:policy({viewer_signals:true,retention_days:30})});
   assert.equal(saved.statusCode,200);
   assert.equal((await db.query('SELECT policy FROM sources WHERE id=$1',[source])).rows[0].policy.viewer_signals,true);
   const unknown=await app.inject({method:'PATCH',url:`/api/admin/sources/${source}`,headers,payload:policy({surprise:true})});
   assert.equal(unknown.statusCode,400);assert.match(unknown.json().error.message,/Unrecognized key.*surprise/);
   const retention=await app.inject({method:'PATCH',url:`/api/admin/sources/${source}`,headers,payload:policy({retention_days:0})});
   assert.match(retention.json().error.message,/retention_days: /);
   const publicError=await app.inject('/api/search?q=x');
   assert.equal(publicError.json().error.message,'Check the query, filters, or request fields.','public errors stay generic');
 }finally{await app.close();await db.close();}
});

test('trust rules can be created, listed and deleted over the admin API',async()=>{
 const {db,app}=await setup();
 try{
   const headers={...write,...auth};
   assert.equal((await app.inject({method:'POST',url:'/api/admin/rules',headers:write,payload:{pattern:'*.example.org',policy:policy()}})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:'/api/admin/rules',headers,payload:{pattern:'not a domain',policy:policy()}})).statusCode,400);
   const created=await app.inject({method:'POST',url:'/api/admin/rules',headers,payload:{pattern:'*.example.org',policy:policy()}});
   assert.equal(created.statusCode,200);assert.equal(created.json().applied_to_existing,2);
   const rules=(await app.inject({url:'/api/admin/rules',headers:auth})).json();
   assert.equal(rules.length,1);assert.equal(rules[0].pattern,'*.example.org');
   assert.equal((await app.inject({method:'DELETE',url:`/api/admin/rules/${rules[0].id}`,headers})).statusCode,204);
   assert.equal((await app.inject({method:'DELETE',url:`/api/admin/rules/${rules[0].id}`,headers})).statusCode,404);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM sources WHERE status='active'")).rows[0].n,3,'deleting a rule keeps decisions it already made');
 }finally{await app.close();await db.close();}
});

test('adding an unsafe address is a clear validation error, and /admin opens the admin page',async()=>{
 const {db,app}=await setup();
 try{
   const unsafe=await app.inject({method:'POST',url:'/api/admin/sources',headers:{...write,...auth},payload:{url:'http://127.0.0.1/private'}});
   assert.equal(unsafe.statusCode,400);assert.equal(unsafe.json().error.code,'unsafe_url');
   const redirect=await app.inject('/admin');
   assert.equal(redirect.statusCode,302);assert.equal(redirect.headers.location,'/admin.html');
   const page=await app.inject('/admin.html');
   assert.equal(page.statusCode,200);assert.match(page.body,/noindex/);
   assert.match(String(page.headers['content-security-policy']),/script-src 'self'/);
 }finally{await app.close();await db.close();}
});
