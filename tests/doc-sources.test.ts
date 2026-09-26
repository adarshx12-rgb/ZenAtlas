import {test} from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { findDocuments } from '../src/doc-sources.js';
import { viewerOf } from '../src/doc-viewers.js';
import { parseBlocklist, explicit, blockedHost, setBlocklist, unsafeLink } from '../src/safety.js';
import { checkDocument } from '../src/doc-review.js';
import { organisation, sameOrganisation } from '../src/doc-hunt.js';
import { searchWeb, webSearchInput } from '../src/web.js';

test('viewer pages are documents only on their document paths', () => {
 assert.deepEqual(viewerOf('https://www.scribd.com/document/382156044/Manorama-Year-Book'), {name: 'Scribd', group: 'pdf'});
 assert.equal(viewerOf('https://www.scribd.com/search?query=manorama'), null);
 assert.equal(viewerOf('https://www.slideshare.net/slideshow/climate-basics/12345')?.group, 'slides');
 assert.equal(viewerOf('https://docs.google.com/spreadsheets/d/1abc/edit')?.name, 'Google Sheets');
 assert.equal(viewerOf('https://books.google.com/books?id=AbC123&printsec=frontcover')?.name, 'Google Books');
 assert.equal(viewerOf('https://books.google.com/books/about'), null, 'Google Books needs a volume id');
 assert.equal(viewerOf('https://archive.org/details/economicreview2018')?.group, 'ebook');
 assert.equal(viewerOf('https://www.researchgate.net/publication/123456_Title')?.name, 'ResearchGate');
 assert.equal(viewerOf('https://example.org/document/1'), null);
});

test('safety: public blocklists in any format, parent domains, and explicit content by strong terms only', () => {
 assert.deepEqual(parseBlocklist('# URLhaus\n127.0.0.1\tmalware.example\n127.0.0.1 www.bad.example # note\n'), ['malware.example', 'bad.example']);
 assert.deepEqual(parseBlocklist('https://phish.example/login?x=1\nhttps://sub.phish2.example/\nnot a host\n'), ['phish.example', 'sub.phish2.example']);
 setBlocklist(['malware.example']);
 assert.ok(blockedHost('https://cdn.malware.example/file.pdf'), "a listed domain's subdomains are blocked too");
 assert.ok(!blockedHost('https://notmalware.example/file.pdf'));
 assert.ok(explicit('https://site.example/free-porn-videos.pdf'));
 assert.ok(explicit('https://site.example/doc.pdf', 'NSFW collection'));
 assert.ok(!explicit('https://who.int/sexual-health/sex-education-guide.pdf', 'Sex education guide'), 'health and education stay');
 assert.ok(!explicit('https://nih.gov/breast-cancer-screening.pdf'));
 assert.ok(unsafeLink('https://malware.example/a.pdf') && !unsafeLink('https://ok.example/a.pdf'));
 setBlocklist([]);
});

test('a viewer page that loads counts as a document; organisations group their domains', async () => {
 const html = async (url: string) => ({url, status: 200, contentType: 'text/html', length: null, head: Buffer.from('<!doctype html><html>')});
 assert.deepEqual(await checkDocument('https://www.scribd.com/document/1/x', 5000, html), {status: 'document', kind: 'viewer', bytes: null});
 assert.equal((await checkDocument('https://example.org/x.pdf', 5000, html)).status, 'not_document');
 assert.equal(organisation('spb.kerala.gov.in'), 'kerala.gov.in');
 assert.equal(organisation('www.lib.ox.ac.uk'), 'ox.ac.uk');
 assert.equal(organisation('reports.worldbank.org'), 'worldbank.org');
 assert.ok(sameOrganisation('spb.kerala.gov.in', 'finance.kerala.gov.in'));
 assert.ok(!sameOrganisation('kerala.gov.in', 'tamilnadu.gov.in'));
});

test('free-document sources: each API becomes documents or places to look, and one failing source does not stop the rest', async () => {
 const answers: Record<string, unknown> = {
   'export.arxiv.org': `<feed><entry><id>http://arxiv.org/abs/2012.10386v1</id><published>2020-12-02T07:46:57Z</published>
     <title>Future Climate Change
       Projections</title><summary>We project...</summary></entry></feed>`,
   'zenodo.org': {hits: {hits: [{id: 18017460, metadata: {title: 'Regional Diagnosis', publication_date: '2024-08-31'}, files: [{key: 'D1.2 Diagnosis.pdf'}]}]}},
   'doaj.org': {results: [{bibjson: {title: 'Economic impacts', year: '2017', link: [{type: 'fulltext', url: 'https://doi.org/10.1088/aa6eb2'}]}}]},
   'www.googleapis.com': {items: [{volumeInfo: {title: 'Climate Book', previewLink: 'http://books.google.com/books?id=AbC&hl=&source=gbs_api'}}]},
   'archive.org': {response: {docs: [{identifier: 'climatereport1990', title: ['Climate', 'report'], date: '1990-01-01T00:00:00Z'}]}},
   'searxng.test': {results: [{url: 'https://www.scribd.com/document/9/Climate-report', title: 'Climate report', content: 'Uploaded'}]},
 };
 const asked: string[] = [];
 const fetch = async (url: string) => {
   const host = new URL(url).hostname; asked.push(url);
   if (host === 'api.semanticscholar.org') throw new Error('429');
   if (!(host in answers)) throw new Error(`unexpected ${url}`);
   return answers[host] as any;
 };
 const out = await findDocuments({} as any, {...testConfig, SEARXNG_BASE_URL: 'http://searxng.test'}, 'climate change report',
   {json: fetch, text: async url => ({url, contentType: 'application/atom+xml', text: await fetch(url)}), budget: async () => true});
 assert.ok(out.docs.some(d => d.url === 'https://arxiv.org/pdf/2012.10386v1' && d.title === 'Future Climate Change Projections'));
 assert.ok(out.docs.some(d => d.url === 'https://zenodo.org/records/18017460/files/D1.2%20Diagnosis.pdf?download=1'), 'the file name shows its type');
 assert.ok(out.docs.some(d => d.url === 'https://books.google.com/books?id=AbC&hl=&source=gbs_api'), 'https, a viewer page');
 assert.ok(out.docs.some(d => d.url === 'https://archive.org/details/climatereport1990' && d.title === 'Climate report'));
 assert.ok(out.docs.some(d => d.engine === 'searxng' && d.url.includes('scribd.com/document')));
 assert.deepEqual(out.sites.map(s => s.url).sort(), ['https://doi.org/10.1088/aa6eb2', 'https://www.scribd.com/document/9/Climate-report'].sort());
 assert.equal(out.providers.find(p => p.provider === 'semantic_scholar')?.status, 'unavailable');
 assert.match(new URL(asked.find(u => u.includes('arxiv'))!).searchParams.get('search_query')!, /^all:climate AND all:change AND all:report$/);
 assert.equal(new URL(asked.find(u => u.includes('searxng'))!).searchParams.get('safesearch'), '2', 'strict safe search');
});

test('document search: free sources, viewer pages and strict safe search join the results; unsafe links and places to look are separated', async () => {
 setBlocklist(['malware.example']);
 try {
   const asked: string[] = [], hunts: unknown[][] = [];
   const config = {...testConfig, BRAVE_SEARCH_API_KEY: 'k', SEARXNG_BASE_URL: 'http://searxng.test', BRAVE_MIN_RESULTS: 1};
   const out = await searchWeb({} as any, config, webSearchInput.parse({q: 'climate report', kind: 'docs'}), {
     budget: async () => true, peek: async url => ({url, status: 200, contentType: 'application/pdf', length: 10, head: Buffer.from('%PDF-1.4')}),
     transport: async (url: string) => { asked.push(url); return {web: {results: [{url: 'https://malware.example/climate-report.pdf', title: 'Climate report'},
       {url: 'https://ok.example/climate-report.pdf', title: 'Climate report'}, {url: 'https://www.scribd.com/document/5/Climate', title: 'Climate'}]}}; },
     sources: async () => ({docs: [{url: 'https://arxiv.org/pdf/1', title: 'Climate paper', snippet: null, published: null, engine: 'arxiv'}],
       sites: [{url: 'https://doi.org/10.1/x', title: 'Journal landing', snippet: null, published: null, engine: 'doaj'},
         {url: 'https://malware.example/landing', title: 'Bad', snippet: null, published: null, engine: 'doaj'}],
       providers: [{provider: 'arxiv', status: 'ok', message: ''}]}),
     hunt: (_q, _docs, _explore, sites) => { hunts.push(sites.map(s => s.url)); return 'token'; }});
   assert.equal(new URL(asked[0]).searchParams.get('safesearch'), 'strict');
   assert.deepEqual(out.results.map(r => [r.url, r.doc_type, r.viewer ?? null]), [['https://ok.example/climate-report.pdf', 'pdf', null],
     ['https://www.scribd.com/document/5/Climate', 'viewer', 'Scribd'], ['https://arxiv.org/pdf/1', 'pdf', null]],
     'a user-upload viewer page is a document; the malware host is left out');
   assert.equal(out.results.find(r => r.viewer)?.preview, null, 'viewer pages open at their source, not in the preview');
   assert.ok(out.providers.some(p => p.provider === 'safety' && /1 unsafe links/.test(p.message)));
   assert.deepEqual(hunts, [['https://doi.org/10.1/x']], 'places to look go to the hunt, unsafe ones never');
 } finally { setBlocklist([]); }
});
