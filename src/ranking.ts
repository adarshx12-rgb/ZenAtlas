import type { ContentInput, Result } from './types.js';
export const RANKING_VERSION = 'relevance-v8-requirements';
// RRF combines ordinal ranks, never incomparable raw lexical/cosine scores.
export function reciprocalRankFusion(lists: string[][], k = 60, weights: number[] = []): Map<string,number> {
 const scores = new Map<string,number>();
 for (const [l,list] of lists.entries()) for (const [i,id] of [...new Set(list)].entries()) scores.set(id,(scores.get(id)??0)+(weights[l]??1)/(k+i+1));
 return scores;
}
export function rank(rows: (Result & {reliability:number;personal:number})[], lists:string[][], weights: number[] = []): Result[] {
 const scores = reciprocalRankFusion(lists, 60, weights);
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

// query/searchIndex: which planned search found the lead; a lead is scored against the words of the query that found it.
export interface DiscoveryCandidate { item: ContentInput; provider: string; position: number; query?: string; searchIndex?: number }
export const STOPWORDS = new Set(['a','an','the','and','or','of','to','in','on','for','with','by','at','from','is','are','how','what','my','your','video','videos']);
export const tokens = (text: string|null) => (text ?? '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
// Cheap stemming: "recipe" matches "recipes" and "cook" matches "cooking", without matching short words like "on"/"one".
export const sameWord = (term: string, token: string) => token === term ||
 term.length >= 4 && token.length >= 4 && (token.startsWith(term) || term.startsWith(token));
const hasPhrase = (text: string[], phrase: string[]) =>
 text.some((_, i) => phrase.every((word, j) => text[i + j] === word));

export function discoveryQuery(q: string) {
 const phrases = [...q.matchAll(/"([^"]+)"/g)].map(m => tokens(m[1])).filter(p => p.length);
 const unquoted = q.replace(/"[^"]*"/g, ' ');
 const excluded = [...unquoted.matchAll(/(?:^|\s)-([^\s"]+)/g)].flatMap(m => tokens(m[1]));
 const words = tokens(unquoted.replace(/(?:^|\s)-[^\s"]+/g, ' ').replace(/(?:^|\s)[a-z]+:[^\s"]+/gi, ' ').replace(/\bOR\b/g, ' '));
 return { phrases, excluded, terms: [...new Set([...words, ...phrases.flat()])].filter(t => !STOPWORDS.has(t)) };
}

// Orders discovery leads by how well their own title/description match the query, then spreads them
// across sites so one platform cannot fill every slot. Quoted phrases and -exclusions are enforced, as in
// catalogue search. Results with no query word at all are dropped only when other results do match, so a
// provider's own semantic matches survive queries whose words never appear literally. minCoverage additionally
// drops leads that match less of their query than that share (a title word counts fully, a description word half).
export function rankDiscovery<T extends DiscoveryCandidate>(q: string, candidates: T[], limit: number, minCoverage = 0, keepSemantic = false): T[] {
 const query = discoveryQuery(q);
 const termsOf = new Map<string,string[]>([[q, query.terms]]);
 const terms = (text: string) => termsOf.get(text) ?? termsOf.set(text, discoveryQuery(text).terms).get(text)!;
 const unique = new Map<string,{candidate:T;providers:Set<string>;queries:Set<string>;position:number}>();
 const metadataMatch = (c: T) => {
   const title = tokens(c.item.title), detail = tokens(`${c.item.description ?? ''} ${c.item.creator ?? ''}`);
   return query.terms.reduce((sum,t) => sum + (title.some(w => sameWord(t,w)) ? 2 : detail.some(w => sameWord(t,w)) ? 1 : 0), 0);
 };
 // Stable input makes deduplication and score ties independent of network completion order.
 for (const candidate of [...candidates].sort((a,b) => a.item.url.localeCompare(b.item.url) ||
   metadataMatch(b) - metadataMatch(a) || a.position - b.position ||
   a.provider.localeCompare(b.provider) || (a.query ?? q).localeCompare(b.query ?? q))) {
   const found = `${candidate.provider}:${candidate.searchIndex ?? 0}`, asked = candidate.query ?? q;
   const seen = unique.get(candidate.item.url);
   if (!seen) unique.set(candidate.item.url,{candidate,providers:new Set([found]),queries:new Set([asked]),position:candidate.position});
   else { seen.providers.add(found); seen.queries.add(asked); seen.position = Math.min(seen.position,candidate.position); }
 }
 const scored = [];
 for (const {candidate,providers,queries,position} of unique.values()) {
   const title = tokens(candidate.item.title);
   const text = [...title,...tokens(candidate.item.description),...tokens(candidate.item.creator)];
   if (query.excluded.some(word => text.some(t => sameWord(word,t)))) continue;
   if (!query.phrases.every(phrase => hasPhrase(text,phrase))) continue;
   const coverOf = (list: string[]) => list.length ? list.reduce((sum,term) =>
     sum + (title.some(t => sameWord(term,t)) ? 1 : text.some(t => sameWord(term,t)) ? 0.5 : 0), 0) / list.length : 0;
   const coverage = Math.max(...[...queries].map(asked => coverOf(terms(asked))));
   const exact = query.terms.length > 1 && hasPhrase(title.filter(t => !STOPWORDS.has(t)),query.terms) ? 0.25 : 0;
   scored.push({candidate,coverage,domain:new URL(candidate.item.url).hostname.replace(/^www\./,''),
     score:coverage + exact + 0.3/(1 + position/10) + 0.1*(providers.size - 1)});
 }
 const strong = scored.some(s => s.coverage >= 0.5);
 const remaining = scored.filter(s => s.coverage >= minCoverage && (keepSemantic || !strong || s.coverage > 0));
 const counts = new Map<string,number>(); const result: T[] = [];
 while (remaining.length && result.length < limit) {
   let best = 0, bestValue = -Infinity;
   remaining.forEach((s,i) => { const value = s.score/(1 + 0.35*(counts.get(s.domain) ?? 0)); if (value > bestValue) { bestValue = value; best = i; } });
   const [pick] = remaining.splice(best,1);
   result.push(pick.candidate); counts.set(pick.domain,(counts.get(pick.domain) ?? 0) + 1);
 }
 return result;
}
