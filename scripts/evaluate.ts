import {readFile,writeFile} from 'node:fs/promises';
import {database,fixture,testConfig} from '../tests/helpers.js';
import {SearchService} from '../src/search.js';
import {RANKING_VERSION} from '../src/ranking.js';
const benchmark=JSON.parse(await readFile('evaluation/development.json','utf8'));
const db=await database();
try{
 const keys=new Map<string,string>();
 for(const record of benchmark.records){const item=await fixture(db,record.title,record.description);keys.set(item.id,record.key);}
 type EvaluationRow={query:string;precision_at_10:number;recall_at_10:number;reciprocal_rank:number;ndcg_at_10:number;elapsed_ms:number;returned:number;evidence_types:string[]};
 const service=new SearchService(db,testConfig);const rows:EvaluationRow[]=[];
 for(const query of benchmark.queries){
   const start=performance.now();const result=await service.start({q:query.q,mode:'catalogue',limit:10},'evaluation');
   const grades=result.results.map(r=>Number(query.judgments[keys.get(r.id)!]??0));
   const relevant=grades.filter(g=>g>0).length;const positive=Object.values(query.judgments).filter((g:any)=>g>0).length;
   const dcg=(values:number[])=>values.slice(0,10).reduce((sum,g,i)=>sum+(2**g-1)/Math.log2(i+2),0);
   const ideal=dcg(Object.values(query.judgments).map(Number).sort((a,b)=>b-a));
   const first=grades.findIndex(g=>g>0);
   rows.push({query:query.q,precision_at_10:relevant/10,recall_at_10:positive?relevant/positive:0,
     reciprocal_rank:first<0?0:1/(first+1),ndcg_at_10:ideal?dcg(grades)/ideal:0,
     elapsed_ms:Math.round((performance.now()-start)*100)/100,returned:result.results.length,
     evidence_types:[...new Set(result.results.map(r=>r.evidence))]});
 }
 const avg=(field:string)=>rows.reduce((s,r)=>s+Number((r as any)[field]),0)/rows.length;
 const report={kind:'synthetic_development_only',ranking_version:RANKING_VERSION,generated_at:new Date().toISOString(),
   human_judged:false,live_providers:false,timestamp_quality:'not evaluated',
   mean_precision_at_10:avg('precision_at_10'),mean_recall_at_10:avg('recall_at_10'),mrr:avg('reciprocal_rank'),mean_ndcg_at_10:avg('ndcg_at_10'),queries:rows};
 await writeFile('evaluation/latest-development-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await db.close();}
