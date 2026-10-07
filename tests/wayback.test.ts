import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rescueDeadLinks, snapshotURL} from '../src/wayback.js';
import {SourceCircuit} from '../src/deep-runtime.js';
import {UpstreamError} from '../src/http.js';
import {testConfig} from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/deep-sources/responses.json', import.meta.url), 'utf8')).wayback;
const config = {...testConfig, DEEP_SOURCES: true}, original = 'https://source.example/report.pdf';
const snapshot = 'https://web.archive.org/web/20240101120000/https://source.example/report.pdf';
const db = {} as any;

test('valid snapshots use HTTPS, match the original exactly, and use raw replay for files', () => {
 assert.equal(snapshotURL(fixture, original), snapshot);
 assert.equal(snapshotURL(fixture, original, true), snapshot.replace('/20240101120000/', '/20240101120000id_/'));
 assert.equal(snapshotURL(fixture, 'https://source.example/another.pdf'), null);
 for (const change of [{available: false}, {status: '404'}, {url: 'https://evil.example/web/20240101120000/' + original},
   {url: 'https://web.archive.org/web/not-a-date/' + original}, {url: 'https://user:secret@web.archive.org/web/20240101120000/' + original}]) {
   const bad = structuredClone(fixture); Object.assign(bad.archived_snapshots.closest, change); assert.equal(snapshotURL(bad, original), null);
 }
 assert.equal(snapshotURL({}, original), null);
});

test('404, 410 and DNS failures trigger budgeted availability checks', async () => {
 for (const failure of [404, 410, new UpstreamError('dns_failure')]) {
   const buckets: string[] = [];
   const swaps = await rescueDeadLinks(db, config, [{url: original}], {
     circuit: new SourceCircuit(), budget: async (_db, key) => { buckets.push(key); return true; },
     probe: async (_url, _timeout, distinguishDNS) => { assert.equal(distinguishDNS, true); if (failure instanceof Error) throw failure; return {status: failure, url: original, redirects: []}; },
     json: async url => { assert.equal(new URL(url).searchParams.get('url'), original); return fixture; },
   });
   assert.equal(swaps.get(original), snapshot); assert.deepEqual(buckets, ['deep:wayback']);
 }
});

test('healthy, blocked, rate limited and general network failures do not rescue', async () => {
 for (const failure of [200, 403, 429, 500, new UpstreamError('network_error'), new UpstreamError('unsafe_destination'), new UpstreamError('timeout')]) {
   let calls = 0;
   const swaps = await rescueDeadLinks(db, config, [{url: original}], {
     probe: async () => { if (failure instanceof Error) throw failure; return {status: failure, url: original, redirects: []}; },
     budget: async () => { calls++; return true; }, json: async () => { throw new Error('must not fetch'); },
   });
   assert.equal(swaps.size, 0); assert.equal(calls, 0);
 }
});

test('flag off, max five probes, exhausted budget and unavailable snapshots', async () => {
 let probes = 0, calls = 0;
 const deps = {probe: async (url: string) => { probes++; return {status: 404, url, redirects: []}; }, budget: async () => false,
   json: async () => { calls++; return fixture; }};
 assert.equal((await rescueDeadLinks(db, testConfig, [{url: original}], deps)).size, 0); assert.equal(probes, 0);
 await rescueDeadLinks(db, config, Array.from({length: 10}, (_, i) => ({url: `${original}?i=${i}`})), deps);
 assert.equal(probes, 5); assert.equal(calls, 0);
 assert.equal((await rescueDeadLinks(db, config, [{url: original}], {...deps, budget: async () => true, json: async () => ({archived_snapshots: {}})})).size, 0);
});

test('archive timeouts finish promptly and three failures open its circuit', async () => {
 const circuit = new SourceCircuit(); let calls = 0;
 for (let i = 0; i < 4; i++) {
   const out = await rescueDeadLinks(db, {...config, DEEP_SOURCES_TIMEOUT_MS: 25}, [{url: original}], {
     circuit, probe: async url => ({url, status: 410, redirects: []}), budget: async () => true,
     json: async () => { calls++; throw new UpstreamError('upstream_failure', 503); },
   });
   assert.equal(out.size, 0);
 }
 assert.equal(calls, 3); assert.equal(circuit.allows('wayback'), false);
 assert.equal((await rescueDeadLinks(db, {...config, DEEP_SOURCES_TIMEOUT_MS: 15}, [{url: original}], {
   circuit: new SourceCircuit(), probe: async () => new Promise(() => {}),
 })).size, 0);
});
