import type { Moment, SceneAnalysisStatus } from './types.js';

// Scenes are written by scene-worker/. They are searchable only while active and permitted by source policy.
export const activeScene = `v.status='active' AND (s.policy->>'video_analysis')::boolean=true`;

export const sceneSelect = `SELECT v.id,v.content_id,v.analysis_id,v.start_seconds,v.end_seconds,v.media_start_seconds,v.media_end_seconds,
 v.description,v.tags,v.dialogue,v.dialogue_source,v.transcript_segment_refs,a.analysis_version,a.model,a.inspected_ranges,
 mv.version_key,mv.timeline_offset_seconds
 FROM video_scenes v JOIN scene_analyses a ON a.id=v.analysis_id JOIN media_versions mv ON mv.id=v.media_version_id
 JOIN content c ON c.id=v.content_id JOIN sources s ON s.id=c.source_id`;

export function sceneMoment(row: any): Moment {
 return {id:row.id,start_seconds:row.start_seconds,end_seconds:row.end_seconds,summary:row.description,evidence_type:'video_analysed',
   analysis_version:row.analysis_version,inspected_ranges:row.inspected_ranges,evidence_refs:[row.analysis_id,...row.transcript_segment_refs],
   scene:{media_version:row.version_key,media_start_seconds:row.media_start_seconds,media_end_seconds:row.media_end_seconds,
     timeline_offset_seconds:row.timeline_offset_seconds,model:row.model,tags:row.tags,dialogue:row.dialogue,dialogue_source:row.dialogue_source}};
}

const messages: Record<SceneAnalysisStatus['status'],string> = {
 pending:'Scene analysis for this video version has not completed.',
 complete:'Scenes were analysed from this video version.',
 inaccessible:'Scene analysis is unavailable because the media could not be accessed.',
 failed:'Scene analysis failed, so no new scenes were stored.',
 not_permitted:'Scene analysis is not permitted for this video.',
};
const inaccessibleDetail: Record<string,string> = {
 not_found:'The video was not found.', restricted:'The video is private or restricted.',
 file_missing:'The authorised media file is missing.', provider_could_not_process:'The analysis provider could not process the media.',
 fingerprint_mismatch:'The media no longer matches the registered version.', duration_mismatch:'The media no longer matches the registered version.',
};

export function sceneAnalysisStatus(row: {version_key:string;analysis_status:SceneAnalysisStatus['status'];analysis_code:string|null}): SceneAnalysisStatus {
 const detail = row.analysis_status==='inaccessible' && row.analysis_code ? inaccessibleDetail[row.analysis_code] : undefined;
 return {status:row.analysis_status,media_version:row.version_key,message:detail?`${messages.inaccessible} ${detail}`:messages[row.analysis_status]};
}
