// Live acceptance capture. Uses normal search budgets; never migrates, resets budgets or restarts services.
import {writeFile,mkdir} from 'node:fs/promises';
import {connect} from '../src/db.js';
const base='http://127.0.0.1:3000';
const file=`output/three-query-probe-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const out:any={started_at:new Date().toISOString(),base,tier:'ssj3',runtime:{},queries:[]};
const db=connect(process.env.DATABASE_URL!);
try{
 out.runtime.migrations=(await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r=>r.name);
 out.runtime.services=(await db.query('SELECT service,started_at,beat_at FROM service_heartbeats ORDER BY service')).rows;
 out.runtime.scene_budgets=(await db.query("SELECT bucket,used FROM budgets WHERE window_start=date_trunc('day',now()) AND bucket IN ('scene_analysis_requests','scene_auto_jobs')")).rows;
}finally{await db.close();}
await mkdir('output',{recursive:true});
const save=()=>writeFile(file,JSON.stringify(out,null,2)+'\n');
await save();console.log(JSON.stringify({event:'runtime',...out.runtime}));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function client(){let cookie='';return async(path:string)=>{
 const r=await fetch(base+path,{headers:cookie?{cookie}:{},signal:AbortSignal.timeout(120000)});
 const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
 if(!r.ok)throw new Error(`HTTP ${r.status} on ${path.split('?')[0]}`);
 return r.json();
};}
async function run(tab:'videos'|'web',q:string){
 const started=Date.now(),row:any={tab,q,started_at:new Date().toISOString(),timeline:[]};out.queries.push(row);
 console.log(JSON.stringify({event:'started',tab,q}));
 try{
  const get=client();await get('/api/session');
  let s:any;
  if(tab==='videos'){
   s=await get(`/api/search?${new URLSearchParams({q,tier:'ssj3',mode:'refresh',limit:'10'})}`);
   row.initial=s;
   for(;;){
    row.timeline.push({ms:Date.now()-started,status:s.status,revision:s.revision,verification:s.verification,count:s.ranked?.length??s.results?.length});
    if(s.status!=='discovering'&&s.verification?.status!=='running'||Date.now()-started>600000)break;
    await sleep(2000);s=await get(`/api/search/${s.search_id}`);
   }
   row.final=s;
   if(s.discovery_job_id)row.closest=await get(`/api/search/${s.search_id}/closest`);
  }else{
   s=await get(`/api/web?${new URLSearchParams({q,kind:'web',tier:'ssj3'})}`);row.initial=s;
   if(s.review){const token=s.review;
    do{await sleep(2000);s=await get(`/api/web/review?token=${encodeURIComponent(token)}`);
     row.timeline.push({ms:Date.now()-started,status:s.status,count:s.results?.length});
    }while(s.status!=='complete'&&Date.now()-started<300000);
   }row.final=s;
  }
 }catch(e){row.error=e instanceof Error?e.message:String(e);}
 row.elapsed_ms=Date.now()-started;await save();
 console.log(JSON.stringify({event:'finished',tab,q,ms:row.elapsed_ms,status:row.final?.status,count:row.final?.results?.length,error:row.error}));
}
await Promise.all([
 (async()=>{await run('videos','moment in the Falcon Heavy test flight video when both side boosters land at the same time');
 await run('videos','hindi explainer on how UPI works, under 10 minutes, not from big news channels');})(),
 run('web','how long can cooked rice be safely kept in the fridge')]);
out.finished_at=new Date().toISOString();await save();console.log('Saved '+file);
