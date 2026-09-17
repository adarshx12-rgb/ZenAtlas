import { z } from 'zod';

export const searchInput = z.object({
 q: z.string().transform(v => v.normalize('NFC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(500)),
 mode: z.enum(['catalogue','auto','refresh']).default('auto'),
 limit: z.coerce.number().int().min(1).max(50).default(20),
 language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
 source: z.string().uuid().optional(),
 after: z.iso.datetime().optional(),
 evidence: z.enum(['any','transcript_supported','video_analysed','viewer_timestamp']).default('any'),
 // Both depths plan with AI, check pages, comments and Reddit, and rank with AI. deep additionally searches niche
 // engines, later result pages and leads from its first finds, for sources ordinary searches miss. Deep only runs when asked for.
 depth: z.enum(['quick','deep']).default('quick'),
 cursor: z.string().max(512).optional(),
}).strict();
export type SearchInput = z.infer<typeof searchInput>;
export const contentInput = z.object({
 url: z.string().url().max(2048), title: z.string().trim().min(1).max(500),
 provider_id: z.string().max(200).nullable().default(null),
 description: z.string().max(10000).nullable().default(null), creator: z.string().max(300).nullable().default(null),
 published_at: z.iso.datetime().nullable().default(null), duration: z.number().positive().max(604800).nullable().default(null),
 language: z.string().max(20).nullable().default(null), thumbnail: z.string().url().max(2048).nullable().default(null),
 embeddable: z.boolean().nullable().default(null),
 availability: z.enum(['unknown','available','unavailable']).default('unknown'),
 rights_status: z.enum(['unknown','restricted','licensed','public_domain']).default('unknown'),
 license_url: z.string().url().max(2048).nullable().default(null),
});
export type ContentInput = z.infer<typeof contentInput>;
export type ProviderStatus = { provider: string; status: 'ok'|'partial'|'unavailable'|'disabled'|'budget_exhausted'; message: string };
export interface EngineFailure { engine: string; reason: string }
// engines: set by metasearch adapters that ask several engines; failed lists the ones that did not answer.
export interface DiscoveryPage { results: ContentInput[]; next_cursor: string | null; status: ProviderStatus; engines?: {asked: string[]; failed: EngineFailure[]} }
export interface SourceAdapter {
 name: string;
 capabilities: { transcripts: boolean; comments: boolean; embeds: boolean; accessible_media: boolean };
 search(query: string, filters: SearchInput, cursor?: string): Promise<DiscoveryPage>;
 fetchMetadata?(reference: string): Promise<ContentInput>;
 listUpdates?(source: {feed_url: string; cursor: string|null}): Promise<DiscoveryPage>;
}
export interface SceneDetails {
 media_version: string; media_start_seconds: number; media_end_seconds: number; timeline_offset_seconds: number;
 model: string; tags: string[]; dialogue: string|null; dialogue_source: string|null;
}
export interface SceneAnalysisStatus {
 status: 'pending'|'complete'|'inaccessible'|'failed'|'not_permitted'; media_version: string; message: string;
}
export type EvidenceType = 'transcript_supported'|'video_analysed'|'viewer_timestamp';
export interface Judgement { relevance: number; reason: string; model: string }
export interface Moment {
 id: string; start_seconds: number; end_seconds: number; summary: string;
 evidence_type: EvidenceType; analysis_version: string;
 inspected_ranges: [number,number][]; evidence_refs: string[]; scene?: SceneDetails;
}
export interface Result {
 id: string; title: string; canonical_url: string; source_id: string; source_name: string;
 description: string|null; creator: string|null; published_at: string|null; duration: number|null;
 language: string|null; thumbnail: string|null; embeddable: boolean|null;
 rights_status: string; license_url: string|null; availability: string;
 evidence: 'metadata_match'|EvidenceType; moments: Moment[];
 origin: 'catalogue'|'discovery'; verified_at: string|null; scene_analysis?: SceneAnalysisStatus|null;
 badges?: string[]; judgement?: Judgement|null;
 // A first-screen capture of the page is available from /api/search/:id/previews/:result while the search lasts.
 preview?: boolean;
 // Found by a deep dive rather than by the search it continued.
 deep_find?: boolean;
}
export type DiscoveryStage = 'queued'|'searching'|'following'|'checking';
export interface SearchResponse {
 query: string; search_id: string; status: 'complete'|'discovering'|'partial'|'cancelled';
 depth: SearchInput['depth']; stage: DiscoveryStage|null;
 results: Result[]; next_cursor: string|null; has_more: boolean;
 // Every discovered result in the snapshot, in display order, including ones found while discovery is still running.
 discovered: Result[]; catalogue_total: number;
 discovery_job_id: string|null; providers: ProviderStatus[]; ranking_version: string;
}
