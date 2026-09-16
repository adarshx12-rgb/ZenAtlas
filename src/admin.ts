import { z } from 'zod';
import type { DB } from './db.js';
import { publicURL } from './urls.js';
export const sourcePolicy = z.object({
 status:z.enum(['active','paused','rejected','candidate']),
 metadata:z.boolean(),transcripts:z.boolean().default(false),video_analysis:z.boolean().default(false),
 retention_days:z.number().int().min(1).max(365).default(30),
 adapter:z.enum(['link_only','json_feed']).default('link_only'),feed_url:z.string().url().nullable().default(null),
 review_note:z.string().min(10).max(2000),
}).strict().refine(v=>v.status!=='active'||v.metadata,'Active sources must permit metadata retention')
 .refine(v=>v.adapter!=='json_feed'||!!v.feed_url,'Feed URL required');
export async function setSourcePolicy(db:DB,id:string,raw:unknown) {
 const policy=sourcePolicy.parse(raw);
 if(policy.feed_url) publicURL(policy.feed_url);
 return db.transaction(async tx=>{
   const source=(await tx.query(`UPDATE sources SET status=$2,policy=$3,adapter=$4,feed_url=$5,
     provenance=provenance||jsonb_build_object('review_note',$6::text,'reviewed_at',now()),
     next_check_at=now(),health_next_at=now(),failure_count=0 WHERE id=$1 RETURNING id,domain,status`,
     [id,policy.status,JSON.stringify({metadata:policy.metadata,transcripts:policy.transcripts,video_analysis:policy.video_analysis,
       retention_days:policy.retention_days}),policy.adapter,policy.feed_url,policy.review_note])).rows[0];
   if(!source) return null;
   if(!policy.metadata || policy.status==='rejected') await tx.query('DELETE FROM content WHERE source_id=$1',[id]);
   else {
     await tx.query(`UPDATE content SET expires_at=least(expires_at,now()+($2*interval '1 day')) WHERE source_id=$1`,[id,policy.retention_days]);
     // Analyses that were given subtitles are transcript-derived, so they also follow transcript permission.
     if(!policy.video_analysis || !policy.transcripts) await tx.query(`DELETE FROM scene_analyses
       WHERE content_id IN (SELECT id FROM content WHERE source_id=$1)
       AND ($2::boolean OR subtitle_source IN ('database_transcript','sidecar_file','faster_whisper'))`,[id,!policy.video_analysis]);
     if(!policy.transcripts) {
       await tx.query('DELETE FROM moments WHERE content_id IN (SELECT id FROM content WHERE source_id=$1)',[id]);
       await tx.query('DELETE FROM transcript_segments WHERE content_id IN (SELECT id FROM content WHERE source_id=$1)',[id]);
     }
     await tx.query(`UPDATE media_versions mv SET analysis_status='pending',analysis_code='policy_changed',analysis_updated_at=now()
       WHERE mv.analysis_status='complete' AND mv.content_id IN (SELECT id FROM content WHERE source_id=$1)
       AND NOT EXISTS(SELECT 1 FROM scene_analyses a WHERE a.media_version_id=mv.id)`,[id]);
   }
   // Remove cached metadata/evidence as soon as policy changes; old cursors expire safely.
   await tx.query('DELETE FROM searches');
   await tx.query(`DELETE FROM jobs WHERE kind='discovery' AND status IN ('complete','failed')`);
   return source;
 });
}

export async function removeContent(db:DB,id:string) {
 return db.transaction(async tx=>{
   // Use the same source-first lock order as ingestion so in-flight work cannot restore a removed item.
   await tx.query(`SELECT s.id FROM sources s JOIN content c ON c.source_id=s.id WHERE c.id=$1 FOR UPDATE OF s`,[id]);
   const item=(await tx.query('SELECT canonical_url,source_id,provider_id FROM content WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!item)return false;
   await tx.query(`INSERT INTO content_removals(canonical_url,source_id,provider_id) VALUES($1,$2,$3)
     ON CONFLICT(canonical_url) DO NOTHING`,[item.canonical_url,item.source_id,item.provider_id]);
   await tx.query('DELETE FROM content WHERE id=$1',[id]);
   await tx.query('DELETE FROM searches');
   await tx.query(`DELETE FROM jobs WHERE status IN ('complete','failed')`);
   return true;
 });
}
