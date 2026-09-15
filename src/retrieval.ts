import type { DB } from './db.js';
import type { Config } from './config.js';
import type { SearchInput, Result, ProviderStatus, Moment } from './types.js';
import { rank } from './ranking.js';
import { embed } from './embeddings.js';

const eligible = `s.status='active' AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
 AND (s.policy->>'metadata')::boolean=true AND c.availability<>'unavailable'
 AND c.expires_at>now() AND ($2::text IS NULL OR c.language=$2) AND ($3::uuid IS NULL OR c.source_id=$3)
 AND ($4::timestamptz IS NULL OR c.published_at>=$4)
 AND ($5='any' OR EXISTS(SELECT 1 FROM moments m WHERE m.content_id=c.id AND m.status='active' AND m.evidence_type=$5
   AND m.search_vector @@ websearch_to_tsquery('english',$1)))`;

export async function retrieve(db: DB, config: Config, input: SearchInput, owner: string) {
 const args = [input.q,input.language??null,input.source??null,input.after??null,input.evidence];
 const lexical = (await db.query(`SELECT c.id,ts_rank_cd(c.search_vector,websearch_to_tsquery('english',$1),32) AS score
   FROM content c JOIN sources s ON s.id=c.source_id WHERE ${eligible}
   AND c.search_vector @@ websearch_to_tsquery('english',$1) ORDER BY score DESC,c.id LIMIT 200`,args)).rows;
 const momentMatches = (await db.query(`SELECT c.id,max(ts_rank_cd(m.search_vector,websearch_to_tsquery('english',$1),32)) AS score
   FROM content c JOIN sources s ON s.id=c.source_id JOIN moments m ON m.content_id=c.id
   WHERE ${eligible} AND m.status='active' AND m.search_vector @@ websearch_to_tsquery('english',$1)
   GROUP BY c.id ORDER BY score DESC,c.id LIMIT 200`,args)).rows;
 let semantic: {id:string}[] = []; const providers: ProviderStatus[] = [];
 if (config.SEMANTIC_ENABLED) {
   try {
     const vector = await embed(db,config,input.q);
     // Restrict semantic augmentation to lexical/moment matches when explicit search operators exist.
     // This preserves exclusion and phrase constraints instead of silently weakening them.
     if (vector && !/["\-]|\bOR\b/.test(input.q)) semantic = (await db.query(`SELECT c.id FROM embeddings e
       JOIN content c ON c.id=e.content_id JOIN sources s ON s.id=c.source_id
       WHERE ${eligible} AND e.model=$6 AND vector_dims(e.embedding)=$7
       AND e.created_at >= c.fetched_at AND (e.embedding <=> $8::vector)<0.45
       ORDER BY e.embedding <=> $8::vector,c.id LIMIT 200`,[...args,config.EMBEDDING_MODEL,config.EMBEDDING_DIMENSIONS,JSON.stringify(vector)])).rows;
     if (!vector) providers.push({provider:'embeddings',status:'disabled',message:'Semantic search is unavailable; keyword search is active.'});
   } catch { providers.push({provider:'embeddings',status:'unavailable',message:'Semantic search is unavailable; keyword search is active.'}); }
 }
 const ids = [...new Set([...lexical,...momentMatches,...semantic].map(r=>r.id))];
 if (!ids.length) return {results:[],strong:0,providers};
 const rows = (await db.query(`SELECT c.*,s.display_name AS source_name,s.reliability,
   coalesce((SELECT CASE WHEN f.useful THEN 1 ELSE -1 END FROM feedback f WHERE f.owner=$2 AND f.content_id=c.id),0) AS personal
   FROM content c JOIN sources s ON s.id=c.source_id WHERE c.id=ANY($1::uuid[])`,[ids,owner])).rows;
 const moments = (await db.query(`SELECT * FROM moments WHERE content_id=ANY($1::uuid[]) AND status='active'
   AND search_vector @@ websearch_to_tsquery('english',$2) ORDER BY start_seconds,id`,[ids,input.q])).rows;
 const results = rows.map(row=>{
   const found: Moment[] = moments.filter(m=>m.content_id===row.id).slice(0,5).map(m=>({id:m.id,
     start_seconds:m.start_seconds,end_seconds:m.end_seconds,summary:m.summary,evidence_type:m.evidence_type,
     analysis_version:m.analysis_version,inspected_ranges:m.inspected_ranges,evidence_refs:m.evidence_refs}));
   return {id:row.id,title:row.title,canonical_url:row.canonical_url,source_id:row.source_id,source_name:row.source_name,
     description:row.description,creator:row.creator,published_at:row.published_at?.toISOString()??null,duration:row.duration,
     language:row.language,thumbnail:row.thumbnail,embeddable:row.embeddable,rights_status:row.rights_status,
     license_url:row.license_url,availability:row.availability,evidence:found[0]?.evidence_type??'metadata_match',moments:found,
     origin:'catalogue' as const,verified_at:row.verified_at?.toISOString()??null,reliability:row.reliability,personal:row.personal};
 });
 const strong = new Set([...lexical,...momentMatches].filter(r=>r.score >= config.COVERAGE_MIN_SCORE).map(r=>r.id)).size;
 return {results:rank(results,[lexical.map(r=>r.id),momentMatches.map(r=>r.id),semantic.map(r=>r.id)]),strong,providers};
}
