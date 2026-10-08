import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {addSiteTemplate, discoverDescriptor, learnSiteSearch, parseSiteResults, parseTemplate, searchSites, validTemplate} from '../src/site-search.js';
import {SourceCircuit} from '../src/deep-runtime.js';
import {UpstreamError, type fetchText} from '../src/http.js';
import {database, testConfig} from './helpers.js';

const read = (file: string) => readFileSync(new URL(`./fixtures/deep-sources/${file}`, import.meta.url), 'utf8');
const home = read('home.html'), xml = read('opensearch.xml'), results = read('results.html'), robots = read('robots.txt');
const config = {...testConfig, DEEP_SOURCES: true};
const domain = 'archive.example', template = 'https://archive.example/search?q={searchTerms}&count=5&start=1';
function fixtureTransport(overrides: Record<string, string|Error> = {}) {
 const asked: string[] = [];
 const text: typeof fetchText = async (url, options) => {
   asked.push(url); assert.equal(options?.trustedOrigin, undefined, 'discovered URLs never bypass DNS protection');
   assert.equal(options?.redirects, 0);
   const u = new URL(url), answer = overrides[u.pathname];
   if (answer instanceof Error) throw answer;
   const text = answer ?? ({'/robots.txt': robots, '/': home, '/opensearch.xml': xml, '/search': results} as Record<string, string>)[u.pathname];
   assert.notEqual(text, undefined, `unexpected request ${url}`);
   return {url, text, contentType: u.pathname.endsWith('.xml') ? 'application/opensearchdescription+xml' : 'text/html'};
 };
 return {asked, text, circuit: new SourceCircuit(), budget: async () => true};
}

test('discovers OpenSearch regardless of attribute order; decodes XML and supports standard placeholders', () => {
 const descriptor = discoverDescriptor(home, 'https://archive.example/', domain);
 assert.equal(descriptor, 'https://archive.example/opensearch.xml');
 assert.equal(parseTemplate(xml, descriptor!, domain), template);
 assert.equal(parseTemplate(`<Url type='text/html' template='/search?q={searchTerms}&amp;unused={extension?}'/>`, descriptor!, domain), 'https://archive.example/search?q={searchTerms}&unused=');
 assert.equal(discoverDescriptor(home.replace('/opensearch.xml', 'https://evil.example/search.xml'), 'https://archive.example/', domain), null);
 assert.equal(discoverDescriptor('<html></html>', 'https://archive.example/', domain), null);
});

test('rejects POST, unknown required placeholders, entities, fragments, credentials, private destinations and host substitutions', () => {
 for (const bad of [xml.replace('method="GET"', 'method="POST"'), xml.replace('{count?}', '{required}'), `<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]>${xml}`])
   assert.equal(parseTemplate(bad, 'https://archive.example/opensearch.xml', domain), null);
 for (const bad of ['https://other.example/?q={searchTerms}', 'http://127.0.0.1/?q={searchTerms}', 'https://user:pass@archive.example/?q={searchTerms}',
   'https://archive.example/{searchTerms}#top', 'https://{searchTerms}.archive.example/search', 'https://archive.example/search?q={unknown}', 'file:///search?q={searchTerms}'])
   assert.equal(validTemplate(bad, domain), false, bad);
});

test('keeps five unique same-domain links and drops navigation, cross-domain links and scripts', () => {
 const rows = parseSiteResults(results, 'https://archive.example/search?q=archive', domain);
 assert.deepEqual(rows.map(r => r.url), ['https://archive.example/item/1', 'https://archive.example/files/report.pdf', 'https://archive.example/item/3', 'https://archive.example/item/4', 'https://archive.example/item/5']);
 assert.equal(rows[0].title, 'First & best');
});

test('cache stores descriptor and attribution; a second query only fetches robots and its results', async () => {
 const db = await database();
 try {
   const deps = fixtureTransport();
   const found = await searchSites(db, config, 'first & second', [domain], deps);
   assert.equal(found.length, 5); assert.deepEqual(found[0].siteSearch, {domain, template});
   assert.equal(new URL(deps.asked.at(-1)!).searchParams.get('q'), 'first & second');
   assert.deepEqual(deps.asked.map(u => new URL(u).pathname), ['/robots.txt', '/', '/opensearch.xml', '/search']);
   const again = fixtureTransport(); await searchSites(db, config, 'next query', [domain], again);
   assert.deepEqual(again.asked.map(u => new URL(u).pathname), ['/robots.txt', '/search']);
   assert.equal((await db.query('SELECT status FROM site_search')).rows[0].status, 'active');
 } finally { await db.close(); }
});

test('negative descriptors are cached, then rediscovered after seven days', async () => {
 const db = await database();
 try {
   const missing = fixtureTransport({'/': '<html>No descriptor</html>'});
   assert.deepEqual(await searchSites(db, config, 'query', [domain], missing), []);
   assert.equal((await db.query('SELECT status FROM site_search')).rows[0].status, 'absent');
   const later = fixtureTransport(); assert.deepEqual(await searchSites(db, config, 'query', [domain], later), []);
   assert.equal(later.asked.length, 0);
   await db.query("UPDATE site_search SET checked_at=now()-interval '8 days'");
   assert.equal((await searchSites(db, config, 'query', [domain], fixtureTransport())).length, 5);
 } finally { await db.close(); }
});

test('robots denial is honored at home, descriptor and results; 404 robots is allowed, 403 fails closed', async () => {
 const db = await database();
 try {
   for (const blocked of ['/', '/opensearch.xml', '/search']) {
     await db.query('DELETE FROM site_search');
     const deps = fixtureTransport({'/robots.txt': `User-agent: *\nDisallow: ${blocked}`});
     assert.deepEqual(await searchSites(db, config, 'query', [domain], deps), []);
     assert.ok(!deps.asked.some(u => new URL(u).pathname === blocked));
     assert.equal(deps.circuit.allows(`site:${domain}`), true);
   }
   await db.query('DELETE FROM site_search');
   assert.equal((await searchSites(db, config, 'query', [domain], fixtureTransport({'/robots.txt': new UpstreamError('upstream_failure', 404)}))).length, 5);
   const denied = fixtureTransport({'/robots.txt': new UpstreamError('upstream_failure', 403)});
   assert.deepEqual(await searchSites(db, config, 'query', [domain], denied), []);
   assert.equal(denied.asked.length, 1);
 } finally { await db.close(); }
});

test('at most two domains; exhausted budgets and flag off make no network requests', async () => {
 const db = await database();
 try {
   const attempts: string[] = [];
   await searchSites(db, config, 'query', [domain, domain, 'second.example', 'third.example'], {
     budget: async (_db, key) => { attempts.push(key); return false; }, text: async () => { throw new Error('must not fetch'); },
   });
   assert.deepEqual(attempts, ['deep:site:archive.example', 'deep:site:second.example']);
   const off = fixtureTransport(); assert.deepEqual(await searchSites(db, testConfig, 'query', [domain], off), []); assert.equal(off.asked.length, 0);
 } finally { await db.close(); }
});

test('site failures open the circuit; slow work cannot fetch after the shared deadline', async () => {
 const db = await database();
 try {
   const deps = fixtureTransport({'/robots.txt': new UpstreamError('upstream_failure', 503)});
   for (let i = 0; i < 4; i++) await searchSites(db, config, 'query', [domain], deps);
   assert.equal(deps.asked.length, 3); assert.equal(deps.circuit.allows(`site:${domain}`), false);
   let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
   const slow = {query: async () => { await gate; return {rows: []}; }} as any;
   assert.deepEqual(await searchSites(slow, {...config, DEEP_SOURCES_TIMEOUT_MS: 15}, 'query', [domain], {
     budget: async () => { calls++; return true; }, text: async () => { throw new Error('must not fetch'); }, circuit: new SourceCircuit(),
   }), []);
   release(); await new Promise(r => setImmediate(r)); assert.equal(calls, 0);
 } finally { await db.close(); }
});

test('manual templates persist, count only actual judgements, drop strictly below 10% after 20 hits, and reject stale credit', async () => {
 const db = await database();
 try {
   const domain = 'rbi.org.in', first = 'https://rbi.org.in/search?q={searchTerms}', second = 'https://rbi.org.in/new-search?q={searchTerms}';
   await addSiteTemplate(db, domain, first);
   const url = 'https://rbi.org.in/report', source = new Map([[url, {domain, template: first}]]);
   await learnSiteSearch(db, [{url, relevance: null}, {url: 'https://unrelated.example/', relevance: 9}], source);
   assert.equal(Number((await db.query('SELECT hits FROM site_search')).rows[0].hits), 0);
   for (let i = 0; i < 20; i++) await learnSiteSearch(db, [{url, relevance: i < 2 ? 9 : 3}], source);
   assert.equal((await db.query('SELECT status FROM site_search')).rows[0].status, 'manual');
   await learnSiteSearch(db, [{url, relevance: 3}], source);
   const rejected = (await db.query('SELECT * FROM site_search')).rows[0];
   assert.equal(rejected.status, 'rejected'); assert.equal(rejected.template, null); assert.equal(Number(rejected.hits), 21);
   const noFetch = fixtureTransport(); assert.deepEqual(await searchSites(db, config, 'query', [domain], noFetch), []); assert.equal(noFetch.asked.length, 0);
   await addSiteTemplate(db, domain, second);
   await learnSiteSearch(db, [{url, relevance: 9}], source);
   const reset = (await db.query('SELECT * FROM site_search')).rows[0]; assert.equal(Number(reset.hits), 0); assert.equal(reset.template, second);
   await assert.rejects(addSiteTemplate(db, domain, 'https://evil.example/?q={searchTerms}'), /invalid_site_template/);
   await assert.rejects(addSiteTemplate(db, 'unknown.example', 'https://unknown.example/?q={searchTerms}'), /invalid_site_template/);
 } finally { await db.close(); }
});

test('each site logs how far its search got, without the query or the site', async () => {
 const db = await database();
 try {
   const lines: Record<string, unknown>[] = [];
   const deps = {...fixtureTransport(), log: (l: Record<string, unknown>) => lines.push(l)};
   await searchSites(db, config, 'secret words', [domain], deps);
   assert.equal(lines.length, 1);
   assert.equal(lines[0].event, 'site_search'); assert.equal(lines[0].stage, 'search'); assert.equal(lines[0].rows, 5);
   assert.ok(!JSON.stringify(lines).includes('secret') && !JSON.stringify(lines).includes(domain));
   const failed: Record<string, unknown>[] = [];
   await searchSites(db, config, 'query', ['other.example'], {...fixtureTransport({'/': new UpstreamError('too_many_redirects')}), log: (l: Record<string, unknown>) => failed.push(l)});
   assert.equal(failed[0].stage, 'home'); assert.equal(failed[0].error, 'too_many_redirects'); assert.equal(failed[0].rows, 0);
 } finally { await db.close(); }
});
