import type { Result } from './types.js';
export const RANKING_VERSION = 'rules-v1';
// RRF combines ordinal ranks, never incomparable raw lexical/cosine scores.
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string,number> {
 const scores = new Map<string,number>();
 for (const list of lists) for (const [i,id] of [...new Set(list)].entries()) scores.set(id,(scores.get(id)??0)+1/(k+i+1));
 return scores;
}
export function rank(rows: (Result & {reliability:number;personal:number})[], lists:string[][]): Result[] {
 const scores = reciprocalRankFusion(lists);
 const remaining = rows.map(r=>({row:r,score:(scores.get(r.id)??0)*(1+0.05*r.reliability+0.03*Math.sign(r.personal))}));
 const counts = new Map<string,number>(); const result: Result[] = [];
 while (remaining.length) {
   remaining.sort((a,b) => b.score/(1+0.08*(counts.get(b.row.source_id)??0))-a.score/(1+0.08*(counts.get(a.row.source_id)??0)) || a.row.id.localeCompare(b.row.id));
   const {row} = remaining.shift()!;
   const {reliability: _r, personal: _p, ...item} = row;
   result.push(item); counts.set(row.source_id,(counts.get(row.source_id)??0)+1);
 }
 return result;
}
