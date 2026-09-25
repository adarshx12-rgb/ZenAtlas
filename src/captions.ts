import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { Result } from './types.js';
import { youtubeId } from './youtube.js';
import { takeBudget } from './budgets.js';
import { contentHash } from './embeddings.js';
import { importTranscript } from './moments.js';

// Existing YouTube captions, read by scene-worker/src/zenatlas_scenes/captions.py (youtube-transcript-api).
// Only caption text is fetched, never audio or video. Creator captions win over auto-generated ones.
const answer = z.discriminatedUnion('status', [
 z.object({status: z.literal('ok'), kind: z.enum(['youtube_manual', 'youtube_auto']), language: z.string().regex(/^[a-z]{2,3}$|^und$/),
   track: z.string().max(40), segments: z.array(z.object({start: z.number().finite().min(0), end: z.number().finite(), text: z.string().min(1)})).min(1)}),
 z.object({status: z.literal('none'), reason: z.string().max(100)}),
 z.object({status: z.literal('error'), code: z.string().max(100)}),
]);
export type CaptionAnswer = z.infer<typeof answer>;
export type CaptionFetcher = (videoId: string, language: string|null) => Promise<CaptionAnswer>;

// YouTube blocks addresses that fetch too much. A block pauses the whole caption lane rather than failing jobs one by one.
const BLOCKED = new Set(['IpBlocked', 'RequestBlocked', 'PoTokenRequired']);
export const CAPTION_PAUSE_MINUTES = 60;
// Each fetch is two YouTube requests (the track list, then the chosen track).
export const CAPTION_FETCHES_PER_MINUTE = 6;
const TIMEOUT_MS = 30_000;

export function pythonCaptions(command: string, proxy = ''): CaptionFetcher {
 return (videoId, language) => new Promise(resolve => {
   const env = {...process.env, YOUTUBE_CAPTIONS_PROXY: proxy, PYTHONIOENCODING: 'utf-8'};
   execFile(command, ['-m', 'zenatlas_scenes.captions', videoId, ...(language ? [language] : [])],
     {timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env}, (error, stdout) => {
       const line = stdout.trim().split('\n').at(-1) ?? '';
       try { resolve(answer.parse(JSON.parse(line))); }
       catch { resolve({status: 'error', code: error ? 'helper_failed' : 'helper_unparsable'}); }
     });
 });
}
export function captionCommand(config: Config) { return config.CAPTIONS_PYTHON || config.PAGE_TEXT_PYTHON; }

const eligible = `s.status='active' AND s.health_status<>'down' AND c.expires_at>now() AND c.availability<>'unavailable'
 AND (s.policy->>'transcripts')::boolean=true AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain`;

// After a search: the top YouTube results that have no transcript yet, each fetched once.
export async function queueCaptions(db: DB, config: Config, results: Result[]) {
 if (!config.YOUTUBE_CAPTIONS || !captionCommand(config)) return 0;
 let queued = 0;
 for (const result of results.filter(r => youtubeId(r.canonical_url)).slice(0, config.YOUTUBE_CAPTIONS_SHORTLIST)) {
   const row = (await db.query(`SELECT c.id FROM content c JOIN sources s ON s.id=c.source_id WHERE c.id=$1 AND ${eligible}
     AND NOT EXISTS(SELECT 1 FROM transcript_segments t WHERE t.content_id=c.id)
     AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key='captions:'||c.id::text)`, [result.id])).rows[0];
   if (!row || !await takeBudget(db, 'youtube_caption_jobs', config.YOUTUBE_CAPTIONS_DAILY_BUDGET)) continue;
   queued += (await db.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES('youtube_captions',$1,$2) ON CONFLICT DO NOTHING RETURNING id`,
     [`captions:${row.id}`, JSON.stringify({content_id: row.id})])).rows.length;
 }
 return queued;
}

// Requeues without spending an attempt: waiting out a block or the per-minute limit is not a failure.
async function requeue(db: DB, job: any, runAfter: string, code: string) {
 await db.query(`UPDATE jobs SET status='queued',attempts=greatest(attempts-1,0),run_after=$3::timestamptz,error_code=$4,lease_until=NULL,updated_at=now()
   WHERE id=$1 AND lease_token=$2 AND status='running'`, [job.id, job.lease_token, runAfter, code]);
}

export type CaptionOutcome = {status: string; [key: string]: unknown};
// Returns the job result, or null when the job was requeued (paused lane or per-minute limit).
export async function captionJob(db: DB, config: Config, job: any, fetch: CaptionFetcher): Promise<CaptionOutcome|null> {
 const row = (await db.query(`SELECT c.id,c.canonical_url,c.language,c.duration FROM content c JOIN sources s ON s.id=c.source_id
   WHERE c.id=$1 AND ${eligible}`, [job.payload?.content_id])).rows[0];
 if (!row) return {status: 'not_permitted'};
 const id = youtubeId(row.canonical_url);
 if (!id) return {status: 'not_youtube'};
 if ((await db.query('SELECT 1 FROM transcript_segments WHERE content_id=$1 LIMIT 1', [row.id])).rows.length) return {status: 'already_transcribed'};
 const paused = (await db.query(`SELECT max(run_after) AS until FROM jobs WHERE kind='youtube_captions' AND error_code='youtube_blocked'
   AND status='queued' AND run_after>now()`)).rows[0]?.until;
 if (paused) { await requeue(db, job, paused.toISOString(), 'youtube_blocked'); return null; }
 if (!await takeBudget(db, 'youtube_caption_fetches', CAPTION_FETCHES_PER_MINUTE, 'minute')) {
   await requeue(db, job, new Date(Date.now() + 60_000).toISOString(), 'rate_limited'); return null;
 }
 const fetched = await fetch(id, row.language);
 if (fetched.status === 'none') return {status: 'no_captions', reason: fetched.reason};
 if (fetched.status === 'error') {
   if (!BLOCKED.has(fetched.code)) throw new Error(`captions_${fetched.code}`);
   const until = new Date(Date.now() + CAPTION_PAUSE_MINUTES * 60_000).toISOString();
   await requeue(db, job, until, 'youtube_blocked');
   await db.query(`UPDATE jobs SET run_after=greatest(run_after,$1::timestamptz) WHERE kind='youtube_captions' AND status='queued'`, [until]);
   console.error(JSON.stringify({event: 'youtube_captions_paused', code: fetched.code, until}));
   return null;
 }
 // Captions may run a moment past the duration YouTube reports; the stored timeline never exceeds it.
 const limit = row.duration > 0 ? row.duration : Infinity;
 const segments = fetched.segments.filter(s => s.start < limit).map(s => ({start: s.start, end: Math.min(s.end, limit), text: s.text.slice(0, 4000)}))
   .filter(s => s.end > s.start);
 if (!segments.length) return {status: 'no_captions', reason: 'outside_duration'};
 const version = `youtube:${fetched.kind}:${fetched.track}:${contentHash(JSON.stringify(segments)).slice(0, 16)}`;
 const stored = await importTranscript(db, {content_id: row.id, language: fetched.language, origin: `${row.canonical_url}#captions=${fetched.track}`,
   content_version: version, timing_quality: 'provided', retention_permitted: true, source_kind: fetched.kind, segments});
 return {status: 'imported', kind: fetched.kind, language: fetched.language, ...stored};
}
