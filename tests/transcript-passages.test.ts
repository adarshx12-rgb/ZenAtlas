import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture} from './helpers.js';
import {importTranscript} from '../src/moments.js';
import {retainedEvidence} from '../src/retained-evidence.js';
import {transcriptPassages} from '../src/transcript-passages.js';

const seg = (i: number, text: string) => ({start: i * 10, end: i * 10 + 10, text});

test('a short transcript becomes consecutive passages cut at line boundaries, in order', () => {
 const lines = Array.from({length: 30}, (_, i) => seg(i, `line ${i} ${'x'.repeat(90)}`));
 const out = transcriptPassages(lines, [], 24000, 1000);
 assert.ok(out.length >= 3);
 assert.equal(out.map(p => p.text).join(' '), lines.map(l => l.text).join(' '), 'every line kept verbatim, in order');
 for (const p of out) assert.ok(p.text.length <= 1000);
 assert.equal(out[0].start, 0); assert.equal(out.at(-1)!.end, 300);
});

test('a long transcript keeps the passages with the most requirement terms, up to the cap, in time order', () => {
 const lines = Array.from({length: 100}, (_, i) => seg(i, i === 70 ? 'he handed the playstation to a subscriber' : `filler words number ${i} ${'y'.repeat(80)}`));
 const out = transcriptPassages(lines, ['playstation', 'subscriber'], 2000, 1000);
 assert.ok(out.reduce((n, p) => n + p.text.length, 0) <= 2000);
 assert.ok(out.some(p => p.text.includes('playstation to a subscriber')));
 assert.deepEqual(out.map(p => p.start), [...out.map(p => p.start)].sort((a, b) => a - b));
});

test('no segments give no passages; one oversized line is truncated, never dropped', () => {
 assert.deepEqual(transcriptPassages([], ['a'], 24000), []);
 const out = transcriptPassages([seg(0, 'z'.repeat(5000))], [], 24000, 2400);
 assert.equal(out.length, 1); assert.equal(out[0].text.length, 2400);
});

test('retained evidence gives the whole stored transcript when a cap is given, and ranked windows otherwise', async () => {
 const db = await database();
 try {
   const item = await fixture(db, 'Giveaway video', 'Gifts for fans');
   const lines = Array.from({length: 12}, (_, i) => seg(i, `caption line ${i} where something happens`));
   await importTranscript(db, {content_id: item.id, language: 'en', origin: 'fixture', content_version: 'v1', timing_quality: 'provided', retention_permitted: true, segments: lines});
   const full = (await retainedEvidence(db, [item.id], 'playstation subscriber', {maxChars: 24000})).get(item.id)!;
   assert.equal(full.transcripts.map(t => t.text).join(' '), lines.map(l => l.text).join(' '));
   assert.equal(full.transcripts[0].start, 0);
   const ranked = (await retainedEvidence(db, [item.id], 'playstation subscriber')).get(item.id)!;
   assert.ok(ranked.transcripts.length >= 1 && ranked.transcripts.length <= 3, 'the old windows without a cap');
 } finally { await db.close(); }
});
