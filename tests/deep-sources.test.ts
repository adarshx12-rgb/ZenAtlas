import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deepRegistry, findDeepSources, parseDeepRows, selectConnectors, CKAN_PORTALS} from '../src/deep-sources.js';
import {SourceCircuit, within} from '../src/deep-runtime.js';
import {UpstreamError} from '../src/http.js';
import {takeBudget} from '../src/budgets.js';
import {configSchema} from '../src/config.js';
import {database, testConfig} from './helpers.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/deep-sources/responses.json', import.meta.url), 'utf8'));
const config = {...testConfig, DEEP_SOURCES: true, COURTLISTENER_API_KEY: 'fixture-court', DATA_GOV_API_KEY: 'fixture-gov',
 EUROPEANA_API_KEY: 'fixture-europeana', OPENALEX_API_KEY: 'fixture-openalex', SEC_USER_AGENT: 'Fixture App contact@example.org'};
const route = (field: string) => ({field, sites: [], learned: []});
const noDB = {} as any;
const expected: Record<string, string> = {
 europe_pmc: 'https://europepmc.org/articles/PMC1234567', clinical_trials: 'https://clinicaltrials.gov/study/NCT01234567',
 openalex: 'https://repository.example/paper.pdf', doaj: 'https://journal.example/article/1',
 courtlistener: 'https://www.courtlistener.com/opinion/6613686/foo-v-foo/',
 sec_edgar: 'https://www.sec.gov/Archives/edgar/data/1122304/000119312515118890/filing.htm',
 govinfo: 'https://www.govinfo.gov/content/pkg/CREC-2018-10-04/pdf/CREC-2018-10-04.pdf',
 federal_register: 'https://www.govinfo.gov/content/pkg/FR-2024-01-02/pdf/2023-00001.pdf',
 ckan: 'https://data.example/observations.csv', eu_data: 'http://data.europa.eu/88u/dataset/public-data',
 loc: 'https://www.loc.gov/item/2024000001/', europeana: 'https://www.europeana.eu/item/123/item1',
 open_library: 'https://openlibrary.org/works/OL45804W', huggingface: 'https://huggingface.co/google-bert/bert-base-uncased',
 stack_exchange: 'https://stackoverflow.com/questions/1/example', gdelt: 'https://news.example/story',
};
for (const [name, url] of Object.entries(expected)) test(`${name}: parses the offline response and rejects a broken envelope`, () => {
 const rows = parseDeepRows(name, fixtures[name]);
 assert.equal(rows.length, 1); assert.equal(rows[0].url, url); assert.ok(rows[0].title); assert.equal(rows[0].engine, `deep:${name}`);
 assert.throws(() => parseDeepRows(name, {}), /malformed_response/);
});

test('file/record fallbacks, secondary endpoints, abstract positions and hostile URLs', () => {
 const pmc = structuredClone(fixtures.europe_pmc); delete pmc.resultList.result[0].pmcid;
 assert.equal(parseDeepRows('europe_pmc', pmc)[0].url, 'https://europepmc.org/article/MED/12345678');
 assert.equal(parseDeepRows('openalex', fixtures.openalex)[0].snippet, 'A research abstract');
 assert.equal(parseDeepRows('loc', fixtures.chronicling_america)[0].url, 'https://www.loc.gov/resource/sn83030214/1918-11-11/ed-1/');
 assert.equal(parseDeepRows('huggingface', fixtures.huggingface_datasets, 'datasets')[0].url, 'https://huggingface.co/datasets/stanfordnlp/imdb');
 const ckan = structuredClone(fixtures.ckan); ckan.result.results[0].resources = [];
 for (const portal of CKAN_PORTALS) assert.equal(parseDeepRows('ckan', ckan, portal.record)[0].url, portal.record + 'dataset-1');
 const bad = structuredClone(fixtures.gdelt); bad.articles[0].url = 'http://127.0.0.1/private';
 assert.deepEqual(parseDeepRows('gdelt', bad), []);
 assert.equal(parseDeepRows('gdelt', fixtures.gdelt)[0].published, '2024-01-01T12:00:00Z');
});

test('registry request contracts: encoded query, fixed origins, credentials, POST search and every sub-endpoint', async () => {
 const calls: {name: string; url: URL; options: any}[] = [];
 const registry = deepRegistry(config, async (name, url, options) => {
   const u = new URL(url); calls.push({name, url: u, options});
   if (name === 'ckan') return u.hostname === 'data.europa.eu' ? fixtures.eu_data : fixtures.ckan;
   if (name === 'loc' && u.pathname.includes('chronicling')) return fixtures.chronicling_america;
   if (name === 'huggingface' && u.pathname.endsWith('datasets')) return fixtures.huggingface_datasets;
   return fixtures[name];
 });
 assert.equal(registry.length, 15);
 const query = 'heart & lung "trial"';
 for (const connector of registry) {
   const rows = await connector.search(query);
   assert.ok(rows.length >= 1 && rows.length <= 5, connector.name);
 }
 assert.equal(calls.filter(c => c.name === 'ckan').length, 4);
 assert.equal(calls.filter(c => c.name === 'loc').length, 2);
 assert.equal(calls.filter(c => c.name === 'huggingface').length, 2);
 assert.equal(calls.find(c => c.name === 'sec_edgar')!.options.headers['User-Agent'], config.SEC_USER_AGENT);
 assert.equal(calls.find(c => c.name === 'courtlistener')!.options.headers.Authorization, 'Token fixture-court');
 const gov = calls.find(c => c.name === 'govinfo')!;
 assert.equal(gov.options.method, 'POST'); assert.equal(gov.options.body.query, query);
 assert.equal(gov.url.searchParams.get('api_key'), config.DATA_GOV_API_KEY);
 assert.equal(calls.find(c => c.name === 'clinical_trials')!.url.searchParams.get('query.term'), query);
 assert.equal(calls.find(c => c.name === 'openalex')!.url.searchParams.get('api_key'), config.OPENALEX_API_KEY);
 assert.ok(decodeURIComponent(calls.find(c => c.name === 'doaj')!.url.pathname).endsWith(query));
});

test('selection is by field and tab, max three, missing keys skipped before selection; flag defaults off', async () => {
 const registry = deepRegistry(config, async () => { throw new Error('must not call'); });
 assert.deepEqual(selectConnectors(registry, 'medicine', 'web').map(c => c.name), ['europe_pmc', 'clinical_trials', 'openalex']);
 assert.equal(selectConnectors(registry, null, 'docs').length, 0);
 assert.equal(selectConnectors(registry, 'other', 'web').length, 0);
 const without = deepRegistry(testConfig, async () => { throw new Error('must not call'); });
 for (const name of ['courtlistener','govinfo','europeana','openalex','sec_edgar']) assert.ok(!without.some(c => c.name === name));
 assert.equal(testConfig.DEEP_SOURCES, false);
 assert.equal(configSchema.parse({DATABASE_URL:'x',SESSION_SECRET:testConfig.SESSION_SECRET,ADMIN_TOKEN:testConfig.ADMIN_TOKEN,DEEP_SOURCES:'1'}).DEEP_SOURCES, true);
 assert.deepEqual(await findDeepSources(noDB, testConfig, 'query', route('medicine'), 'web', {budget: async () => { throw new Error('off'); }}), []);
});

test('per-connector daily budgets are atomic, isolated, and do not trip circuits', async () => {
 const db = await database();
 try {
   const outcomes = await Promise.all(Array.from({length: 6}, () => takeBudget(db, 'deep:gdelt', 2)));
   assert.equal(outcomes.filter(Boolean).length, 2);
   assert.equal(await takeBudget(db, 'deep:loc', 2), true);
   const circuit = new SourceCircuit(); let requests = 0;
   for (let i = 0; i < 4; i++) assert.deepEqual(await findDeepSources(db, {...config, DEEP_SOURCES_DAILY_BUDGET: 2}, 'news', route('news'), 'web',
     {circuit, json: async () => { requests++; return fixtures.gdelt; }}), []);
   assert.equal(requests, 0); assert.equal(circuit.allows('gdelt'), true);
   // Multi-endpoint budget exhaustion is also neutral.
   await findDeepSources(db, config, 'data', route('datasets'), 'web', {circuit, budget: async () => false, json: async () => { throw new Error('no'); }});
   assert.equal(circuit.allows('ckan'), true);
 } finally { await db.close(); }
});

test('sources run concurrently; one stall cannot lose fast peers or successful CKAN portals', async () => {
 const asked: string[] = [], buckets: string[] = [];
 const rows = await findDeepSources(noDB, {...config, DEEP_SOURCES_TIMEOUT_MS: 80}, 'data', route('datasets'), 'web', {
   circuit: new SourceCircuit(), budget: async (_db, key) => { buckets.push(key); return true; },
   json: async (url, options) => {
     const u = new URL(url); asked.push(u.hostname);
     assert.ok(options!.timeoutMs! <= 80); assert.equal(options!.trustedOrigin, u.origin); assert.equal(options!.redirects, 0);
     if (u.hostname === 'huggingface.co') return u.pathname.endsWith('datasets') ? fixtures.huggingface_datasets : fixtures.huggingface;
     if (u.hostname === 'catalog.data.gov') return fixtures.ckan;
     return new Promise(() => {});
   },
 });
 assert.equal(asked.length, 6); assert.equal(buckets.filter(b => b === 'deep:ckan').length, 4);
 assert.ok(rows.some(r => r.engine === 'deep:huggingface'));
 assert.ok(rows.some(r => r.engine === 'deep:ckan'));
});

test('three consecutive failures disable a source for 30 minutes; success resets the streak', async () => {
 let now = 1000; const circuit = new SourceCircuit(() => now);
 circuit.failure('x'); circuit.failure('x'); circuit.success('x'); circuit.failure('x');
 assert.equal(circuit.allows('x'), true);
 circuit.failure('x'); circuit.failure('x'); assert.equal(circuit.allows('x'), false);
 now += 30 * 60_000 - 1; assert.equal(circuit.allows('x'), false);
 now++; assert.equal(circuit.allows('x'), true);
 let requests = 0;
 const deps = {circuit, budget: async () => true, json: async () => { requests++; throw new UpstreamError('upstream_failure', 503); }};
 for (let i = 0; i < 4; i++) await findDeepSources(noDB, config, 'news', route('news'), 'web', deps);
 assert.equal(requests, 3);
 now += 30 * 60_000;
 assert.equal((await findDeepSources(noDB, config, 'news', route('news'), 'web', {...deps, json: async () => fixtures.gdelt})).length, 1);
});

test('timeout bounds budget waiting and late work cannot issue a request or reset the circuit', async () => {
 await assert.rejects(within(Date.now() + 15, () => new Promise(() => {})), /timeout/);
 let release!: (v: boolean) => void; let requests = 0;
 const budget = new Promise<boolean>(r => { release = r; }); const circuit = new SourceCircuit();
 const out = await findDeepSources(noDB, {...config, DEEP_SOURCES_TIMEOUT_MS: 20}, 'news', route('news'), 'web',
   {circuit, budget: () => budget, json: async () => { requests++; return fixtures.gdelt; }});
 assert.deepEqual(out, []); release(true);
 await new Promise(r => setImmediate(r)); assert.equal(requests, 0);
 circuit.failure('gdelt'); circuit.failure('gdelt'); assert.equal(circuit.allows('gdelt'), false);
});

test('large responses deduplicate and cap each connector at five rows', async () => {
 const d = {articles: Array.from({length: 20}, (_, i) => ({...fixtures.gdelt.articles[0], url: `https://news.example/story/${Math.floor(i / 2)}`}))};
 const rows = await deepRegistry(config, async () => d).find(c => c.name === 'gdelt')!.search('news');
 assert.equal(rows.length, 5); assert.equal(new Set(rows.map(r => r.url)).size, 5);
});
