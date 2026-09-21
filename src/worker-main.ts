import { connect } from './db.js';
import { readConfig } from './config.js';
import { schedule, workOnce } from './worker.js';
import { keepBeating } from './health.js';
import { critiqueOnce } from './learning.js';
const config=readConfig(); const db=connect(config.DATABASE_URL);
let stopping=false;
process.on('SIGINT',()=>{stopping=true;}); process.on('SIGTERM',()=>{stopping=true;});
// The heartbeat runs on its own timer, so a long discovery job does not look like a stopped worker.
let failures=0;
const stopBeating=keepBeating(db,'worker',()=>({cycle_failures:failures}));
// Audits run beside searches in their own lane: a two-minute critic call never delays a waiting search.
const critic=(async()=>{
 while(!stopping) {
   try { if(!await critiqueOnce(db,config)) await new Promise(r=>setTimeout(r,5000)); }
   catch { console.error(JSON.stringify({event:'critic_cycle_failed',time:new Date().toISOString()})); await new Promise(r=>setTimeout(r,10000)); }
 }
})();
try {
 while(!stopping) {
   try { await schedule(db,config); if(!await workOnce(db,config)) await new Promise(r=>setTimeout(r,1000)); failures=0; }
   catch { failures++; console.error(JSON.stringify({event:'worker_cycle_failed',time:new Date().toISOString()})); await new Promise(r=>setTimeout(r,5000)); }
 }
} finally { await critic; stopBeating(); await db.close(); }
