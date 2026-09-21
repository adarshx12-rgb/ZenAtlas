import { z } from 'zod';
import type { DB } from './db.js';
export const transcriptInput = z.object({
 content_id:z.string().uuid(),language:z.string().min(2).max(20),origin:z.string().min(1).max(500),
 content_version:z.string().min(1).max(100),timing_quality:z.enum(['provided','aligned','human_verified']),
 retention_permitted:z.literal(true),
 segments:z.array(z.object({start:z.number().finite().min(0),end:z.number().finite().positive(),text:z.string().min(1).max(4000)})
   .refine(v=>v.end>v.start)).min(1).max(10000),
}).strict();
type Segment = {id:string;start_seconds:number;end_seconds:number;text:string};
export function transcriptWindows(segments: Segment[], maxChars=6000, overlap=2): Segment[][] {
 const windows:Segment[][]=[]; let start=0;
 while(start<segments.length) {
   let end=start; let chars=0;
   while(end<segments.length && (chars+segments[end].text.length<=maxChars || end===start)) { chars+=segments[end].text.length; end++; }
   windows.push(segments.slice(start,end));
   if(end===segments.length) break;
   start=Math.max(start+1,end-overlap);
 }
 return windows;
}
export async function importTranscript(db:DB,raw:unknown) {
 const input=transcriptInput.parse(raw);
 for(let i=1;i<input.segments.length;i++) if(input.segments[i].start<input.segments[i-1].start) throw new Error('Segments must be ordered');
 return db.transaction(async tx=>{
   const content=(await tx.query(`SELECT c.*,s.policy,s.status FROM content c JOIN sources s ON s.id=c.source_id WHERE c.id=$1 FOR UPDATE OF c`,[input.content_id])).rows[0];
   if(!content || content.status!=='active' || content.policy.transcripts!==true) throw new Error('Source does not permit transcript retention');
   if(content.duration && input.segments.some(s=>s.end>content.duration)) throw new Error('Caption exceeds video duration');
   const existing=(await tx.query('SELECT * FROM transcript_segments WHERE content_id=$1 ORDER BY start_seconds,end_seconds,id',[input.content_id])).rows;
   if(existing.length===input.segments.length && existing.every((s,i)=>s.content_version===input.content_version && s.origin===input.origin &&
     s.language===input.language && s.start_seconds===input.segments[i].start && s.end_seconds===input.segments[i].end && s.text===input.segments[i].text)) {
     return {segments:existing.length,moments:(await tx.query("SELECT count(*)::int AS n FROM moments WHERE content_id=$1 AND evidence_type='transcript_supported'",[input.content_id])).rows[0].n,
       analysis_version:`transcript-extractive-v1:${input.content_version}`};
   }
   await tx.query("DELETE FROM moments WHERE content_id=$1 AND evidence_type='transcript_supported'",[input.content_id]);
   await tx.query('DELETE FROM transcript_segments WHERE content_id=$1',[input.content_id]);
   const segments:Segment[]=[];
   for(const segment of input.segments) segments.push((await tx.query(`INSERT INTO transcript_segments
     (content_id,start_seconds,end_seconds,text,language,origin,content_version,timing_quality)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[input.content_id,segment.start,segment.end,segment.text,input.language,input.origin,input.content_version,input.timing_quality])).rows[0]);
   const version=`transcript-extractive-v1:${input.content_version}`;
   // Every segment is inspected. Overlapping windows preserve neighbouring context; global search ranks all windows.
   // Text is quoted evidence, never a generated assertion about a visual event or story payoff.
   const windows=transcriptWindows(segments);
   for(const window of windows) await tx.query(`INSERT INTO moments(content_id,start_seconds,end_seconds,summary,evidence_refs,
     evidence_type,analysis_method,analysis_version,inspected_ranges)
     VALUES($1,$2,$3,$4,$5,'transcript_supported','extractive_windows',$6,$7)`,
     [input.content_id,window[0].start_seconds,Math.max(...window.map(s=>s.end_seconds)),window.map(s=>s.text).join(' '),
       window.map(s=>s.id),version,JSON.stringify(window.map(s=>[s.start_seconds,s.end_seconds]))]);
   return {segments:segments.length,moments:windows.length,analysis_version:version};
 });
}
