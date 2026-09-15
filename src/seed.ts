import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {connect,type DB} from './db.js';
import {ingest} from './catalogue.js';
import {contentInput} from './types.js';
export async function seed(db:DB){
 const items=JSON.parse(await readFile('data/curated.json','utf8'));
 await db.query(`INSERT INTO sources(domain,display_name,status,policy,provenance) VALUES('www.youtube.com','YouTube','active',
 '{"metadata":true,"transcripts":false,"retention_days":30}',
 '{"method":"curated_public_links","review_note":"Retain links and short descriptive metadata only; no collection, transcripts or media access granted."}')
 ON CONFLICT(domain) DO NOTHING`);
 let count=0;
 for(const item of items){const result=await ingest(db,contentInput.parse(item),{method:'curated_public_link',reference:item.url,
   title_checked_at:'2026-09-15',verification:'Official watch-page title checked with web retrieval; playback, rights and timestamps not verified.'});if(result)count++;}
 return count;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.env.DATABASE_URL)throw Error('Set DATABASE_URL');const db=connect(process.env.DATABASE_URL);
 try{console.log(`Loaded ${await seed(db)} curated links`);}finally{await db.close();}
}
