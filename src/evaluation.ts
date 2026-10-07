import {z} from 'zod';
// Attribute usage to a search, not to every log line emitted while it was running.
export function summarizeCosts(lines: any[], traceId?: string) {
 const costs = traceId ? lines.filter(l => l.event === 'model_cost' && l.trace_id === traceId) : [];
 const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
 const known = costs.filter(l => valid(l.cost));
 const sum = (rows: any[]) => +rows.reduce((n,l) => n+l.cost,0).toFixed(6);
 const byRole: Record<string, number|null> = {};
 for (const role of new Set(costs.map(l=>String(l.bucket).replace(/:.*$/,'')))) {
   const rows=costs.filter(l=>String(l.bucket).replace(/:.*$/,'')===role);
   byRole[role]=rows.every(l=>valid(l.cost))?sum(rows):null;
 }
 return {cost_usd: costs.length && known.length===costs.length ? sum(known) : null,
   reported_cost_usd: known.length?sum(known):null, by_role:byRole, calls:costs.length,
   unpriced_calls:costs.length-known.length, scope:traceId?'trace':'unattributed'};
}

export interface AnswerEvalRow {
 id:string; kind:string; error?:string; answer_ms:number|null; cost_usd:number|null; answer_cost_usd:number|null;
 proposed:number|null; answer:{status:string;claims:{text:string}[]}|null;
}
export type AnswerLabels=Record<string,{claims:Record<string,0|1|2>;useful?:0|1|2}>;
export function scoreAnswers(rows:AnswerEvalRow[],labels:AnswerLabels) {
 const mean=(values:number[],places=2)=>values.length?+(values.reduce((a,b)=>a+b,0)/values.length).toFixed(places):null;
 const asked=rows.filter(r=>r.kind!=='skip'), skips=rows.filter(r=>r.kind==='skip');
 const ready=asked.filter(r=>!r.error&&r.answer?.status==='ready');
 const grades=ready.flatMap(r=>r.answer!.claims.map(c=>labels[r.id]?.claims[c.text]));
 const ungraded=grades.filter(g=>g===undefined).length;
 const useful=ready.map(r=>labels[r.id]?.useful);
 const costs=rows.map(r=>r.cost_usd), answerCosts=asked.map(r=>r.answer_cost_usd);
 return {queries:asked.length,errors:rows.filter(r=>r.error).length,answered:`${ready.length}/${asked.length}`,
   skipped_ok:`${skips.filter(r=>!r.error&&!r.answer).length}/${skips.length}`,
   claims_kept:ready.reduce((n,r)=>n+r.answer!.claims.length,0),
   claims_proposed:ready.some(r=>r.proposed===null)?null:ready.reduce((n,r)=>n+r.proposed!,0),
   claim_grade:ungraded?null:mean(grades as number[]),
   wrong:ungraded||!grades.length?null:grades.filter(g=>g===0).length/grades.length,ungraded,
   useful:useful.some(g=>g===undefined)?null:mean(useful as number[]),
   answer_s:mean(ready.flatMap(r=>r.answer_ms===null?[]:[r.answer_ms/1000])),
   answer_usd:answerCosts.some(c=>c===null)?null:mean(answerCosts as number[],6),
   search_usd:costs.some(c=>c===null)?null:mean(costs as number[],6)};
}
export const reviewSchema=z.object({reviewer:z.string().min(1),queries:z.array(z.object({q:z.string(),
 candidates:z.array(z.object({url:z.string().url(),grade:z.number().int().min(0).max(3).nullable(),notes:z.string().default('')}))}))});
export function evaluateRanking(urls:string[],grades:Map<string,number|null>,k=10) {
 const top=[...new Set(urls)].slice(0,k),values=top.map(url=>grades.get(url));
 const judged=values.filter(v=>v!==undefined&&v!==null).length;
 if(judged<top.length || !top.length) return {judged,returned:top.length,coverage:top.length?judged/top.length:0,precision:null,ndcg:null,reciprocal_rank:null};
 const known=values as number[];
 const dcg=(g:number[])=>g.reduce((sum,x,i)=>sum+(2**x-1)/Math.log2(i+2),0);
 const ideal=dcg([...grades.values()].filter((g):g is number=>g!==null).sort((a,b)=>b-a).slice(0,k));
 const first=known.findIndex(g=>g>=2);
 return {judged,returned:top.length,coverage:1,precision:known.filter(g=>g>=2).length/k,
   ndcg:[...grades.values()].some(g=>g===null)?null:ideal?dcg(known)/ideal:0,reciprocal_rank:first<0?0:1/(first+1)};
}
