// Moment-search accuracy with and without YouTube transcripts, on an isolated copy of the catalogue (never the live database).
//
// node --env-file=.env --import tsx scripts/evaluate-transcripts.ts <catalogue.sql> <captions dir> <cases.json> <out.json>
//   catalogue.sql  pg_dump --data-only --column-inserts --on-conflict-do-nothing -t sources -t content
//   captions dir   <video id>.json answers from `python -m zenatlas_scenes.captions` (cached, so no credit is spent twice)
//   cases.json     {"kinds": {"<id>": "youtube_manual"|"youtube_auto"}, "truth": [{"q", "video", "seconds"}], "add": ["<id>", ...]}
//                  "add" lists videos to add to the copy from YouTube metadata (videos.list, one quota unit each).
// Searches run in catalogue mode, which is deterministic. Semantic search is off, so this measures keyword matching only.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embedded } from './embedded.js';
import { migrate } from '../src/migrate.js';
import { configSchema } from '../src/config.js';
import { ingest } from '../src/catalogue.js';
import { contentInput } from '../src/types.js';
import { SearchService } from '../src/search.js';
import { importTranscript } from '../src/moments.js';
import { YouTubeData } from '../src/youtube.js';

type Segment = {start: number; end: number; text: string};
type Case = {set: string; q: string; video: string; seconds: number|null; note?: string};
const [dumpPath, captionsDir, casesPath, outPath] = process.argv.slice(2);
if (!outPath) throw new Error('usage: evaluate-transcripts.ts <catalogue.sql> <captions dir> <cases.json> <out.json>');
const STOP = new Set(('the and for that this with you your are was were have has had not but can will just they them their there then than what when '
 + 'where which who how all any our out from into about over also its it\'s let\'s i\'m don\'t youtube video videos going get got like one two very '
 + 'really here some more most much make made been being would could should them these those okay yeah right know think want').split(' '));
const words = (text: string) => (text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? []).map(w => w.replace(/'s$/, ''));

const config = configSchema.parse({DATABASE_URL: 'eval', SESSION_SECRET: 'evaluation-session-secret-32-chars-long', ADMIN_TOKEN: 'evaluation-admin-token-32-characters',
 REDDIT_SIGNALS: 'false', PAGE_CHECKS: '0', ANILIST_ENABLED: 'false', ARCHIVE_DISCOVERY: 'false', SPECIALIST_SEARCHES: 0, SEMANTIC_ENABLED: 'false',
 YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? ''});
const cases = JSON.parse(await readFile(casesPath, 'utf8')) as {kinds: Record<string, 'youtube_manual'|'youtube_auto'>; truth: Case[]; add: string[]};

const db = embedded();
await migrate(db);
// Values can span lines, so split on the statement ending pg_dump writes with --on-conflict-do-nothing.
for (const part of (await readFile(dumpPath, 'utf8')).split(/ ON CONFLICT DO NOTHING;\r?\n/)) {
 if (part.includes('INSERT INTO ')) await db.query(`${part.slice(part.indexOf('INSERT INTO '))} ON CONFLICT DO NOTHING`);
}
const ids = new Map<string, {id: string; title: string; description: string; duration: number}>();
const load = async () => {
 for (const r of (await db.query(`SELECT id,title,coalesce(description,'') AS description,duration,substring(canonical_url from 'v=([\\w-]{11})') AS vid
   FROM content WHERE canonical_url ~ 'youtube.com/watch'`)).rows) ids.set(r.vid, r);
};
await load();
if (cases.add.some(v => !ids.has(v))) {
 const found = await new YouTubeData(db, config).videos(cases.add.filter(v => !ids.has(v)));
 for (const v of found.values()) await ingest(db, contentInput.parse({url: `https://www.youtube.com/watch?v=${v.id}`, title: v.title,
   description: v.description.slice(0, 10000), creator: v.channelTitle, duration: v.duration, language: v.language ?? null, availability: 'available'}),
   {evaluation: true});
 await load();
}

// Captions exactly as the caption job stores them: clipped to the catalogue duration.
const captions = new Map<string, {language: string; track: string; segments: Segment[]; dropped: number}>();
for (const file of await readdir(captionsDir)) {
 const answer = JSON.parse(await readFile(join(captionsDir, file), 'utf8'));
 const vid = file.replace(/\.json$/, ''), row = ids.get(vid);
 if (answer.status !== 'ok' || !row) continue;
 const limit = row.duration > 0 ? row.duration : Infinity;
 const segments = (answer.segments as Segment[]).filter(s => s.start < limit).map(s => ({...s, end: Math.min(s.end, limit)})).filter(s => s.end > s.start);
 captions.set(vid, {language: answer.language, track: answer.track, segments, dropped: answer.segments.length - segments.length});
}

// Spoken-phrase queries: 4 content words said in the video but absent from its title and description; truth is when they are said.
const generated: Case[] = [];
for (const [vid, c] of captions) {
 if (cases.truth.some(t => t.video === vid) || c.language !== 'en') continue;
 const meta = new Set(words(`${ids.get(vid)!.title} ${ids.get(vid)!.description}`));
 for (const at of [0.2, 0.5, 0.8]) {
   for (let i = Math.floor(c.segments.length * at); i < c.segments.length - 1; i++) {
     const picked = words(`${c.segments[i].text} ${c.segments[i + 1].text}`).filter(w => !STOP.has(w) && !meta.has(w));
     if (words(c.segments[i].text).some(w => picked[0] === w) && new Set(picked.slice(0, 4)).size === 4) {
       generated.push({set: 'spoken_phrase', q: picked.slice(0, 4).join(' '), video: vid, seconds: c.segments[i].start}); break;
     }
   }
 }
}
// Title queries: does adding transcripts push the right video down for an ordinary metadata search?
const titled: Case[] = [...captions.keys()].map(vid => ({set: 'title', q: [...new Set(words(ids.get(vid)!.title).filter(w => !STOP.has(w)))].slice(0, 3).join(' '),
 video: vid, seconds: null}));
const all = [...cases.truth.map(t => ({...t, set: 'ground_truth'})), ...generated, ...titled];

async function run(state: string) {
 const service = new SearchService(db, config);
 const out = [];
 for (const c of all) {
   const response = await service.start({q: c.q, mode: 'catalogue', limit: 50}, `evaluation-${state}`);
   const target = ids.get(c.video)!.id;
   const index = response.results.findIndex(r => r.id === target);
   const moments = index < 0 ? [] : response.results[index].moments.filter(m => m.evidence_type === 'transcript_supported');
   const at = moments.length ? moments.map(m => m.focus?.[0] ?? m.start_seconds) : [];
   const error = c.seconds === null || !at.length ? null : Math.min(...at.map(t => Math.abs(t - c.seconds!)));
   out.push({...c, state, rank: index < 0 ? null : index + 1, results: response.results.length, moment: at.length > 0, error,
     quote: moments[0]?.summary ? moments[0].summary.slice(0, 160) : null, top: response.results.slice(0, 3).map(r => r.title.slice(0, 50))});
 }
 return out;
}
const without = await run('without');
for (const [vid, c] of captions) await importTranscript(db, {content_id: ids.get(vid)!.id, language: c.language, origin: `evaluation:${vid}`,
 content_version: `evaluation:${c.track}`, timing_quality: 'provided', retention_permitted: true, source_kind: cases.kinds[vid] ?? 'youtube_unknown',
 segments: c.segments});
const withTranscripts = await run('with');

const summary = (rows: typeof without) => {
 const found = (k: number) => rows.filter(r => r.rank !== null && r.rank <= k).length;
 const errors = rows.map(r => r.error).filter((e): e is number => e !== null).sort((a, b) => a - b);
 return {queries: rows.length, top1: found(1), top5: found(5), top50: found(50),
   mrr: +(rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length).toFixed(3),
   moments: rows.filter(r => r.moment).length, within5s: errors.filter(e => e <= 5).length, within15s: errors.filter(e => e <= 15).length,
   median_error: errors.length ? +errors[Math.floor(errors.length / 2)].toFixed(1) : null};
};
const sets = [...new Set(all.map(c => c.set))];
const report = {
 captions: [...captions].map(([vid, c]) => ({video: vid, title: ids.get(vid)!.title.slice(0, 60), kind: cases.kinds[vid] ?? 'youtube_unknown', language: c.language,
   cues: c.segments.length, dropped_past_duration: c.dropped, mean_cue_seconds: +(c.segments.reduce((s, x) => s + x.end - x.start, 0) / c.segments.length).toFixed(2),
   coverage: +((c.segments.at(-1)!.end - c.segments[0].start) / ids.get(vid)!.duration).toFixed(2)})),
 summary: Object.fromEntries(sets.map(set => [set, {without: summary(without.filter(r => r.set === set)), with: summary(withTranscripts.filter(r => r.set === set))}])),
 queries: all.map((c, i) => ({...c, without: {rank: without[i].rank, moment: without[i].moment, error: without[i].error},
   with: {rank: withTranscripts[i].rank, moment: withTranscripts[i].moment, error: withTranscripts[i].error, quote: withTranscripts[i].quote, results: withTranscripts[i].results, top: withTranscripts[i].top}})),
};
await writeFile(outPath, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
await db.close();
