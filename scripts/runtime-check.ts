// Read-only operational preflight. No budget resets, migrations, model generations or notifications.
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {connect} from '../src/db.js';
import {readConfig} from '../src/config.js';
import {CHECKS,defaultEnv} from '../src/dependencies.js';
import {probe} from '../src/watchdog.js';
import {databaseReadiness,initializeRuntime,requiredMigrations} from '../src/runtime.js';

const config=readConfig(),db=connect(config.DATABASE_URL);
const expected=initializeRuntime(config);
const target=process.argv[2]??'output/runtime-check.json';
try {
 const readiness=await databaseReadiness(db,requiredMigrations(process.cwd(),config.SEMANTIC_ENABLED));
 const names=['database','api','worker','scene_worker','job_queue','budgets','running_code','search_providers','searxng','searxng_engines','tier_models'];
 const checks=readiness.status==='ready'?await probe(defaultEnv(db,config),CHECKS.filter(c=>names.includes(c.name))):[];
 const services=readiness.status==='ready'?(await db.query("SELECT service,started_at,beat_at,details,extract(epoch FROM now()-beat_at)::int AS silent_seconds FROM service_heartbeats ORDER BY service")).rows:[];
 const versions=['api','worker','watchdog'].map(service=>{
   const row=services.find(s=>s.service===service),actual=row?.details?.runtime;
   return {service,running:!!row&&row.silent_seconds<=config.WATCHDOG_STALE_SECONDS,runtime:actual??null,
     matches:!!actual&&actual.code_hash===expected.code_hash&&actual.settings_hash===expected.settings_hash};
 });
 const failed=readiness.status!=='ready'||checks.some(c=>c.observation.status==='failing')||versions.some(v=>!v.running||!v.matches);
 const report={at:new Date().toISOString(),status:failed?'not_ready':checks.some(c=>c.observation.status==='warning')?'degraded':'ready',
   expected,readiness,services:versions,checks:checks.map(c=>({name:c.check.name,...c.observation,latency_ms:c.latencyMs}))};
 mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(report,null,2));
 console.log(JSON.stringify({status:report.status,readiness:readiness.code,services:versions.map(v=>({service:v.service,running:v.running,matches:v.matches})),
   checks:report.checks.map(c=>({name:c.name,status:c.status,code:c.code})),report:target},null,2));
 if(failed)process.exitCode=1;
} finally {await db.close();}
