// Run a real discovery search and export its exploration choices and final judgments.
import {mkdir,writeFile} from 'node:fs/promises';
import {connect} from '../src/db.js';
import {readConfig} from '../src/config.js';
import {runDiscovery} from '../src/discovery.js';
import {searchInput} from '../src/types.js';
import {UpstreamError} from '../src/http.js';

const config=readConfig(),db=connect(config.DATABASE_URL);
const q=process.argv.slice(2).join(' ')||'official whatsapp chat ui interface from over past 3 years';
try {
 const started=Date.now();
 const result=await runDiscovery(db,config,searchInput.parse({q,mode:'refresh'}),undefined,{},async()=>{},async p=>{
   console.log(JSON.stringify({stage:p.stage,exploration:p.providers.find(p=>p.provider==='jev_exploration')}));
 });
 const output='output/exploration-latest.json';
 await mkdir('output',{recursive:true});
 await writeFile(output,JSON.stringify({q,elapsed_ms:Date.now()-started,trace:result.trace,
   results:result.results.map(r=>({url:r.canonical_url,title:r.title,judgement:r.judgement})),providers:result.providers},null,2)+'\n');
 console.log(JSON.stringify({output,visited:result.trace.exploration?.visited.length??0,
   discovered:result.trace.exploration?.new_urls??[],shown:result.results.length,error:result.trace.exploration?.error}));
 if(!result.trace.exploration || result.trace.exploration.error)process.exitCode=1;
} catch(error) {
 process.exitCode=1;console.error(JSON.stringify({error:error instanceof UpstreamError?error.code:'exploration_check_failed'}));
} finally {await db.close();}
