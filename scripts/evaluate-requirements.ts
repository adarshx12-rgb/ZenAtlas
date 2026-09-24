// Compares the pipeline without a requirements contract (baseline), the full requirements pipeline (new), and the
// requirements pipeline without gap-directed exploration (ablation), on evaluation/requirements-queries.json.
//
//   run <out.json> [--max N]     live searches through the configured providers and models (default cap: 12)
//   report <out.json> [review]   Markdown summary; precision only from a human review file (evaluation/*.review.json)
//
// Model agreement is reported as agreement, never as accuracy. Every run spends the existing daily budgets.
import {readFile,writeFile} from 'node:fs/promises';
import {connect,type DB} from '../src/db.js';
import {readConfig,type Config} from '../src/config.js';
import {runDiscovery} from '../src/discovery.js';
import {searchInput} from '../src/types.js';
import {RANKING_VERSION} from '../src/ranking.js';
import {traceMetrics} from '../src/learning.js';
import {evaluateRanking,reviewSchema} from '../src/evaluation.js';

type Variant='baseline'|'new'|'ablation';
const VARIANTS:Record<Variant,(c:Config)=>Config>={
 baseline:c=>({...c,REQUIREMENTS_ENABLED:false}),
 new:c=>({...c,REQUIREMENTS_ENABLED:true,GAP_EXPLORATION:true}),
 ablation:c=>({...c,REQUIREMENTS_ENABLED:true,GAP_EXPLORATION:false}),
};
// Unit prices used only for the stated estimate; OpenRouter chat models are reported as call counts.
const PRICES={brave_per_call:0.005,jev_per_call:0.0004};

async function budgets(db:DB):Promise<Map<string,number>>{
 const rows=(await db.query<{bucket:string;used:number}>(`SELECT bucket,used FROM budgets WHERE window_start=date_trunc('day',now())`)).rows;
 return new Map(rows.map(r=>[r.bucket,Number(r.used)]));
}
const diff=(before:Map<string,number>,after:Map<string,number>)=>Object.fromEntries([...after].map(([k,v])=>[k,v-(before.get(k)??0)]).filter(([,v])=>Number(v)>0));

const [command,file,...rest]=process.argv.slice(2);
if(command==='run'&&file){
 const max=Number(rest[rest.indexOf('--max')+1]??12)||12;
 const spec=JSON.parse(await readFile('evaluation/requirements-queries.json','utf8'));
 const config=readConfig(),db=connect(config.DATABASE_URL);
 const runs:any[]=[];let spent=0;
 try{
   for(const item of spec.queries) for(const variant of Object.keys(VARIANTS) as Variant[]){
     if(spent>=max){console.log(JSON.stringify({event:'cap_reached',max}));break;}
     spent++;
     const before=await budgets(db),started=Date.now();
     console.log(JSON.stringify({event:'run_started',q:item.q,variant}));
     try{
       // mode refresh: every variant searches live rather than reusing another variant's cached job.
       const out=await runDiscovery(db,VARIANTS[variant](config),searchInput.parse({q:item.q,depth:item.depth,mode:'refresh'}),undefined,{},async()=>{});
       const calls=diff(before,await budgets(db));
       const brave=calls['discovery:brave']??0,jev=Object.entries(calls).filter(([k])=>k.startsWith('jev_')).reduce((s,[,v])=>s+Number(v),0);
       runs.push({q:item.q,variant,elapsed_ms:Date.now()-started,calls,
         estimated_cost_usd:{brave:+(brave*PRICES.brave_per_call).toFixed(4),jev:+(jev*PRICES.jev_per_call).toFixed(4),note:'Brave and Jev only; chat-model calls are counted, not priced'},
         metrics:traceMetrics(out.trace),unmet:out.unmet??[],contract:out.contract??null,gaps:out.trace.gaps??null,
         providers:out.providers.map(p=>({provider:p.provider,status:p.status,message:p.message})),
         shown:out.results.map((r,i)=>({rank:i+1,url:r.canonical_url,title:r.title,relevance:r.judgement?.relevance??null,model:r.judgement?.model??null,
           reason:r.judgement?.reason??null,requirements:r.requirements??null,uncertainties:r.uncertainties??[]})),
         closest:out.closest.map(r=>({url:r.canonical_url,title:r.title,uncertainties:r.uncertainties??[]}))});
     }catch(error){runs.push({q:item.q,variant,elapsed_ms:Date.now()-started,error:String(error)});}
     await writeFile(file,JSON.stringify({ranking_version:RANKING_VERSION,generated_at:new Date().toISOString(),human_judged:false,runs},null,2)+'\n');
     console.log(JSON.stringify({event:'run_complete',q:item.q,variant,shown:runs.at(-1).shown?.length??0}));
   }
   // One template per query holding every URL any variant showed, so a reviewer grades each URL once, blind to variant.
   const review={reviewer:'',instructions:'Grade each URL against the request: 0 does not meet it, 1 plausible or partial, 2 meets it. Check the reviewer_checks for the query. Leave grade null if unsure.',
     queries:spec.queries.map((s:any)=>({q:s.q,reviewer_checks:s.reviewer_checks,candidates:[...new Map(runs.filter(r=>r.q===s.q).flatMap(r=>r.shown??[])
       .map((c:any)=>[c.url,{url:c.url,title:c.title,grade:null,notes:''}])).values()].sort((a:any,b:any)=>a.url.localeCompare(b.url))}))};
   await writeFile(`${file}.review.json`,JSON.stringify(review,null,2)+'\n');
 }finally{await db.close();}
}else if(command==='report'&&file){
 const data=JSON.parse(await readFile(file,'utf8'));
 const review=rest[0]?reviewSchema.safeParse(JSON.parse(await readFile(rest[0],'utf8'))):null;
 const graded=review?.success&&review.data.queries.some(q=>q.candidates.some(c=>c.grade!==null))?review.data:null;
 const pct=(v:number|null|undefined)=>v===null||v===undefined?'—':`${Math.round(v*100)}%`;
 const lines=[`| Query | Variant | Shown | Req. satisfaction | Unknown rate | Gap visits | Gain / visit | Latency | Calls | Est. Brave+Jev $ | Human precision@shown |`,
   '|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|'];
 for(const r of data.runs){
   if(r.error){lines.push(`| ${r.q} | ${r.variant} | error: ${r.error} |||||||||`);continue;}
   const grades=graded?new Map(graded.queries.find(q=>q.q===r.q)?.candidates.map(c=>[c.url,c.grade])??[]):null;
   const human=grades?evaluateRanking(r.shown.map((s:any)=>s.url),grades,Math.max(1,r.shown.length)):null;
   const calls=Object.entries(r.calls).map(([k,v])=>`${k.replace('discovery:','')} ${v}`).join(', ');
   lines.push(`| ${r.q} | ${r.variant} | ${r.shown.length} | ${pct(r.metrics.requirement_satisfaction)} | ${pct(r.metrics.unknown_rate)} | ${r.metrics.gap_visits??'—'} | ${r.metrics.coverage_gain_per_visit?.toFixed?.(2)??'—'} | ${(r.elapsed_ms/1000).toFixed(1)} s | ${calls} | ${(r.estimated_cost_usd.brave+r.estimated_cost_usd.jev).toFixed(3)} | ${human?.precision!=null?pct(human.precision):'not human-graded'} |`);
 }
 console.log(lines.join('\n'));
}else throw new Error('Usage: evaluate-requirements.ts run out.json [--max N] | report out.json [review.json]');
