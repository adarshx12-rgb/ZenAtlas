import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchWeb, webSearchInput, type WebResult} from '../src/web.js';
import {reviewWeb} from '../src/web-review.js';
import {runHunt, type HuntState} from '../src/doc-hunt.js';
import type {SiteRow} from '../src/site-search.js';
import type {Judge} from '../src/judge.js';
import {database, testConfig} from './helpers.js';

const config = {...testConfig, DEEP_SOURCES: true, BRAVE_SEARCH_API_KEY: 'fixture', SEARXNG_BASE_URL: 'http://deep-web.test',
 SEARXNG_WEB_ENGINES: 'bing', DOC_BLOCKLISTS: '', DOC_SOURCES_ENABLED: false, ANSWER_ENABLED: false, REQUIREMENTS_ENABLED: false};
const row = (url: string, engine = 'deep:fixture'): SiteRow => ({url, title: url.split('/').at(-1)!, snippet: 'Fixture description', published: null, engine});
const result = (url: string): WebResult => ({id: url, url, title: 'Fixture result', source_name: new URL(url).hostname, snippet: null,
 published: null, doc_type: null, access: null, engine: 'deep:fixture', preview: null});
const noDB = {} as any;
const base = {
 budget: async () => true, transport: async () => ({web: {results: []}, results: []}),
 route: async () => ({field: 'history', sites: ['archive.example'], learned: []}),
 rewrite: async () => ({query: 'archive', corrected: 'archive', changed: false, topic: null, topic_kind: null, searches: []}),
 deep: async () => [], siteSearch: async () => [], rescue: async () => new Map<string, string>(),
 review: () => null, sources: async () => ({docs: [], sites: [], providers: []}),
 peek: async (url: string) => ({url, status: 200, contentType: 'application/pdf', length: 100, head: Buffer.from('%PDF-1.7')}),
 hunt: () => 'fixture-hunt',
};

test('deep and site retrieval start alongside Brave and SearXNG; site success suppresses only that Brave fallback', async () => {
 let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const started = new Set<string>(), braveQueries: string[] = [];
 const searching = searchWeb(noDB, config, webSearchInput.parse({q: 'archive'}), {...base,
   deep: async () => { started.add('deep'); await gate; return [row('https://loc.gov/item/1')]; },
   siteSearch: async () => { started.add('site'); await gate; return [{...row('https://archive.example/item/1'), siteSearch: {domain: 'archive.example', template: 'https://archive.example/search?q={searchTerms}'}}]; },
   transport: async url => {
     const u = new URL(url); started.add(u.hostname === 'api.search.brave.com' ? 'brave' : 'searxng');
     if (u.hostname === 'api.search.brave.com') { braveQueries.push(u.searchParams.get('q')!); return {web: {results: [{url: 'https://general.example/brave', title: 'Brave'}]}}; }
     return {results: [{url: 'https://general.example/searx', title: 'Searx'}]};
   },
 });
 try { for (let i = 0; i < 100 && started.size < 4; i++) await new Promise(r => setImmediate(r)); assert.equal(started.size, 4); }
 finally { release(); }
 const out = await searching;
 assert.equal(out.results.length, 4); assert.deepEqual(braveQueries, ['archive']);
});

test('missing/failed site search keeps Brave site: fallback, and connector domains are not crawled', async () => {
 const asked: string[] = [], sites: string[][] = [];
 const out = await searchWeb(noDB, config, webSearchInput.parse({q: 'archive'}), {...base,
   route: async () => ({field: 'history', sites: ['loc.gov', 'archive.example', 'second.example', 'third.example'], learned: []}),
   siteSearch: async (_db, _config, _q, domains) => { sites.push(domains); throw new Error('timeout'); },
   transport: async url => { const u = new URL(url); if (u.hostname !== 'api.search.brave.com') return {results: []};
     const q = u.searchParams.get('q')!; asked.push(q); return {web: {results: q.includes('site:') ? [{url: `https://${q.split('site:')[1]}/record`, title: 'Record'}] : []}}; },
 });
 assert.deepEqual(sites, [['archive.example', 'second.example']]);
 assert.equal(asked.filter(q => q.includes('site:')).length, 4); assert.equal(out.results.length, 4);
});

test('flag off adds no work and keeps the ten-row routed allocation; flag on reserves sixteen', async () => {
 const transport = async (url: string) => {
   const u = new URL(url); if (u.hostname !== 'api.search.brave.com') return {results: []};
   const site = u.searchParams.get('q')!.split('site:')[1];
   return {web: {results: Array.from({length: site ? 5 : 40}, (_, i) => ({url: `https://${site ?? 'general.example'}/${i}`, title: `Result ${i}`}))}};
 };
 const route = async () => ({field: 'science', sites: ['a.example', 'b.example', 'c.example', 'd.example'], learned: []});
 const off = await searchWeb(noDB, {...config, DEEP_SOURCES: false}, webSearchInput.parse({q: 'archive'}), {...base, transport, route,
   deep: async () => { assert.fail('flag off'); }, siteSearch: async () => { assert.fail('flag off'); }, rescue: async () => { assert.fail('flag off'); },
 });
 assert.equal(off.results.slice(0, 40).filter(r => r.source_name !== 'general.example').length, 10);
 const on = await searchWeb(noDB, config, webSearchInput.parse({q: 'archive'}), {...base, transport, route,
   deep: async () => Array.from({length: 15}, (_, i) => row(`https://deep.example/${i}`)),
 });
 assert.equal(on.results.slice(0, 40).filter(r => r.source_name !== 'general.example').length, 16);
 assert.equal(on.results.slice(0, 24).every(r => r.source_name === 'general.example'), true);
});

test('Docs routes files through verification and record pages into the hunt; rescued previews target the snapshot', async () => {
 const checked: string[] = [], hunted: WebResult[][] = [];
 const original = 'https://files.example/report.pdf', archived = 'https://web.archive.org/web/20240101120000id_/' + original;
 const out = await searchWeb(noDB, config, webSearchInput.parse({q: 'archive', kind: 'docs'}), {...base,
   deep: async () => [row(original), row('https://journal.example/article/1')],
   siteSearch: async () => [row('https://archive.example/record/1')],
   rescue: async () => new Map([[original, archived]]),
   peek: async url => { checked.push(url); return base.peek(url); },
   hunt: (_q, docs, _explore, sites) => { hunted.push(sites); assert.equal(docs.length, 1); return 'fixture-hunt'; },
 });
 assert.deepEqual(checked, [archived]); assert.equal(out.results[0].url, archived); assert.equal(out.results[0].doc_type, 'pdf'); assert.ok(out.results[0].preview);
 assert.deepEqual(hunted[0].map(r => r.url), ['https://archive.example/record/1', 'https://journal.example/article/1']);
 assert.equal(out.hunt, 'fixture-hunt');
});

test('later pages and exact refill searches never launch deep connectors or site discovery', async () => {
 for (const options of [{page: 2}, {exact: '1'}]) {
   await searchWeb(noDB, config, webSearchInput.parse({q: 'archive', ...options}), {...base,
     deep: async () => { assert.fail('no route'); }, siteSearch: async () => { assert.fail('no route'); },
   });
 }
});

test('Web judging credits field_sources at the original URL and credits only the originating template', async () => {
 const db = await database();
 try {
   const domain = 'archive.example', template = 'https://archive.example/search?q={searchTerms}', original = 'https://archive.example/record';
   await db.query("INSERT INTO site_search(domain,template,status) VALUES($1,$2,'active')", [domain, template]);
   const url = 'https://web.archive.org/web/20240101120000/' + original;
   const judge: Judge = {judge: async (_q, candidates) => ({model: 'fixture', verdicts: new Map(candidates.map(c => [c.key, {key: c.key, relevance: 9, reason: 'Matched', momentKeys: []}]))})};
   await reviewWeb(db, config, 'archive', [result(url)], {judge, council: null, strong: null, screener: undefined, refill: null, log: () => {},
     field: 'history', originalURLs: new Map([[url, original]]), siteAttribution: new Map([[url, {domain, template}]]),
     pages: {check: async () => ({status: 'checked', title: 'Archive', text: 'Historical record', description: null, libraries: [], badges: []})},
   });
   const fields = (await db.query('SELECT domain,good FROM field_sources')).rows;
   assert.deepEqual(fields, [{domain, good: 1}]);
   const cached = (await db.query('SELECT hits,good FROM site_search')).rows[0]; assert.equal(Number(cached.hits), 1); assert.equal(Number(cached.good), 1);
 } finally { await db.close(); }
});

test('Docs learning follows a record page to a file on a CDN and includes poor judged documents', async () => {
 const db = await database();
 try {
   const domain = 'archive.example', template = 'https://archive.example/search?q={searchTerms}', origin = 'https://archive.example/record';
   await db.query("INSERT INTO site_search(domain,template,status) VALUES($1,$2,'active')", [domain, template]);
   const state: HuntState = {status: 'running', query: 'archive', sites: [], docs: [], checked_pages: 0, removed: 0, providers: []};
   await runHunt(db, config, state, true, {
     field: 'history', siteAttribution: new Map([[origin, {domain, template}]]), sites: async () => [],
     pages: {check: async () => ({status: 'checked', title: 'Archive', description: null, text: 'The archive', libraries: [], badges: [],
       links: [{url: 'https://cdn.example/report.pdf', title: 'Report'}, {url: 'https://cdn.example/wrong.pdf', title: 'Wrong report'}]})},
     hunter: {classify: async (_q, links) => links.map(l => ({url: l.url, choice: 'document', confidence: 1}))}, peek: base.peek,
     review: async (_q, docs) => ({results: docs.filter(d => d.url.endsWith('/report.pdf')).map(d => ({...d, judgement: {relevance: 9, reason: 'Matches'}})),
       removed: 1, providers: [], trace: docs.map(d => ({url: d.url, relevance: d.url.endsWith('/report.pdf') ? 9 : 2}))}),
   }, [result(origin)]);
   const cached = (await db.query('SELECT hits,good FROM site_search')).rows[0]; assert.equal(Number(cached.hits), 2); assert.equal(Number(cached.good), 1);
   assert.deepEqual((await db.query('SELECT domain,good FROM field_sources ORDER BY domain')).rows,
     [{domain: 'archive.example', good: 1}, {domain: 'cdn.example', good: 1}]);
 } finally { await db.close(); }
});
