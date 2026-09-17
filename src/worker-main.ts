import { connect } from './db.js';
import { readConfig } from './config.js';
import { schedule, workOnce } from './worker.js';
import { keepBeating } from './health.js';
const config=readConfig(); const db=connect(config.DATABASE_URL);
let stopping=false;
process.on('SIGINT',()=>{stopping=true;}); process.on('SIGTERM',()=>{stopping=true;});
// The heartbeat runs on its own timer, so a long discovery job does not look like a stopped worker.
let failures=0;
const stopBeating=keepBeating(db,'worker',()=>({cycle_failures:failures}));
try {
 while(!stopping) {
   try { await schedule(db,config); if(!await workOnce(db,config)) await new Promise(r=>setTimeout(r,1000)); failures=0; }
   catch { failures++; console.error(JSON.stringify({event:'worker_cycle_failed',time:new Date().toISOString()})); await new Promise(r=>setTimeout(r,5000)); }
 }
} finally { stopBeating(); await db.close(); }
