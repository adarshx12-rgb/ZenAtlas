import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {database, testConfig} from './helpers.js';
import {CHECKS, newerModel, type Check, type CheckEnv, type CheckStatus} from '../src/dependencies.js';
import {Watchdog, alertText, probe, type Outcome} from '../src/watchdog.js';
import {compareVersions, newer, parseVersion, satisfies} from '../src/versions.js';
import {heartbeat, providerHealth} from '../src/health.js';
import {GeminiClient} from '../src/gemini.js';
import {UpstreamError} from '../src/http.js';
import {createApp} from '../src/app.js';
import type {DB} from '../src/db.js';

const check=(name:string)=>CHECKS.find(c=>c.name===name)!;
// No network: a check that makes an unexpected request fails the test.
function env(db:DB,overrides:Partial<CheckEnv>={}):CheckEnv{
 return {db,config:testConfig,root:process.cwd(),transport:async(url:string)=>{throw new Error(`unexpected request to ${url}`);},
   launchBrowser:async()=>'test',extractor:()=>({text:async()=>null,close(){}}),...overrides};
}
const fails=(error:unknown)=>async()=>{throw error;};

test('version ranges follow npm semantics for advisories, package.json and engines',()=>{
 const cases:[string,string,boolean|null][]=[
   ['5.12.4','<5.12.1',false],['5.12.0','<5.12.1',true],['4.5.0','>=4.0.0 <4.10.2',true],['4.10.2','>=4.0.0 <4.10.2',false],
   ['1.2.3','>=2.0.0 <2.1.1 || >=1.0.0 <1.2.4',true],['5.7.2','<=5.7.2',true],['1.0.0','*',true],['1.0.0','>= 1.0.0',true],
   ['1.9.0','^1.2.3',true],['2.0.0','^1.2.3',false],['0.2.9','^0.2.3',true],['0.3.0','^0.2.3',false],['0.0.4','^0.0.3',false],
   ['1.2.9','~1.2.3',true],['1.3.0','~1.2.3',false],['v24.20.0','>=24',true],['v22.1.0','>=24',false],
   ['1.2.7','1.2',true],['1.3.0','1.2.x',false],['2.0.0-rc.1','<2.0.0',true],['1.0.0','1.0.0 - 2.0.0',null],
 ];
 for(const [version,range,expected] of cases)assert.equal(satisfies(version,range),expected,`${version} in ${range}`);
 assert.ok(compareVersions(parseVersion('1.0.0-alpha.2')!,parseVersion('1.0.0-alpha.10')!)<0);
 assert.ok(compareVersions(parseVersion('1.0.0-alpha')!,parseVersion('1.0.0-alpha.1')!)<0);
 assert.ok(newer('3.10','3.8')&&!newer('3.8','3.8'));
 assert.equal(new Set(CHECKS.map(c=>c.name)).size,CHECKS.length);
 assert.ok(CHECKS.every(c=>/^[a-z0-9_]{1,64}$/.test(c.name)));
});

test('newer Gemini models are suggested only from the same line',()=>{
 const offered=['gemini-3.6-flash','gemini-3.8-flash','gemini-3.10-flash-preview','gemini-3.5-flash-lite','gemini-4-pro','gemini-flash-latest'];
 assert.equal(newerModel('gemini-3.6-flash',offered),'gemini-3.8-flash');
 assert.equal(newerModel('gemini-3.8-flash',offered),null);
 assert.equal(newerModel('gemini-3.1-flash-lite',offered),'gemini-3.5-flash-lite');
 assert.equal(newerModel('custom-model',offered),null);
});

test('a status changes only once it repeats, is stored with its history, survives a restart and alerts once',async()=>{
 const db=await database();
 try{
   const script:CheckStatus[]=['ok','failing','failing','failing','ok','ok'];
   let calls=0;
   const flaky:Check={name:'flaky',label:'Flaky service',category:'apis',every:()=>30,async run(){
     const status=script[calls++];
     return status==='ok'?{status,code:'fine',summary:'Answering.'}:{status,code:'down',summary:'Not answering.'};
   }};
   const alerts:Outcome[][]=[];
   const notify=async(changes:Outcome[])=>{alerts.push(changes);};
   const watchdog=new Watchdog(env(db),[flaky],notify);
   const statuses=[];
   for(let i=0;i<4;i++)statuses.push((await watchdog.run([flaky]))[0].status);
   assert.deepEqual(statuses,['ok','ok','failing','failing'],'one failure is not enough');
   assert.equal(alerts.length,1);assert.equal(alerts[0][0].previous,'ok');
   assert.equal(alertText(alerts[0]),'ZenAtlas watchdog\nFlaky service FAILING (was ok): Not answering.');
   let row=(await db.query("SELECT * FROM dependency_checks WHERE name='flaky'")).rows[0];
   assert.deepEqual([row.status,row.observed,row.streak,row.code],['failing','failing',3,'down']);
   assert.ok(new Date(row.next_at).getTime()-Date.now()<=5*60_000+1000,'a failure is checked again within 5 minutes');

   const restarted=new Watchdog(env(db),[flaky],notify);
   await restarted.load();
   assert.equal(restarted.due().length,0,'the stored schedule is kept');
   assert.equal((await restarted.run([flaky]))[0].status,'failing','a single good result is not trusted yet');
   row=(await db.query("SELECT * FROM dependency_checks WHERE name='flaky'")).rows[0];
   assert.equal(row.observed,'ok');assert.ok(new Date(row.next_at).getTime()-Date.now()<=61_000,'an unconfirmed result is checked again within a minute');
   assert.equal((await restarted.run([flaky]))[0].status,'ok');
   assert.equal(alerts.length,2);assert.equal(alerts[1][0].status,'ok');
   const events=(await db.query('SELECT from_status,to_status FROM dependency_events ORDER BY id')).rows;
   assert.deepEqual(events.map(e=>`${e.from_status}->${e.to_status}`),['ok->failing','failing->ok']);

   const broken:Check={name:'broken',label:'Broken',category:'apis',every:()=>30,async run(){throw new Error('boom\nat stack');}};
   const outcome=(await new Watchdog(env(db),[broken],notify).run([broken]))[0];
   assert.deepEqual([outcome.status,outcome.observation.code,outcome.observation.summary],['failing','check_error','The check could not run: boom.']);
   assert.equal(alerts.length,3,'a problem found by the first check alerts at once');
 }finally{await db.close();}
});

test('worker and queue checks notice a stopped worker and searches that wait',async()=>{
 const db=await database();
 try{
   const e=env(db);
   assert.equal((await check('worker').run(e)).code,'never_seen');
   await heartbeat(db,'worker',new Date(),{cycle_failures:0});
   assert.equal((await check('worker').run(e)).status,'ok');
   await heartbeat(db,'worker',new Date(),{cycle_failures:4});
   assert.equal((await check('worker').run(e)).code,'cycles_failing');
   await db.query("UPDATE service_heartbeats SET beat_at=now()-interval '10 minutes' WHERE service='worker'");
   const stopped=await check('worker').run(e);
   assert.equal(stopped.code,'stopped');assert.match(stopped.summary,/not reported for 10 min/);

   assert.equal((await check('job_queue').run(e)).summary,'Idle; nothing is waiting.');
   await db.query("INSERT INTO jobs(kind,dedupe_key,payload,run_after) VALUES('discovery','stuck','{}',now()-interval '10 minutes')");
   assert.equal((await check('job_queue').run(e)).code,'searches_stuck');
   await db.query(`INSERT INTO jobs(kind,dedupe_key,payload,status,lease_until,lease_token,updated_at)
     VALUES('discovery','busy','{}','running',now()+interval '1 minute',gen_random_uuid(),now()-interval '20 minutes')`);
   const busy=await check('job_queue').run(e);
   assert.equal(busy.code,'searches_queuing');assert.match(busy.summary,/behind 1 running job/);assert.match(busy.summary,/may be stuck/);
 }finally{await db.close();}
});

test('database, budget and running-code checks read local state',async()=>{
 const db=await database();
 try{
   const e=env(db);
   assert.equal((await check('database').run(e)).status,'ok');
   await db.query("DELETE FROM schema_migrations WHERE name='010_dependency_health.sql'");
   const pending=await check('database').run(e);
   assert.equal(pending.code,'migrations_pending');assert.match(pending.summary,/010_dependency_health\.sql/);

   assert.equal((await check('budgets').run(e)).summary,'Nothing used yet today.');
   await db.query(`INSERT INTO budgets(bucket,window_start,used) VALUES('discovery_jobs',date_trunc('day',now()),$1),('judge_calls',date_trunc('day',now()),190)`,
     [testConfig.DISCOVERY_DAILY_BUDGET]);
   const spent=await check('budgets').run(e);
   assert.equal(spent.status,'failing');
   assert.match(spent.summary,/Today's discovery searches are used up \(100\/100\); searches only use the saved catalogue/);
   assert.match(spent.summary,/95% of today's AI judging calls are used/);

   assert.equal((await check('running_code').run(e)).summary,'No service is reporting.');
   await heartbeat(db,'api',new Date());
   await heartbeat(db,'worker',new Date(Date.UTC(2000,0,1)));
   const stale=await check('running_code').run(e);
   assert.equal(stale.code,'restart_needed');assert.match(stale.summary,/^zenatlas-worker \(source code/);
   assert.match(stale.summary,/pm2 restart zenatlas-worker\.$/,'the API started after the last change');
 }finally{await db.close();}
});

test('the Gemini check finds retired models, rejected keys and models failing in real searches',async()=>{
 const db=await database();
 try{
   const config={...testConfig,GEMINI_API_KEY:'test-key',GEMINI_MODEL:'gemini-3.8-flash',JUDGE_MODEL:'gemini-3.6-flash',JUDGE_FALLBACK_MODELS:'gemini-3.8-flash, gemini-2.0-flash'};
   let offered=['gemini-3.6-flash','gemini-3.8-flash'];
   const requests:any[]=[];
   const transport=async(url:string,options:any)=>{requests.push({url,options});return {models:[
     ...offered.map(m=>({name:`models/${m}`,supportedGenerationMethods:['generateContent','countTokens']})),
     {name:'models/gemini-2.0-flash',supportedGenerationMethods:['embedContent']}]};};
   const e=env(db,{config,transport:transport as any});
   let result=await check('gemini').run(e);
   assert.equal(result.code,'fallback_retired');assert.match(result.summary,/^Fallback gemini-2\.0-flash is no longer offered/,'a model that cannot generate does not count');
   assert.equal(requests[0].options.headers['x-goog-api-key'],'test-key');
   assert.equal(new URL(requests[0].url).origin,'https://generativelanguage.googleapis.com');
   assert.deepEqual(result.details!.upgrades,['gemini-3.6-flash → gemini-3.8-flash','gemini-2.0-flash → gemini-3.8-flash']);

   offered=['gemini-3.8-flash','gemini-2.0-flash'];
   result=await check('gemini').run(e);
   assert.equal(result.code,'model_retired');assert.match(result.summary,/no longer offers gemini-3\.6-flash \(JUDGE_MODEL\); searches fall back to gemini-3\.8-flash/);

   offered=['gemini-3.6-flash','gemini-3.8-flash','gemini-2.0-flash'];
   assert.equal((await check('gemini').run(e)).status,'ok');
   for(let i=0;i<3;i++)await providerHealth(db,'gemini:gemini-3.8-flash',false,'rate_limited_daily RESOURCE_EXHAUSTED');
   result=await check('gemini').run(e);
   assert.equal(result.code,'model_failing');assert.match(result.summary,/gemini-3\.8-flash failed its last 3 calls \(daily quota used up\)/);

   offered=['gemini-9-flash'];
   result=await check('gemini').run(e);
   assert.equal(result.code,'models_retired');assert.match(result.summary,/such as gemini-9-flash\.$/);

   const rejected=await check('gemini').run(env(db,{config,transport:fails(new UpstreamError('upstream_failure',400,'INVALID_ARGUMENT,API_KEY_INVALID'))}));
   assert.equal(rejected.code,'key_rejected');assert.match(rejected.summary,/API_KEY_INVALID/);assert.ok(!rejected.summary.includes('test-key'));
   assert.equal((await check('gemini').run(env(db))).status,'disabled');
 }finally{await db.close();}
});

test('a retired primary model falls through to its fallback, and every model call is recorded',async()=>{
 const db=await database();
 try{
   const config={...testConfig,GEMINI_API_KEY:'k',GEMINI_MODEL:'retired-model',JUDGE_FALLBACK_MODELS:'current-model'};
   const transport=async(url:string)=>{
     if(url.includes('retired-model'))throw new UpstreamError('upstream_failure',404,'NOT_FOUND');
     return {candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]};
   };
   const reply=await new GeminiClient(db,config,transport as any).json('planner_calls','system','text',{type:'object'});
   assert.deepEqual([reply.model,reply.value],['current-model',{ok:true}]);
   const rows=Object.fromEntries((await db.query("SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider LIKE 'gemini:%'")).rows.map(r=>[r.provider,r]));
   assert.deepEqual([rows['gemini:retired-model'].failure_count,rows['gemini:retired-model'].last_error_code],[1,'upstream_failure_404 NOT_FOUND']);
   assert.equal(rows['gemini:current-model'].failure_count,0);
 }finally{await db.close();}
});

test('SearXNG checks find engines the instance lacks, engines failing in searches, and an old image',async()=>{
 const db=await database();
 try{
   const config={...testConfig,SEARXNG_BASE_URL:'http://127.0.0.1:8080',SEARXNG_ENGINES:'youtube,dailymotion,odysee',SEARXNG_SOURCE_ENGINES:'google',
     SEARXNG_WEB_ENGINES:'google,bing',SEARXNG_DEEP_ENGINES:'acfun',SEARXNG_DEEP_WEB_ENGINES:''};
   const instance={version:'2026.9.16+f725cc793',engines:[...['youtube','dailymotion','odysee','google','bing'].map(name=>({name,enabled:true})),{name:'acfun',enabled:false}]};
   const transport=async(url:string,options:any)=>{
     if(new URL(url).hostname==='hub.docker.com')return {results:[{name:'latest'},{name:'2026.11.20-abc1234'},{name:'2026.11.19-def5678'}]};
     assert.deepEqual([new URL(url).pathname,options.trustedOrigin],['/config','http://127.0.0.1:8080']);
     return instance;
   };
   const e=env(db,{config,transport:transport as any});
   const found=await check('searxng').run(e);
   assert.equal(found.code,'engines_unavailable');assert.match(found.summary,/^acfun \(SEARXNG_DEEP_ENGINES\) is not enabled in SearXNG/);
   const down=await check('searxng').run(env(db,{config,transport:fails(new UpstreamError('network_error'))}));
   assert.equal(down.code,'unreachable');assert.match(down.summary,/http:\/\/127\.0\.0\.1:8080 is not answering \(network_error\)/);

   assert.equal((await check('searxng_engines').run(e)).summary,'No engine results are recorded yet.');
   for(let i=0;i<3;i++)await providerHealth(db,'searxng:dailymotion',false,'timed out');
   await providerHealth(db,'searxng:youtube',true);
   await providerHealth(db,'searxng:retired-engine',false);
   let engines=await check('searxng_engines').run(e);
   assert.equal(engines.status,'warning');assert.match(engines.summary,/^dailymotion \(3 in a row, timed out\) failed its latest searches/);
   for(let i=0;i<4;i++)await providerHealth(db,'searxng:odysee',false,'blocked by a CAPTCHA');
   engines=await check('searxng_engines').run(e);
   assert.equal(engines.status,'failing','two of the three video engines are down');
   assert.match(engines.summary,/^odysee \(4 in a row, blocked by a CAPTCHA\) and dailymotion/);

   const release=await check('searxng_release').run(e);
   assert.equal(release.code,'outdated');assert.match(release.summary,/is 65 days older than the newest image \(2026\.11\.20-abc1234\)/);
   const unreachable=await check('searxng_release').run(env(db,{config,transport:async(url:string)=>{
     if(new URL(url).hostname==='hub.docker.com')throw new UpstreamError('timeout');return instance;}}));
   assert.deepEqual([unreachable.status,unreachable.retryMinutes],['warning',60]);

   assert.equal((await check('search_providers').run(env(db))).code,'none_configured');
   assert.equal((await check('search_providers').run(e)).status,'ok');
   for(let i=0;i<3;i++)await providerHealth(db,'searxng',false,'partial');
   assert.equal((await check('search_providers').run(e)).code,'providers_failing');
 }finally{await db.close();}
});

test('package checks find missing, drifted and vulnerable packages, updates and an unsupported Node',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zenatlas-watchdog-'));
 const db=await database();
 try{
   const manifest={engines:{node:'>=24'},dependencies:{fastify:'^5.12.0',pg:'^8.20.0','@scope/tool':'^1.0.0'},devDependencies:{tsx:'^4.0.0'}};
   await writeFile(join(root,'package.json'),JSON.stringify(manifest));
   await writeFile(join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{},'node_modules/fastify':{version:'5.12.0'},
     'node_modules/pg':{version:'8.20.0'},'node_modules/@scope/tool':{version:'1.0.0'},'node_modules/tsx':{version:'4.1.0',dev:true},
     'node_modules/fastify/node_modules/minimist':{version:'1.2.0'},'packages/local':{version:'0.0.1'}}}));
   const install=async(name:string,version:string)=>{
     const dir=join(root,'node_modules',...name.split('/'));
     await mkdir(dir,{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({name,version}));
   };
   await install('fastify','5.12.0');await install('pg','8.21.0');await install('@scope/tool','1.0.0');
   const requests:any[]=[];
   const latest:Record<string,string>={fastify:'5.13.0',pg:'9.0.0','@scope/tool':'1.0.0',tsx:'4.1.0'};
   const transport=async(url:string,options:any={})=>{
     requests.push({url,options});
     if(url.endsWith('/advisories/bulk'))return {
       fastify:[{title:'Old bug ',url:'https://example.org/a',severity:'high',vulnerable_versions:'<5.12.1'},{title:'Fixed long ago',severity:'critical',vulnerable_versions:'<4.0.0'}],
       minimist:[{title:'Prototype pollution',severity:'moderate',vulnerable_versions:'>=1.0.0 <1.2.3'}]};
     return {latest:latest[decodeURIComponent(new URL(url).pathname.split('/')[3])]};
   };
   const e=env(db,{root,transport:transport as any});

   const installed=await check('packages').run(e);
   assert.equal(installed.status,'failing');
   assert.equal(installed.summary,'tsx is not installed, so a restarted service may not start. Run npm ci. Installed versions differ from package-lock.json: pg 8.21.0 (locked 8.20.0). Run npm ci.');

   const audit=await check('vulnerabilities').run(e);
   assert.equal(audit.status,'failing');
   assert.match(audit.summary,/^2 known vulnerabilities \(1 high, 1 moderate\): fastify 5\.12\.0, high: Old bug and minimist 1\.2\.0, moderate: Prototype pollution\./);
   const bulk=requests.find(r=>r.url.endsWith('/advisories/bulk'));
   assert.equal(bulk.options.method,'POST');assert.deepEqual(bulk.options.body.minimist,['1.2.0']);
   assert.ok(!Object.keys(bulk.options.body).some(name=>name.includes('local')),'workspace folders are not packages');
   assert.ok(bulk.options.contentTypes.includes(''),'npm sends no content type');

   const updates=await check('package_updates').run(e);
   assert.equal(updates.code,'major_updates');
   assert.equal(updates.summary,'pg 8.20.0 → 9.0.0 is a new major version that may need code changes. 1 compatible update available (fastify 5.13.0); npm update applies it.');
   assert.ok(requests.some(r=>r.url==='https://registry.npmjs.org/-/package/@scope%2ftool/dist-tags'));

   const major=parseVersion(process.version)!.major;
   const node=await check('node_runtime').run(env(db,{root,transport:async()=>[{version:`v${major}.999.0`},{version:`v${major}.998.0`,security:true},
     {version:`v${major+1}.0.0`,security:true},{version:process.version,security:true}]}));
   assert.equal(node.code,'security_update');assert.equal(node.summary,`Node ${process.version} lacks the security fixes in v${major}.998.0. Install v${major}.999.0, then restart the services.`);
   await writeFile(join(root,'package.json'),JSON.stringify({...manifest,engines:{node:'>=999'}}));
   assert.equal((await check('node_runtime').run(e)).code,'unsupported');
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});

test('runtime tools and optional APIs report what broke and how to fix it',async()=>{
 const db=await database();
 try{
   const renders={...testConfig,PAGE_RENDERS:2};
   const missing=await check('browser').run(env(db,{config:renders,launchBrowser:fails(new Error("browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chrome.exe\nPlease run: npx playwright install"))}));
   assert.equal(missing.code,'not_installed');assert.match(missing.summary,/Playwright \d+\.\d+\.\d+ needs is not installed.*npx playwright install --only-shell chromium$/);
   assert.equal((await check('browser').run(env(db,{config:renders,launchBrowser:async()=>'140.0.1'}))).summary,'Chromium 140.0.1 starts for rendered page checks.');
   assert.equal((await check('browser').run(env(db))).status,'disabled');

   const python={...testConfig,PAGE_TEXT_PYTHON:'python3'};
   let closed=0;
   const working=await check('page_text').run(env(db,{config:python,extractor:()=>({text:async(html:string)=>html.includes('Lanternfish')?'Lanternfish migration':null,close(){closed++;}})}));
   assert.equal(working.status,'ok');assert.equal(closed,1,'the helper process is stopped');
   assert.equal((await check('page_text').run(env(db,{config:python}))).code,'no_answer');
   assert.equal((await check('page_text').run(env(db,{config:{...testConfig,PAGE_TEXT_PYTHON:'missing/venv/python.exe'}}))).code,'python_missing');

   const anime={...testConfig,ANILIST_ENABLED:true};
   const bebop={data:{Page:{media:[{id:1,siteUrl:'https://anilist.co/anime/1',title:{romaji:'Cowboy Bebop',english:'Cowboy Bebop',native:null}}]}}};
   assert.equal((await check('anilist').run(env(db,{config:anime,transport:async()=>bebop}))).status,'ok');
   assert.equal((await check('anilist').run(env(db,{config:anime,transport:async()=>({data:{Page:{media:[{id:'one'}]}}})}))).code,'api_changed');
   assert.equal((await check('anilist').run(env(db,{config:anime,transport:async()=>({data:{Page:{media:[]}}})}))).code,'not_recognised');
   assert.equal((await check('anilist').run(env(db,{config:anime,transport:fails(new UpstreamError('upstream_failure',403))}))).code,'refused');
   assert.equal((await check('anilist').run(env(db))).status,'disabled');

   const youtube={...testConfig,YOUTUBE_API_KEY:'yt-key'};
   const video={items:[{id:'jNQXAC9IVRw',snippet:{title:'Me at the zoo',channelId:'UC4QobU6STFB0P71PMvOGN5A'}}]};
   assert.equal((await check('youtube_api').run(env(db,{config:youtube,transport:async()=>video}))).status,'ok');
   assert.equal((await check('youtube_api').run(env(db,{config:youtube,transport:fails(new UpstreamError('upstream_failure',403,'quotaExceeded'))}))).code,'quota_exceeded');
   assert.equal((await check('youtube_api').run(env(db,{config:youtube,transport:fails(new UpstreamError('upstream_failure',403,'PERMISSION_DENIED,accessNotConfigured'))}))).code,'api_disabled');
   const rejected=await check('youtube_api').run(env(db,{config:youtube,transport:fails(new UpstreamError('upstream_failure',400,'INVALID_ARGUMENT,badRequest,API_KEY_INVALID'))}));
   assert.equal(rejected.code,'key_rejected');assert.ok(!rejected.summary.includes('yt-key'));
   assert.equal((await check('youtube_api').run(env(db,{config:{...youtube,YOUTUBE_DAILY_UNITS:0},transport:async()=>video}))).code,'budget_spent');

   assert.equal((await check('embeddings').run(env(db))).status,'disabled');
   assert.equal((await check('embeddings').run(env(db,{config:{...testConfig,SEMANTIC_ENABLED:true}}))).code,'not_configured');

   const api=await check('api').run(env(db,{config:{...testConfig,HOST:'0.0.0.0',PORT:4321},transport:fails(new UpstreamError('network_error'))}));
   assert.equal(api.code,'unreachable');assert.match(api.summary,/^Nothing answers at http:\/\/127\.0\.0\.1:4321 \(network_error\)/);
 }finally{await db.close();}
});

test('a one-off probe stores nothing, and the report is for administrators and flags an unwatched site',async()=>{
 const db=await database();const app=await createApp(db,testConfig);
 try{
   const results=await probe(env(db),[check('worker'),check('budgets')]);
   assert.deepEqual(results.map(r=>r.observation.status),['failing','ok']);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM dependency_checks')).rows[0].n,0);

   assert.equal((await app.inject('/api/admin/dependencies')).statusCode,403);
   const headers={authorization:`Bearer ${testConfig.ADMIN_TOKEN}`};
   await new Watchdog(env(db),[check('worker'),check('budgets')],async()=>{}).run();
   let report=(await app.inject({url:'/api/admin/dependencies',headers})).json();
   assert.equal(report.status,'unmonitored');assert.deepEqual(report.counts,{ok:1,warning:0,failing:1,disabled:0});
   assert.deepEqual(report.checks.map((c:any)=>c.name),['worker','budgets'],'worst first');
   assert.deepEqual(report.events.map((e:any)=>[e.name,e.from_status,e.to_status]),[['worker',null,'failing']]);
   await heartbeat(db,'watchdog',new Date());
   report=(await app.inject({url:'/api/admin/dependencies',headers})).json();
   assert.equal(report.status,'failing');assert.deepEqual(report.services.map((s:any)=>[s.service,s.running]),[['watchdog',true]]);
   assert.deepEqual((await app.inject({url:'/api/admin/health',headers})).json().dependencies,{ok:1,failing:1});
 }finally{await app.close();await db.close();}
});
