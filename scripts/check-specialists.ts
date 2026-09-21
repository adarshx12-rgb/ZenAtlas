// Read-only live smoke test; no database, API keys, or retained catalogue data.
import {configSchema} from '../src/config.js';
import {InternetArchive, LibraryOfCongress} from '../src/specialists.js';
import {searchInput} from '../src/types.js';
const config=configSchema.parse({DATABASE_URL:'unused',SESSION_SECRET:'smoke-session-secret-32-characters-long',
 ADMIN_TOKEN:'smoke-admin-token-32-characters-long',PROVIDER_TIMEOUT_MS:15000});
const input=searchInput.parse({q:process.argv.slice(2).join(' ')||'moon'});
await Promise.all([new InternetArchive(config),new LibraryOfCongress(config)].map(async adapter=>{
 try{
   const page=await adapter.search(input.q,input);
   console.log(JSON.stringify({provider:adapter.name,count:page.results.length,next:page.next_cursor,
     samples:page.results.slice(0,3).map(r=>({title:r.title,url:r.url}))}));
 }catch(error){process.exitCode=1;console.log(JSON.stringify({provider:adapter.name,error:error instanceof Error?error.message:'failed',status:(error as {status?:number})?.status}));}
}));
