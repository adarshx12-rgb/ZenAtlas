import {readFile,writeFile} from 'node:fs/promises';
import {connect} from '../src/db.js';
import {readConfig} from '../src/config.js';
import {runDiscovery} from '../src/discovery.js';
import {searchInput} from '../src/types.js';
import {RANKING_VERSION} from '../src/ranking.js';
import {evaluateRanking,reviewSchema} from '../src/evaluation.js';
import {applySignals} from '../src/signals.js';
import type {Result} from '../src/types.js';
import {randomUUID} from 'node:crypto';
const [command,file,other,gradesFile]=process.argv.slice(2);
if(command==='recheck' && file && other) {
 const input=JSON.parse(await readFile(file,'utf8'));
 const specification=JSON.parse(await readFile('evaluation/real-queries.json','utf8'));
 const config=readConfig(),db=connect(config.DATABASE_URL),queries=[];
 try {
   for(const item of input.queries) {
     console.log(JSON.stringify({event:'recheck_started',q:item.q}));
     const urls=item.candidates.map((c:any)=>c.url);
     const retained=(await db.query('SELECT c.*,s.display_name FROM content c JOIN sources s ON s.id=c.source_id WHERE canonical_url=ANY($1::text[])',[urls])).rows;
     const results:Result[]=item.candidates.map((c:any)=>{
       const row=retained.find(r=>r.canonical_url===c.url);
       return {id:row?.id??randomUUID(),source_id:row?.source_id??randomUUID(),source_name:row?.display_name??new URL(c.url).hostname,
         canonical_url:c.url,title:row?.title??c.title,description:row?.description??c.description??null,
         creator:row?.creator??null,published_at:row?.published_at?.toISOString()??null,duration:row?.duration??null,language:row?.language??null,
         thumbnail:null,embeddable:null,rights_status:'unknown',license_url:null,availability:row?.availability??'unknown',
         evidence:'metadata_match',moments:[],origin:'discovery',verified_at:null};
     });
     const kind=item.q.includes('github')?'websites' as const:'videos' as const;
     const checked=await applySignals(db,{...config,JUDGE_CANDIDATES:results.length},item.q,results,{},
       {kind,criteria:[specification.queries.find((q:any)=>q.q===item.q)?.criteria??item.q],targets:new Map(results.map(r=>[r.id,kind==='websites'?'web':'videos']))});
     queries.push({q:item.q,previous_count:results.length,providers:checked.providers,candidates:checked.results.map(r=>({url:r.canonical_url,title:r.title,
       description:r.description,judgement:r.judgement,evidence_coverage:r.evidence_coverage})),
       excluded:results.filter(r=>!checked.results.some(c=>c.canonical_url===r.canonical_url)).map(r=>({url:r.canonical_url,title:r.title}))});
     await writeFile(other,JSON.stringify({ranking_version:RANKING_VERSION,kind:'same_candidate_pool_fresh_evidence_recheck',human_judged:false,queries},null,2)+'\n');
     console.log(JSON.stringify({event:'recheck_complete',q:item.q,kept:checked.results.length,excluded:results.length-checked.results.length}));
   }
 }finally{await db.close();}
} else if(command==='capture' && file) {
 const config=readConfig(),db=connect(config.DATABASE_URL);
 const specification=JSON.parse(await readFile('evaluation/real-queries.json','utf8'));
 const queries=[];
 try {
   for(const item of specification.queries) {
     const started=Date.now();console.log(JSON.stringify({event:'evaluation_query_started',q:item.q}));
     const result=await runDiscovery(db,config,searchInput.parse({q:item.q,depth:'deep',mode:'refresh'}),undefined,{},async()=>{});
     queries.push({q:item.q,criteria:item.criteria,elapsed_ms:Date.now()-started,providers:result.providers,
       candidates:result.results.map(r=>({url:r.canonical_url,title:r.title,description:r.description,evidence:r.evidence,
         judgement:r.judgement,moments:r.moments,evidence_coverage:r.evidence_coverage}))});
     await writeFile(file,JSON.stringify({ranking_version:RANKING_VERSION,generated_at:new Date().toISOString(),human_judged:false,queries},null,2)+'\n');
     console.log(JSON.stringify({event:'evaluation_query_complete',q:item.q,count:result.results.length}));
   }
   await writeFile(`${file}.review.json`,JSON.stringify({reviewer:'',queries:queries.map(q=>({q:q.q,criteria:q.criteria,
     candidates:[...q.candidates].sort((a,b)=>a.url.localeCompare(b.url)).map(c=>({url:c.url,title:c.title,grade:null,notes:''}))}))},null,2)+'\n');
 } finally {await db.close();}
} else if(command==='compare' && file && other && gradesFile) {
 const [baseline,current,review]=await Promise.all([file,other,gradesFile].map(f=>readFile(f,'utf8').then(JSON.parse)));
 const graded=reviewSchema.parse(review);
 const queries=graded.queries.map(q=>{
   const grades=new Map(q.candidates.map(c=>[c.url,c.grade]));
   const before=baseline.queries.find((r:any)=>r.q===q.q),after=current.queries.find((r:any)=>r.q===q.q);
   if(!before||!after) throw new Error('Both captures must contain each reviewed query');
   return {q:q.q,baseline:evaluateRanking(before.candidates.map((c:any)=>c.url),grades),current:evaluateRanking(after.candidates.map((c:any)=>c.url),grades)};
 });
 console.log(JSON.stringify({reviewer:graded.reviewer,metrics:'Human relevance; accuracy and timestamp correctness require separate inspection.',queries},null,2));
} else throw new Error('Usage: evaluate-real.ts capture output.json | recheck input.json output.json | compare baseline.json current.json review.json');
