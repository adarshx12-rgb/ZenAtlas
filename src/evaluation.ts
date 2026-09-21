import {z} from 'zod';
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
