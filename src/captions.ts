import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { Result } from './types.js';
import { youtubeId } from './youtube.js';
import { takeBudget } from './budgets.js';
import { contentHash } from './embeddings.js';
import { importTranscript } from './moments.js';

// Existing YouTube captions, read by scene-worker/src/zenatlas_scenes/captions.py. Only caption text is fetched, never
// audio or video. Supadata (SUPADATA_API_KEY) is asked first, within SUPADATA_DAILY_BUDGET: it fetches from its own servers,
// so YouTube blocking this address does not stop it, but it cannot say whether captions are creator-made (kind unknown).
// YouTube is asked directly when Supadata is spent, paused or fails; its track list tells creator from auto captions.
const kind = z.enum(['youtube_manual', 'youtube_auto', 'youtube_unknown']);
const language = z.string().regex(/^[a-z]{2,3}$|^und$/);
const answer = z.discriminatedUnion('status', [
 z.object({status: z.literal('ok'), kind, language, track: z.string().max(40),
   segments: z.array(z.object({start: z.number().finite().min(0), end: z.number().finite(), text: z.string().min(1)})).min(1)}),
 z.object({status: z.literal('none'), reason: z.string().max(100)}),
 // A YouTube block after the track list was read still says which track (and kind) it chose.
 z.object({status: z.literal('error'), code: z.string().max(100), kind: kind.optional(), track: z.string().max(40).optional(), language: language.optional()}),
]);
export type CaptionAnswer = z.infer<typeof answer>;
export type CaptionVia = 'youtube'|'supadata';
export type CaptionFetcher = (videoId: string, language: string|null, via: CaptionVia) => Promise<CaptionAnswer>;

// YouTube blocks addresses that fetch too much; Supadata stops when credits run out or the key is wrong.
const YOUTUBE_BLOCKS = new Set(['IpBlocked', 'RequestBlocked', 'PoTokenRequired']);
const SUPADATA_STOPS = new Set(['SupadataLimit', 'SupadataUnauthorized']);
// The first block pauses direct YouTube requests for an hour; each further block within a day doubles it, up to a day.
export const CAPTION_PAUSE_MINUTES = 60;
// Each direct fetch is three YouTube requests (watch page, player API, the chosen track).
export const CAPTION_FETCHES_PER_MINUTE = 6;

export function pythonCaptions(command: string, options: {proxy?: string; supadataKey?: string} = {}): CaptionFetcher {
 return (videoId, language, via) => new Promise(resolve => {
   const env = {...process.env, YOUTUBE_CAPTIONS_PROXY: options.proxy ?? '', SUPADATA_API_KEY: options.supadataKey ?? '', PYTHONIOENCODING: 'utf-8'};
   execFile(command, ['-m', 'zenatlas_scenes.captions', videoId, ...(language ? [language] : []), ...(via === 'supadata' ? ['--via=supadata'] : [])],
     // Supadata processes long videos asynchronously and the helper polls for up to 90 seconds.
     {timeout: via === 'supadata' ? 150_000 : 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env}, (error, stdout) => {
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
async function requeue(db: DB, job: any, runAfter: Date, code: string) {
 await db.query(`UPDATE jobs SET status='queued',attempts=greatest(attempts-1,0),run_after=$3::timestamptz,error_code=$4,lease_until=NULL,updated_at=now()
   WHERE id=$1 AND lease_token=$2 AND status='running'`, [job.id, job.lease_token, runAfter.toISOString(), code]);
}
async function pausedUntil(db: DB, lane: string): Promise<Date|null> {
 return (await db.query('SELECT until FROM lane_pauses WHERE lane=$1 AND until>now()', [lane])).rows[0]?.until ?? null;
}
// With escalate, a block within a day of the last pause ending doubles the pause (up to a day); otherwise it is `minutes`.
async function pause(db: DB, lane: string, reason: string, minutes: number, escalate: boolean): Promise<Date> {
 return (await db.query(`INSERT INTO lane_pauses(lane,until,strikes,reason) VALUES($1,now()+$2*interval '1 minute',1,$3)
   ON CONFLICT(lane) DO UPDATE SET
     until=now()+least(1440,$2*CASE WHEN $4 AND lane_pauses.until>now()-interval '1 day' THEN power(2,lane_pauses.strikes) ELSE 1 END)*interval '1 minute',
     strikes=CASE WHEN lane_pauses.until>now()-interval '1 day' THEN lane_pauses.strikes+1 ELSE 1 END,reason=$3
   RETURNING until`, [lane, minutes, reason, escalate])).rows[0].until;
}

export type CaptionOutcome = {status: string; [key: string]: unknown};
// Returns the job result, or null when the job was requeued (paused lanes or the per-minute limit).
export async function captionJob(db: DB, config: Config, job: any, fetch: CaptionFetcher): Promise<CaptionOutcome|null> {
 const row = (await db.query(`SELECT c.id,c.canonical_url,c.language,c.duration FROM content c JOIN sources s ON s.id=c.source_id
   WHERE c.id=$1 AND ${eligible}`, [job.payload?.content_id])).rows[0];
 if (!row) return {status: 'not_permitted'};
 const id = youtubeId(row.canonical_url);
 if (!id) return {status: 'not_youtube'};
 if ((await db.query('SELECT 1 FROM transcript_segments WHERE content_id=$1 LIMIT 1', [row.id])).rows.length) return {status: 'already_transcribed'};
 const outcome = await fetchAndStore(db, config, row, id, fetch);
 if (waiting(outcome)) { await requeue(db, job, outcome.wait, outcome.code); return null; }
 return outcome;
}

type Waiting = {status: 'waiting'; wait: Date; code: string};
const waiting = (o: CaptionOutcome|Waiting): o is Waiting => o.status === 'waiting';
// Fetches one video's captions (Supadata first, then YouTube) and stores them. A wait means both routes are paused or
// rate limited for now; the caller decides whether to requeue (a job) or move on (a search).
async function fetchAndStore(db: DB, config: Config, row: {id: string; canonical_url: string; language: string|null; duration: number}, id: string,
 fetch: CaptionFetcher): Promise<CaptionOutcome|Waiting> {
 const settle = async (fetched: Exclude<CaptionAnswer, {status: 'error'}>, via: CaptionVia): Promise<CaptionOutcome> => {
   if (fetched.status === 'none') return {status: 'no_captions', reason: fetched.reason, via};
   // Captions may run a moment past the duration YouTube reports; the stored timeline never exceeds it.
   const limit = row.duration > 0 ? row.duration : Infinity;
   const segments = fetched.segments.filter(s => s.start < limit).map(s => ({start: s.start, end: Math.min(s.end, limit), text: s.text.slice(0, 4000)}))
     .filter(s => s.end > s.start);
   if (!segments.length) return {status: 'no_captions', reason: 'outside_duration', via};
   const version = `youtube:${fetched.kind}:${fetched.track}:${contentHash(JSON.stringify(segments)).slice(0, 16)}`;
   const stored = await importTranscript(db, {content_id: row.id, language: fetched.language, origin: `${row.canonical_url}#captions=${fetched.track}`,
     content_version: version, timing_quality: 'provided', retention_permitted: true, source_kind: fetched.kind, segments});
   return {status: 'imported', kind: fetched.kind, language: fetched.language, via, ...stored};
 };

 // Supadata first (it fetches from its own servers, so YouTube's blocks on this address do not matter), within its daily
 // budget. Anything but captions or a definite "none" falls back to asking YouTube directly.
 // Supadata has its own per-minute limit: YouTube's (below) protects this address, which Supadata does not use.
 if (config.SUPADATA_API_KEY && !await pausedUntil(db, 'supadata') && await takeBudget(db, 'supadata_fetches', config.SUPADATA_PER_MINUTE, 'minute')
   && await takeBudget(db, 'supadata_requests', config.SUPADATA_DAILY_BUDGET)) {
   const relayed = await fetch(id, row.language, 'supadata');
   if (relayed.status !== 'error') return settle(relayed, 'supadata');
   if (SUPADATA_STOPS.has(relayed.code)) {
     const until = await pause(db, 'supadata', relayed.code, 1440, false);
     console.error(JSON.stringify({event: 'supadata_paused', code: relayed.code, until}));
   }
 }
 if (!await pausedUntil(db, 'youtube_captions')) {
   if (!await takeBudget(db, 'youtube_caption_fetches', CAPTION_FETCHES_PER_MINUTE, 'minute')) {
     return {status: 'waiting', wait: new Date(Date.now() + 60_000), code: 'rate_limited'};
   }
   const direct = await fetch(id, row.language, 'youtube');
   if (direct.status !== 'error') {
     await db.query(`DELETE FROM lane_pauses WHERE lane='youtube_captions'`);
     return settle(direct, 'youtube');
   }
   if (!YOUTUBE_BLOCKS.has(direct.code)) throw new Error(`captions_${direct.code}`);
   const until = await pause(db, 'youtube_captions', direct.code, CAPTION_PAUSE_MINUTES, true);
   console.error(JSON.stringify({event: 'youtube_captions_paused', code: direct.code, until}));
 }
 return {status: 'waiting', wait: (await pausedUntil(db, 'youtube_captions')) ?? new Date(Date.now() + CAPTION_PAUSE_MINUTES * 60_000), code: 'youtube_blocked'};
}

// During a search that asks for a moment ("the part where...", "timestamp"): the top YouTube results without a transcript
// get their captions now, in parallel and within budgetMs, so the judge can quote them and the same search can show the
// timestamp. Results still loading when the time is up finish in the background and help later searches.
export const MOMENT_QUERY = /\bthe (?:part|moment|bit|scene|point|section)\b|\bmoments?\b|\btimestamps?\b|\bat what (?:point|time|minute)\b|\bwhere (?:he|she|they|it|someone) (?:says|talks|explains|mentions|describes)\b/i;
export async function fetchCaptionsNow(db: DB, config: Config, results: Result[], fetch: CaptionFetcher, max: number, budgetMs: number) {
 const ids = results.filter(r => youtubeId(r.canonical_url)).map(r => r.id);
 const rows = ids.length ? (await db.query(`SELECT c.id,c.canonical_url,c.language,c.duration FROM content c JOIN sources s ON s.id=c.source_id
   WHERE c.id=ANY($1::uuid[]) AND ${eligible} AND NOT EXISTS(SELECT 1 FROM transcript_segments t WHERE t.content_id=c.id)`, [ids])).rows : [];
 const wanted = ids.flatMap(id => rows.filter(r => r.id === id)).slice(0, max);
 let imported = 0, timer: NodeJS.Timeout|undefined;
 const work = Promise.all(wanted.map(async row => {
   const outcome = await fetchAndStore(db, config, row, youtubeId(row.canonical_url)!, fetch).catch(() => null);
   if (outcome?.status === 'imported') imported++;
 }));
 await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, budgetMs); })]);
 clearTimeout(timer);
 return {tried: wanted.length, imported};
}
