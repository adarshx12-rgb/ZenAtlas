import { connect } from './db.js';
import { readConfig } from './config.js';
import { schedule, workOnce } from './worker.js';
const config=readConfig(); const db=connect(config.DATABASE_URL);
let stopping=false;
process.on('SIGINT',()=>{stopping=true;}); process.on('SIGTERM',()=>{stopping=true;});
try {
 while(!stopping) {
   try { await schedule(db,config); if(!await workOnce(db,config)) await new Promise(r=>setTimeout(r,1000)); }
   catch { console.error(JSON.stringify({event:'worker_cycle_failed',time:new Date().toISOString()})); await new Promise(r=>setTimeout(r,5000)); }
 }
} finally { await db.close(); }
