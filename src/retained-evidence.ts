import type {DB} from './db.js';
import type {Config} from './config.js';
import type {Moment,Result} from './types.js';
import {activeScene,sceneSelect,sceneMoment} from './scenes.js';
import {youtubeId} from './youtube.js';
import {takeBudget} from './budgets.js';
import {captionWeight} from './moments.js';

export async function retainedEvidence(db:DB,ids:string[],query:string) {
 const rows=(await db.query(`SELECT c.id,x.* FROM content c JOIN sources s ON s.id=c.source_id
 CROSS JOIN LATERAL (SELECT m.id AS evidence_id,m.start_seconds,m.end_seconds,m.summary,m.evidence_type
   FROM moments m WHERE m.content_id=c.id AND m.status='active' AND m.evidence_type='transcript_supported'
   AND (s.policy->>'transcripts')::boolean=true
   ORDER BY ts_rank_cd(m.search_vector,websearch_to_tsquery('english',$2))*${captionWeight('m')} DESC,m.start_seconds LIMIT 3) x
 WHERE c.id=ANY($1::uuid[]) AND c.expires_at>now() AND c.availability<>'unavailable'
 AND s.status='active' AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain`,[ids,query])).rows;
 const scenes=(await db.query(`${sceneSelect} WHERE v.content_id=ANY($1::uuid[]) AND ${activeScene}
 AND mv.status='current' AND mv.access_status='accessible' AND c.expires_at>now() AND c.availability<>'unavailable'
 AND s.status='active' AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
 ORDER BY ts_rank_cd(v.search_vector,websearch_to_tsquery('english',$2)) DESC,v.start_seconds`,[ids,query])).rows;
 return new Map(ids.map(id=>[id,{transcripts:rows.filter(r=>r.id===id).map(r=>({start:r.start_seconds,end:r.end_seconds,text:r.summary.slice(0,2400)})),
   scenes:scenes.filter(r=>r.content_id===id).slice(0,3).map(sceneMoment)}]));
}

// Where a judge's verbatim transcript quote starts in the stored captions: the caption line it begins on, never a guessed
// time. Quotes not found word for word (after whitespace and case folding) give no moment.
const fold = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export async function quoteMoments(db: DB, quotes: Map<string, string[]>): Promise<Map<string, Moment[]>> {
 const out = new Map<string, Moment[]>();
 if (!quotes.size) return out;
 const rows = (await db.query(`SELECT id,content_id,start_seconds,end_seconds,text FROM transcript_segments
   WHERE content_id=ANY($1::uuid[]) ORDER BY content_id,start_seconds`, [[...quotes.keys()]])).rows;
 for (const [id, list] of quotes) {
   const segments = rows.filter(r => r.content_id === id), offsets: number[] = [];
   let text = '';
   for (const s of segments) { offsets.push(text.length); text += `${fold(s.text)} `; }
   const moments: Moment[] = [], seen = new Set<string>();
   for (const quote of list) {
     const wanted = fold(quote), at = wanted.length >= 8 ? text.indexOf(wanted) : -1;
     if (at < 0) continue;
     const first = segments[offsets.findLastIndex(o => o <= at)], last = segments[offsets.findLastIndex(o => o < at + wanted.length)];
     if (seen.has(String(first.id))) continue;
     seen.add(String(first.id));
     const start = Number(first.start_seconds), end = Number(last.end_seconds);
     moments.push({id: `quote:${first.id}`, start_seconds: start, end_seconds: end, summary: quote.slice(0, 300), evidence_type: 'transcript_supported',
       analysis_version: 'judge-quote-v1', inspected_ranges: [[start, end]], evidence_refs: [String(first.id)], focus: [start, end]});
   }
   if (moments.length) out.set(id, moments.slice(0, 3));
 }
 return out;
}

// Register only the canonical YouTube timeline, or reuse an explicitly registered local media version.
// Fresh analyses run in the Python worker; completed evidence participates in subsequent final reviews.
// minRelevance: 6 for shown results; 3 for closest candidates when nothing could be verified without watching.
export async function queueSceneShortlist(db:DB,config:Config,results:Result[],query:string,minRelevance=6) {
 if(!config.SCENE_AUTO_QUEUE || !config.GEMINI_API_KEY) return 0;
 let queued=0;
 for(const result of results.filter(r=>(r.judgement?.relevance??0)>=minRelevance).slice(0,config.SCENE_SHORTLIST)) {
   await db.transaction(async tx=>{
     const row=(await tx.query(`SELECT c.*,s.policy FROM content c JOIN sources s ON s.id=c.source_id
       WHERE c.id=$1 AND s.status='active' AND s.health_status<>'down' AND c.expires_at>now()
       AND c.availability<>'unavailable' AND (s.policy->>'video_analysis')::boolean=true
       AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain FOR UPDATE OF c`,[result.id])).rows[0];
     if(!row) return;
     let version=(await tx.query("SELECT * FROM media_versions WHERE content_id=$1 AND status='current'",[row.id])).rows[0];
     const id=youtubeId(row.canonical_url);
     if(!version && id && row.duration>0 && row.duration<=2700) {
       version=(await tx.query(`INSERT INTO media_versions(content_id,version_key,media_kind,media_reference,fingerprint,
         duration_seconds,duration_source,timeline_offset_seconds,offset_basis,provenance)
         VALUES($1,$2,'youtube',$3,$4,$5,'content_metadata',0,'Canonical YouTube timeline.',
         '{"method":"discovery_shortlist","duration":"youtube_metadata"}') RETURNING *`,[row.id,`youtube:${id}`,row.canonical_url,id,row.duration])).rows[0];
     }
     if(!version || version.analysis_status!=='pending') return;
     if((await tx.query("SELECT 1 FROM jobs WHERE kind='scene_analysis' AND payload->>'media_version_id'=$1 AND status IN ('queued','running')",[version.id])).rows.length) return;
     if(!await takeBudget(tx,'scene_auto_jobs',20)) return;
     const job=await tx.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES('scene_analysis',$1,$2)
       ON CONFLICT DO NOTHING RETURNING id`,[`scene:${version.id}:${config.GEMINI_MODEL}:gemini-scenes-v2`,
       JSON.stringify({media_version_id:version.id,model:config.GEMINI_MODEL,query:query.slice(0,500)})]);
     queued+=job.rows.length;
   });
 }
 return queued;
}
