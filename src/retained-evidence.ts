import type {DB} from './db.js';
import type {Config} from './config.js';
import type {Moment,Result} from './types.js';
import {activeScene,sceneSelect,sceneMoment} from './scenes.js';
import {youtubeId} from './youtube.js';
import {takeBudget} from './budgets.js';
import {captionWeight} from './moments.js';
import {transcriptPassages} from './transcript-passages.js';
import {chooseSceneWindow,chooseSceneWindows,covered,type SceneWindow,type SceneInterval} from './scene-window.js';

// options.maxChars: the judge reads each transcript in full up to that many characters (verbatim passages in time order,
// spec 2026-09-29-link-building) instead of the three windows ranked against the query; options.terms choose which
// passages a longer transcript keeps.
export async function retainedEvidence(db:DB,ids:string[],query:string,options:{terms?:string[];maxChars?:number}={}) {
 const retained=await rankedEvidence(db,ids,query);
 if(!options.maxChars) return retained;
 // Only transcripts that still have an active window, so a revoked transcript never reaches the judge.
 const segs=(await db.query(`SELECT t.content_id,t.start_seconds,t.end_seconds,t.text FROM transcript_segments t
   JOIN content c ON c.id=t.content_id JOIN sources s ON s.id=c.source_id
   WHERE t.content_id=ANY($1::uuid[]) AND (s.policy->>'transcripts')::boolean=true AND c.expires_at>now() AND c.availability<>'unavailable'
   AND s.status='active' AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
   AND EXISTS(SELECT 1 FROM moments m WHERE m.content_id=c.id AND m.status='active' AND m.evidence_type='transcript_supported')
   ORDER BY t.content_id,t.start_seconds`,[ids])).rows;
 for(const [id,evidence] of retained){
   const own=segs.filter(r=>r.content_id===id).map(r=>({start:Number(r.start_seconds),end:Number(r.end_seconds),text:String(r.text)}));
   if(own.length) evidence.transcripts=transcriptPassages(own,options.terms??[],options.maxChars);
 }
 return retained;
}

async function rankedEvidence(db:DB,ids:string[],query:string) {
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
 // Each moment carries the id of the stored transcript window around the quote, so it is checked and revoked like any other.
 const windows = (await db.query(`SELECT id,content_id,start_seconds,end_seconds FROM moments
   WHERE content_id=ANY($1::uuid[]) AND evidence_type='transcript_supported' AND status='active'`, [[...quotes.keys()]])).rows;
 for (const [id, list] of quotes) {
   const segments = rows.filter(r => r.content_id === id), offsets: number[] = [];
   let text = '';
   for (const s of segments) { offsets.push(text.length); text += `${fold(s.text)} `; }
   const moments: Moment[] = [], seen = new Set<string>();
   for (const quote of list) {
     const wanted = fold(quote), at = wanted.length >= 8 ? text.indexOf(wanted) : -1;
     if (at < 0) continue;
     const first = segments[offsets.findLastIndex(o => o <= at)], last = segments[offsets.findLastIndex(o => o < at + wanted.length)];
     const start = Number(first.start_seconds), end = Number(last.end_seconds);
     const window = windows.find(w => w.content_id === id && Number(w.start_seconds) <= start && start <= Number(w.end_seconds));
     if (!window || seen.has(String(first.id))) continue;
     seen.add(String(first.id));
     moments.push({id: String(window.id), start_seconds: start, end_seconds: end, summary: quote.slice(0, 300), evidence_type: 'transcript_supported',
       analysis_version: 'judge-quote-v1', inspected_ranges: [[start, end]], evidence_refs: [String(first.id)], focus: [start, end]});
   }
   if (moments.length) out.set(id, moments.slice(0, 3));
 }
 return out;
}

// Register only the canonical YouTube timeline, or reuse an explicitly registered local media version.
// Fresh analyses run in the Python worker; completed evidence participates in subsequent final reviews.
// minRelevance: 6 for shown results; 3 for closest candidates when nothing could be verified without watching.
// window: picks the stretch of a long video its transcript ties to the query (src/scene-window.ts); null analyses it whole.
export async function queueSceneShortlist(db:DB,config:Config,results:Result[],query:string,minRelevance=6,
 window:(query:string,segments:{start:number;end:number;text:string}[],duration:number)=>Promise<SceneWindow|null>=(q,s,d)=>chooseSceneWindow(db,config,q,s,d)) {
 return (await requestSceneAnalysis(db,config,results,query,{minRelevance,window})).filter(j=>j.created).length;
}

export interface SceneRequest {content_id:string;job_id:string;created:boolean}
export async function requestSceneAnalysis(db:DB,config:Config,results:Result[],query:string,options:{
 minRelevance?:number;interactive?:boolean;requirements?:{id:string;text:string}[];deadline?:string;
 window?:(query:string,segments:{start:number;end:number;text:string}[],duration:number)=>Promise<SceneWindow|null>
} = {}):Promise<SceneRequest[]> {
 if(!config.SCENE_AUTO_QUEUE || !config.GEMINI_API_KEY) return [];
 const requests:SceneRequest[]=[];
 await Promise.all(results.filter(r=>(r.judgement?.relevance??0)>=(options.minRelevance??3))
   .slice(0,options.interactive?config.SCENE_SEARCH_LIMIT:config.SCENE_SHORTLIST).map(async result=>{
   // Chosen before the transaction: Jev takes a few seconds, and nothing here needs the row locks.
   const segments=(result.duration??0)>90?(await db.query(`SELECT id::text AS id,start_seconds AS start,end_seconds AS "end",text
     FROM transcript_segments WHERE content_id=$1 ORDER BY start_seconds LIMIT 3000`,[result.id])).rows:[];
   const old=options.window&&segments.length?await options.window(query,segments,result.duration!).catch(()=>null):null;
   const windows:SceneInterval[]=options.window?(old?[{...old,requirement_ids:[],cue_ids:[]}]:[]):
     await chooseSceneWindows(db,config,query,segments,result.duration??0,options.requirements);
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
     if(!version) return;
     // An analysed video is queued again only for a window no earlier analysis inspected.
     if(version.analysis_status==='complete'){
       const inspected=(await tx.query('SELECT inspected_ranges FROM scene_analyses WHERE media_version_id=$1',[version.id])).rows.map(r=>r.inspected_ranges);
       if((windows.length?windows:[{start:Math.max(0,version.timeline_offset_seconds),end:version.duration_seconds+version.timeline_offset_seconds}]).every(w=>covered(w,inspected))) return;
     }
     const active=(await tx.query("SELECT id FROM jobs WHERE kind='scene_analysis' AND payload->>'media_version_id'=$1 AND status IN ('queued','running')",[version.id])).rows[0];
     if(active){
       if(options.interactive) {
         await tx.query("UPDATE jobs SET priority=10,payload=payload||$2::jsonb WHERE id=$1",[active.id,JSON.stringify({interactive_until:options.deadline})]);
         await tx.query("SELECT pg_notify('scene_jobs','ready')");
       }
       requests.push({content_id:result.id,job_id:active.id,created:false});return;
     }
     const key=`scene:${version.id}:${config.GEMINI_MODEL}:gemini-scenes-v3:${windows.map(w=>`${Math.round(w.start)}-${Math.round(w.end)}`).join(',')||'whole'}`;
     if((await tx.query('SELECT 1 FROM jobs WHERE dedupe_key=$1',[key])).rows.length) return;
     if(!await takeBudget(tx,'scene_auto_jobs',config.SCENE_AUTO_DAILY_JOBS)) return;
     // Transcript locations use content time; registered local excerpts can start later on that timeline.
     const mediaWindows=windows.map(w=>({...w,start:Math.max(0,Math.round(w.start-version.timeline_offset_seconds)),
       end:Math.min(version.duration_seconds,Math.round(w.end-version.timeline_offset_seconds))})).filter(w=>w.end>w.start);
     const job=await tx.query(`INSERT INTO jobs(kind,dedupe_key,payload,priority) VALUES('scene_analysis',$1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id`,[key,JSON.stringify({media_version_id:version.id,model:config.GEMINI_MODEL,query:query.slice(0,500),
         windows:mediaWindows,requirements:options.requirements??[],
         ...(options.interactive?{interactive_until:options.deadline}:{})}),options.interactive?10:0]);
     if(job.rows[0]) {requests.push({content_id:result.id,job_id:job.rows[0].id,created:true});await tx.query("SELECT pg_notify('scene_jobs','ready')");}
   });
 }));
 return requests;
}
