import type { DB } from './db.js';
import type { Config } from './config.js';
import type { SearchInput, Result, ProviderStatus, Moment } from './types.js';
import { rank } from './ranking.js';
import { embed } from './embeddings.js';
import { activeScene, sceneMoment, sceneSelect } from './scenes.js';
import { captionWeight } from './moments.js';
import { queryKeys } from './phonetic.js';

const eligible = `s.status='active' AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
 AND (s.policy->>'metadata')::boolean=true AND c.availability<>'unavailable'
 -- c.language IS NULL means nobody recorded one, which is not a mismatch; see matchesFilters.
 AND c.expires_at>now() AND ($2::text IS NULL OR c.language IS NULL OR c.language=$2) AND ($3::uuid IS NULL OR c.source_id=$3)
 AND ($4::timestamptz IS NULL OR c.published_at>=$4)
 AND ($5='any' OR EXISTS(SELECT 1 FROM moments m WHERE m.content_id=c.id AND m.status='active' AND m.evidence_type=$5
   AND m.search_vector @@ websearch_to_tsquery('english',$1))
   OR ($5='video_analysed' AND EXISTS(SELECT 1 FROM video_scenes v WHERE v.content_id=c.id AND ${activeScene}
   AND v.search_vector @@ websearch_to_tsquery('english',$1))))`;

// Sound matches count half as much as an exact list, so exact evidence still outranks them.
export const PHONETIC_WEIGHT = 0.5;
export async function retrieve(db: DB, config: Config, input: SearchInput, owner: string) {
 const args = [input.q,input.language??null,input.source??null,input.after??null,input.evidence];
 const lexical = (await db.query(`SELECT c.id,ts_rank_cd(c.search_vector,websearch_to_tsquery('english',$1),32) AS score
   FROM content c JOIN sources s ON s.id=c.source_id WHERE ${eligible}
   AND c.search_vector @@ websearch_to_tsquery('english',$1) ORDER BY score DESC,c.id LIMIT 200`,args)).rows;
 // Transcript windows and analysed scenes form one timestamped-evidence ranking list.
 const momentMatches = (await db.query(`SELECT id,max(score) AS score FROM (
   SELECT c.id,ts_rank_cd(m.search_vector,websearch_to_tsquery('english',$1),32)*${captionWeight('m')} AS score
   FROM content c JOIN sources s ON s.id=c.source_id JOIN moments m ON m.content_id=c.id
   WHERE ${eligible} AND m.status='active' AND m.search_vector @@ websearch_to_tsquery('english',$1)
   UNION ALL
   SELECT c.id,ts_rank_cd(v.search_vector,websearch_to_tsquery('english',$1),32)
   FROM content c JOIN sources s ON s.id=c.source_id JOIN video_scenes v ON v.content_id=c.id
   WHERE ${eligible} AND ${activeScene} AND v.search_vector @@ websearch_to_tsquery('english',$1)
 ) evidence GROUP BY id ORDER BY score DESC,id LIMIT 200`,args)).rows;
 // Sound-tolerant matches (src/phonetic.ts): a caption line and the next holding the sound of every query word, as when Hindi
 // captions spell English words in Devanagari or auto-captions mishear them. A half-weight ranking list: exact matches win.
 const keys = queryKeys(input.q);
 const phonetic = keys.length ? (await db.query(`SELECT c.id FROM content c JOIN sources s ON s.id=c.source_id JOIN moments m ON m.content_id=c.id
   WHERE ${eligible} AND m.status='active' AND m.evidence_type='transcript_supported' AND (s.policy->>'transcripts')::boolean=true
   AND m.sound_keys @> $6::text[] AND EXISTS(SELECT 1 FROM transcript_segments t WHERE t.id=ANY(m.evidence_refs) AND t.sound_keys @> $6::text[])
   GROUP BY c.id ORDER BY max(${captionWeight('m')}) DESC,c.id LIMIT 200`,[...args,keys])).rows : [];
 let semantic: {id:string;moment_ids?:string[];scene_ids?:string[]}[] = []; const providers: ProviderStatus[] = [];
 if (config.SEMANTIC_ENABLED) {
   try {
     const vector = await embed(db,config,input.q);
     // Restrict semantic augmentation to lexical/moment matches when explicit search operators exist.
     // This preserves exclusion and phrase constraints instead of silently weakening them.
     if (vector && !/["\-]|\bOR\b/.test(input.q)) semantic = (await db.query(`SELECT id,
       array_agg(moment_id) FILTER (WHERE moment_id IS NOT NULL) AS moment_ids,
       array_agg(scene_id) FILTER (WHERE scene_id IS NOT NULL) AS scene_ids FROM (
       SELECT c.id,(e.embedding <=> $8::vector) AS distance,NULL::uuid AS moment_id,NULL::uuid AS scene_id FROM embeddings e
       JOIN content c ON c.id=e.content_id JOIN sources s ON s.id=c.source_id
       WHERE ${eligible} AND e.model=$6 AND vector_dims(e.embedding)=$7
       AND e.created_at >= c.fetched_at AND (e.embedding <=> $8::vector)<0.45
       UNION ALL SELECT c.id,(e.embedding <=> $8::vector) AS distance,e.moment_id,e.scene_id FROM evidence_embeddings e
       JOIN content c ON c.id=e.content_id JOIN sources s ON s.id=c.source_id
       LEFT JOIN moments m ON m.id=e.moment_id AND m.content_id=c.id
       LEFT JOIN video_scenes v ON v.id=e.scene_id AND v.content_id=c.id
       LEFT JOIN media_versions mv ON mv.id=v.media_version_id
       WHERE ${eligible} AND e.model=$6 AND vector_dims(e.embedding)=$7 AND (e.embedding <=> $8::vector)<0.45
       AND ((m.status='active' AND m.evidence_type='transcript_supported' AND (s.policy->>'transcripts')::boolean=true)
         OR (${activeScene} AND mv.status='current' AND mv.access_status='accessible'))
       ) matches GROUP BY id ORDER BY min(distance),id LIMIT 200`,[...args,config.EMBEDDING_MODEL,config.EMBEDDING_DIMENSIONS,JSON.stringify(vector)])).rows;
     if (!vector) providers.push({provider:'embeddings',status:'disabled',message:'Semantic search is unavailable; keyword search is active.'});
   } catch { providers.push({provider:'embeddings',status:'unavailable',message:'Semantic search is unavailable; keyword search is active.'}); }
 }
 const ids = [...new Set([...lexical,...momentMatches,...semantic,...phonetic].map(r=>r.id))];
 if (!ids.length) return {results:[],strong:0,strongSources:0,providers};
 const rows = (await db.query(`SELECT c.*,s.display_name AS source_name,s.reliability,
   coalesce((SELECT CASE WHEN f.useful THEN 1 ELSE -1 END FROM feedback f WHERE f.owner=$2 AND f.content_id=c.id),0) AS personal
   FROM content c JOIN sources s ON s.id=c.source_id WHERE c.id=ANY($1::uuid[])`,[ids,owner])).rows;
 // A transcript window spans minutes, so its start is a poor timestamp. Focus on the window's segment sharing the
 // most query terms (any term, so windows found semantically or across segments still focus); none shares one → no focus.
 const moments = (await db.query(`SELECT m.*,f.start_seconds AS focus_start,f.end_seconds AS focus_end FROM moments m
   CROSS JOIN (SELECT nullif(replace(plainto_tsquery('english',$2)::text,' & ',' | '),'')::tsquery AS terms) q
   LEFT JOIN LATERAL (SELECT t.start_seconds,t.end_seconds FROM transcript_segments t
     WHERE m.evidence_type='transcript_supported' AND t.id=ANY(m.evidence_refs)
     AND (to_tsvector('english',t.text) @@ q.terms OR (cardinality($5::text[])>0 AND t.sound_keys @> $5::text[]))
     ORDER BY coalesce(ts_rank(to_tsvector('english',t.text),q.terms),0) DESC,t.start_seconds LIMIT 1) f ON true
   WHERE m.content_id=ANY($1::uuid[]) AND m.status='active' AND ($4='any' OR m.evidence_type=$4)
   AND (m.search_vector @@ websearch_to_tsquery('english',$2) OR m.id=ANY($3::uuid[])
     OR (cardinality($5::text[])>0 AND m.evidence_type='transcript_supported' AND m.sound_keys @> $5::text[]
       AND EXISTS(SELECT 1 FROM transcript_segments t WHERE t.id=ANY(m.evidence_refs) AND t.sound_keys @> $5::text[])))
   ORDER BY m.start_seconds,m.id`,[ids,input.q,semantic.flatMap(r=>r.moment_ids??[]),input.evidence,keys])).rows;
 const scenes = (await db.query(`${sceneSelect} WHERE v.content_id=ANY($1::uuid[]) AND ${activeScene}
   AND ($4='any' OR $4='video_analysed')
   AND (v.search_vector @@ websearch_to_tsquery('english',$2) OR v.id=ANY($3::uuid[]))`,[ids,input.q,semantic.flatMap(r=>r.scene_ids??[]),input.evidence])).rows;
 const results = rows.map(row=>{
   const found: Moment[] = [...moments.filter(m=>m.content_id===row.id).map(m=>({id:m.id,
     start_seconds:m.start_seconds,end_seconds:m.end_seconds,summary:m.summary,evidence_type:m.evidence_type,
     analysis_version:m.analysis_version,inspected_ranges:m.inspected_ranges,evidence_refs:m.evidence_refs,
     ...(m.focus_start===null?{}:{focus:[m.focus_start,m.focus_end] as [number,number]})})),
     ...scenes.filter(v=>v.content_id===row.id).map(sceneMoment)]
     .sort((a,b)=>a.start_seconds-b.start_seconds||a.id.localeCompare(b.id)).slice(0,5);
   return {id:row.id,title:row.title,canonical_url:row.canonical_url,source_id:row.source_id,source_name:row.source_name,
     description:row.description,creator:row.creator,published_at:row.published_at?.toISOString()??null,duration:row.duration,
     language:row.language,thumbnail:row.thumbnail,embeddable:row.embeddable,rights_status:row.rights_status,
     license_url:row.license_url,availability:row.availability,evidence:found[0]?.evidence_type??'metadata_match',moments:found,
     origin:'catalogue' as const,verified_at:row.verified_at?.toISOString()??null,reliability:row.reliability,personal:row.personal};
 });
 const strongIds = new Set([...lexical,...momentMatches].filter(r=>r.score >= config.COVERAGE_MIN_SCORE).map(r=>r.id));
 const strongSources = new Set(rows.filter(r=>strongIds.has(r.id)).map(r=>r.source_id)).size;
 return {results:rank(results,[lexical.map(r=>r.id),momentMatches.map(r=>r.id),semantic.map(r=>r.id),phonetic.map(r=>r.id)],[1,1,1,PHONETIC_WEIGHT]),
   strong:strongIds.size,strongSources,providers};
}
