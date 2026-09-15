import { readFile } from 'node:fs/promises';
import { connect } from './db.js';
import { setSourcePolicy, removeContent } from './admin.js';
import { importTranscript } from './moments.js';
import { ingest } from './catalogue.js';
import { contentInput } from './types.js';
import { enqueue } from './queue.js';
import {addSource,setAlternative} from './source-health.js';
const [command,arg,file]=process.argv.slice(2);
if(!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to an administrative service connection');
const db=connect(process.env.DATABASE_URL);
try {
 if(command==='sources') console.log(JSON.stringify((await db.query('SELECT id,domain,active_domain,status,adapter,policy,failure_count,health_status,health_failures,health_checked_at FROM sources ORDER BY created_at DESC')).rows,null,2));
 else if(command==='add-source' && arg)console.log(await addSource(db,arg,file));
 else if(command==='alternative' && arg && file)console.log(await setAlternative(db,arg,JSON.parse(await readFile(file,'utf8'))));
 else if(command==='alternatives' && arg)console.log(JSON.stringify((await db.query('SELECT * FROM source_alternatives WHERE source_id=$1',[arg])).rows,null,2));
 else if(command==='check-source' && arg){await db.query('UPDATE sources SET health_next_at=now() WHERE id=$1',[arg]);console.log('Health check scheduled for the worker');}
 else if(command==='policy' && arg && file) console.log(await setSourcePolicy(db,arg,JSON.parse(await readFile(file,'utf8'))));
 else if(command==='transcript' && arg) console.log(await importTranscript(db,JSON.parse(await readFile(arg,'utf8'))));
 else if(command==='import' && arg) {
   const items=JSON.parse(await readFile(arg,'utf8'));
   if(!Array.isArray(items)||items.length>100) throw new Error('Provide at most 100 metadata records');
   for(const raw of items) console.log(await ingest(db,contentInput.parse(raw),{method:'admin_import',imported_at:new Date().toISOString()}));
 } else if(command==='enrich' && arg) console.log(await enqueue(db,'enrich',`manual-enrich:${arg}:${Date.now()}`,{content_id:arg}));
 else if(command==='delete-content' && arg) {
   console.log(await removeContent(db,arg)?'Content removed and blocked from re-ingestion':'Content not found');
 } else throw new Error('Usage: npm run admin -- sources | add-source <https-url> [name] | alternative <source-id> <review.json> | alternatives <source-id> | check-source <source-id> | policy <source-id> <policy.json> | import <items.json> | transcript <transcript.json> | enrich <content-id> | delete-content <content-id>');
} finally {await db.close();}
