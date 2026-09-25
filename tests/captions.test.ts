import {test} from 'node:test';
import assert from 'node:assert/strict';
import { database, testConfig } from './helpers.js';
import { ingest } from '../src/catalogue.js';
import { contentInput, type Result } from '../src/types.js';
import { workOnce } from '../src/worker.js';
import { queueCaptions, type CaptionAnswer, type CaptionFetcher } from '../src/captions.js';
import { SearchService } from '../src/search.js';
import type { DB } from '../src/db.js';

const config = {...testConfig, YOUTUBE_CAPTIONS: true, CAPTIONS_PYTHON: 'python-with-captions-extra'};

async function youtube(db: DB, id: string, title = `Fixture video ${id}`, language = 'hi') {
 await db.query(`INSERT INTO sources(domain,display_name,status,policy,provenance) VALUES('www.youtube.com','YouTube','active',
   '{"metadata":true,"transcripts":true,"retention_days":30}','{"fixture":true}') ON CONFLICT(domain) DO NOTHING`);
 return (await ingest(db, contentInput.parse({url: `https://www.youtube.com/watch?v=${id}`, title, description: 'Fixture description',
   language, duration: 60, availability: 'available'}), {fixture: true}))!;
}
function fetcher(answers: Record<string, CaptionAnswer>) {
 const asked: string[] = [];
 const fetch: CaptionFetcher = async id => { asked.push(id); return answers[id] ?? {status: 'none', reason: 'NoTranscriptFound'}; };
 return {fetch, asked};
}
const ok = (kind: 'youtube_manual'|'youtube_auto', text: string): CaptionAnswer =>
 ({status: 'ok', kind, language: 'en', track: 'en', segments: [{start: 5, end: 8, text}, {start: 8, end: 12, text: 'and then the credits roll'}]});
const job = (db: DB, id: string) => db.query(`SELECT * FROM jobs WHERE kind='youtube_captions' AND payload->>'content_id'=$1`, [id]).then(r => r.rows[0]);

test('top YouTube results are queued once each and their captions are stored with their kind', async () => {
 const db = await database();
 try {
   const manual = await youtube(db, 'aaaaaaaaaaa'), auto = await youtube(db, 'bbbbbbbbbbb');
   const other = (await ingest(db, contentInput.parse({url: 'https://videos.example.com/watch/1', title: 'Not YouTube', duration: 60,
     availability: 'available'}), {fixture: true}));
   const results = [manual, auto, other].filter(Boolean) as Result[];
   assert.equal(await queueCaptions(db, config, results), 2, 'only YouTube results are queued');
   assert.equal(await queueCaptions(db, config, results), 0, 'a video is never queued twice');
   assert.equal(await queueCaptions(db, {...config, YOUTUBE_CAPTIONS: false}, [manual]), 0);

   const {fetch, asked} = fetcher({aaaaaaaaaaa: ok('youtube_manual', 'the lighthouse keeper waves goodbye'),
     bbbbbbbbbbb: ok('youtube_auto', 'the light house keeper waves good bye')});
   while (await workOnce(db, config, undefined, undefined, undefined, fetch));
   assert.deepEqual(asked.sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
   assert.deepEqual((await db.query(`SELECT DISTINCT source_kind,origin,language FROM transcript_segments WHERE content_id=$1`, [manual.id])).rows,
     [{source_kind: 'youtube_manual', origin: 'https://www.youtube.com/watch?v=aaaaaaaaaaa#captions=en', language: 'en'}]);
   assert.deepEqual((await db.query(`SELECT DISTINCT source_kind FROM moments WHERE content_id=$1`, [auto.id])).rows, [{source_kind: 'youtube_auto'}]);
   assert.equal((await job(db, manual.id)).result.status, 'imported');
   assert.equal(await queueCaptions(db, config, [manual]), 0, 'a video with a transcript is not queued again');
 } finally { await db.close(); }
});

test('creator-caption evidence outranks auto-caption evidence at equal match quality', async () => {
 const db = await database();
 try {
   const auto = await youtube(db, 'ccccccccccc', 'First upload'), manual = await youtube(db, 'ddddddddddd', 'Second upload');
   await queueCaptions(db, config, [auto, manual]);
   const {fetch} = fetcher({ccccccccccc: ok('youtube_auto', 'the lighthouse keeper waves goodbye'),
     ddddddddddd: ok('youtube_manual', 'the lighthouse keeper waves goodbye')});
   while (await workOnce(db, config, undefined, undefined, undefined, fetch));
   const found = await new SearchService(db, config).start({q: 'lighthouse keeper', mode: 'catalogue'}, 'alice');
   assert.deepEqual(found.results.map(r => r.id), [manual.id, auto.id]);
   assert.equal(found.results[0].moments[0].summary, 'the lighthouse keeper waves goodbye and then the credits roll', 'quotes stay verbatim');
 } finally { await db.close(); }
});

test('a YouTube block pauses the whole caption lane without spending attempts; missing captions are final', async () => {
 const db = await database();
 try {
   const first = await youtube(db, 'eeeeeeeeeee'), second = await youtube(db, 'fffffffffff'), silent = await youtube(db, 'ggggggggggg');
   await queueCaptions(db, config, [first, second, silent]);
   const blocked = fetcher({eeeeeeeeeee: {status: 'error', code: 'IpBlocked'}, fffffffffff: {status: 'error', code: 'IpBlocked'},
     ggggggggggg: {status: 'error', code: 'IpBlocked'}});
   while (await workOnce(db, config, undefined, undefined, undefined, blocked.fetch));
   assert.equal(blocked.asked.length, 1, 'after the first block nothing else is requested');
   const jobs = (await db.query(`SELECT status,attempts,error_code,run_after>now()+interval '50 minutes' AS paused FROM jobs WHERE kind='youtube_captions'`)).rows;
   assert.equal(jobs.length, 3);
   assert.ok(jobs.every(j => j.status === 'queued' && j.attempts === 0 && j.paused), JSON.stringify(jobs));

   await db.query(`UPDATE jobs SET run_after=now() WHERE kind='youtube_captions'`);
   const done = fetcher({eeeeeeeeeee: ok('youtube_auto', 'hello again')});
   while (await workOnce(db, config, undefined, undefined, undefined, done.fetch));
   assert.equal((await job(db, silent.id)).status, 'complete');
   assert.deepEqual((await job(db, silent.id)).result, {status: 'no_captions', reason: 'NoTranscriptFound'});
   assert.equal((await job(db, first.id)).result.status, 'imported');
   assert.equal(await queueCaptions(db, config, [silent]), 0, 'a video without captions is not asked again');
 } finally { await db.close(); }
});

test('a helper failure is retried like any other job, and ineligible sources are never fetched', async () => {
 const db = await database();
 try {
   const video = await youtube(db, 'hhhhhhhhhhh');
   await queueCaptions(db, config, [video]);
   const broken = fetcher({hhhhhhhhhhh: {status: 'error', code: 'helper_failed'}});
   await workOnce(db, config, undefined, undefined, undefined, broken.fetch);
   const failed = await job(db, video.id);
   assert.deepEqual([failed.status, failed.attempts, failed.error_code], ['queued', 1, 'processing_failed']);

   await db.query(`UPDATE sources SET policy=policy||'{"transcripts":false}' WHERE domain='www.youtube.com'`);
   await db.query(`UPDATE jobs SET run_after=now() WHERE id=$1`, [failed.id]);
   const never = fetcher({});
   await workOnce(db, config, undefined, undefined, undefined, never.fetch);
   assert.deepEqual(never.asked, []);
   assert.equal((await job(db, video.id)).result.status, 'not_permitted');
 } finally { await db.close(); }
});
