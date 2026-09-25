import {test} from 'node:test';
import assert from 'node:assert/strict';
import { romanize, soundKey, soundKeys, queryKeys } from '../src/phonetic.js';
import { database, fixture, testConfig } from './helpers.js';
import { importTranscript } from '../src/moments.js';
import { SearchService } from '../src/search.js';

test('Devanagari is romanized the way a Hindi speaker would spell it in Latin letters', () => {
 assert.equal(romanize('नमस्ते दोस्तों'), 'namaste doston');
 assert.equal(romanize('द नंबर ऑफ़ थिंग्स दैट आर पॉसिबल'), 'da nambar of things dait aar posibal');
 assert.equal(romanize('डोपामिन का एंटीसिपेशन गैप'), 'dopamin ka entisipeshan gaip');
 assert.equal(romanize('Mixed text: वेबसाइट, 2026।'), 'Mixed text: vebsait, 2026.');
});

test('English words and their Devanagari spellings share a sound key', () => {
 const pairs = [['anticipation', 'एंटीसिपेशन'], ['anticipation', 'एंटीिसिपेशन'], ['gap', 'गैप'], ['number', 'नंबर'], ['things', 'थिंग्स'],
   ['possible', 'पॉसिबल'], ['website', 'वेबसाइट'], ['upload', 'अपलोड'], ['trimming', 'ट्रिमिंग'], ['part', 'पार्ट'], ['dopamine', 'डोपामिन']];
 for (const [english, hindi] of pairs) assert.equal(soundKey(romanize(hindi)), soundKey(english), `${english} ~ ${hindi}`);
 assert.notEqual(soundKey('anticipation'), soundKey('ants'), 'keys are not truncated');
 assert.equal(soundKey('knife'), soundKey('nife'));
 assert.equal(soundKey('Hailie'), soundKey('haylee'));
});

test('query keys skip stopwords and refuse queries too short to match safely by sound', () => {
 assert.deepEqual(queryKeys('number of things that are possible'), [soundKey('number'), soundKey('things'), soundKey('possible')]);
 assert.deepEqual(queryKeys('anticipation gap'), [soundKey('anticipation'), soundKey('gap')]);
 assert.deepEqual(queryKeys('gap'), [], 'one short word would match far too much');
 assert.deepEqual(queryKeys('the and of'), []);
 assert.deepEqual(queryKeys('"exact phrase" -excluded'), [], 'search operators keep their exact meaning');
 assert.deepEqual(queryKeys('एंटीसिपेशन गैप'), queryKeys('anticipation gap'), 'a Devanagari query is romanized too');
});

test('segment keys cover a phrase that runs into the next caption line', () => {
 const keys = soundKeys('डोपामिन का एंटीसिपेशन', 'गैप है');
 assert.ok(queryKeys('anticipation gap').every(k => keys.includes(k)));
 assert.ok(!keys.includes(''));
});

test('an English query finds the moment in Hindi captions by sound, below exact matches, with the caption text quoted', async () => {
 const db = await database();
 try {
   const hindi = await fixture(db, 'Fix your focus', 'A talk about attention');
   const english = await fixture(db, 'Habits explained', 'A lecture about routines');
   const segment = (start: number, text: string) => ({start, end: start + 3, text});
   await importTranscript(db, {content_id: hindi.id, language: 'hi', origin: 'TEST FIXTURE', content_version: 'hi-1', timing_quality: 'provided',
     retention_permitted: true, source_kind: 'youtube_auto', segments: [segment(10, 'नमस्ते दोस्तों आज हम बात करेंगे'),
       segment(60, 'डोपामिन का एंटीसिपेशन'), segment(63, 'गैप है एक्चुअली'), segment(90, 'धन्यवाद')]});
   await importTranscript(db, {content_id: english.id, language: 'en', origin: 'TEST FIXTURE', content_version: 'en-1', timing_quality: 'provided',
     retention_permitted: true, segments: [segment(5, 'welcome back everyone'), segment(40, 'the anticipation gap is what keeps us hooked')]});
   const service = new SearchService(db, testConfig);

   const found = await service.start({q: 'anticipation gap', mode: 'catalogue'}, 'alice');
   assert.deepEqual(found.results.map(r => r.id), [english.id, hindi.id], 'the exact match ranks first');
   const moment = found.results[1].moments.find(m => m.evidence_type === 'transcript_supported')!;
   assert.deepEqual(moment.focus, [60, 63], 'the moment points at the line where the phrase starts');
   assert.ok(moment.summary.includes('डोपामिन का एंटीसिपेशन गैप है'), 'the quote is the stored Devanagari caption');
   const stored = (await db.query(`SELECT search_text FROM transcript_segments WHERE content_id=$1 AND start_seconds=60`, [hindi.id])).rows[0];
   assert.equal(stored.search_text, 'dopamin ka entisipeshan');

   assert.deepEqual((await service.start({q: 'gap', mode: 'catalogue'}, 'alice')).results.map(r => r.id), [english.id],
     'a lone short word matches exactly only, never by sound');
   assert.deepEqual((await service.start({q: 'anticipation "gap"', mode: 'catalogue'}, 'alice')).results.map(r => r.id), [english.id],
     'search operators keep exact matching only');
   assert.deepEqual((await service.start({q: 'quantum entanglement', mode: 'catalogue'}, 'alice')).results, []);
 } finally { await db.close(); }
});
