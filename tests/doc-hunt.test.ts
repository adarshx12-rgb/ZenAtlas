import {test} from 'node:test';
import assert from 'node:assert/strict';
import { database, testConfig } from './helpers.js';
import { runHunt, startHunt, huntState, huntSnapshot, type DocHunter, type HuntLink, type HuntState } from '../src/doc-hunt.js';
import type { VerifiedDoc } from '../src/doc-review.js';
import type { PageEvidence } from '../src/pages.js';
import type { Judge, JudgeCandidate } from '../src/judge.js';
import type { WebResult } from '../src/web.js';

const config = {...testConfig, DOC_HUNT_ENABLED: true, DOC_HUNT_SITES: 4, DOC_HUNT_VISITS: 10, DOC_HUNT_ROUNDS: 3, DOC_HUNT_MAX_DOCS: 8};
const site = (url: string, title: string): WebResult => ({id: url, url, title, source_name: new URL(url).hostname, snippet: null, published: null,
 doc_type: null, access: null, engine: 'brave', preview: null});
const page = (title: string, links: {url: string; title: string}[], text = `${title} page`): PageEvidence =>
 ({status: 'checked', title, description: null, text, libraries: [], badges: [], links});
const pdf = async (url: string) => ({url, status: 200, contentType: 'application/pdf', length: 5000, head: Buffer.from('%PDF-1.7')});

// Jev stand-in, deliberately loose like a fast first pass: any dated file is a document (the review then removes the wrong
// year), publications or archive pages are leads, anything else is irrelevant.
class FakeHunter implements DocHunter {
 asked: HuntLink[][] = [];
 async classify(_q: string, links: HuntLink[]) {
   this.asked.push(links);
   return links.map(l => ({url: l.url, confidence: 0.9, choice: (/20\d\d/.test(l.title) && l.file_type ? 'document'
     : /publications|reports|archive/i.test(l.title) ? 'leads' : 'irrelevant') as 'document'|'leads'|'irrelevant'}));
 }
}
// Judge stand-in for the site verdicts: a page mentioning "annual figures" has the information.
const judge: Judge = {judge: async (_q, candidates: JudgeCandidate[]) => ({model: 'fake', verdicts: new Map(candidates.map(c =>
 [c.key, {key: c.key, relevance: /annual figures/.test(c.page?.text ?? '') ? 8 : 2, reason: 'fake', momentKeys: []}]))})};
// Review stand-in: keeps documents whose title says 2018.
const review = async (_q: string, docs: VerifiedDoc[]) => {
 const results = docs.filter(d => /2018/.test(d.title)).map(d => ({...d, judgement: {relevance: 9, reason: 'fake'}}));
 return {results, removed: docs.length - results.length, providers: []};
};
const fresh = (query: string, docs: VerifiedDoc[] = []): HuntState =>
 ({status: 'running', query, sites: [], docs: docs.map(d => ({...d, site: new URL(d.url).hostname, found_via: [], state: 'pending' as const})),
   checked_pages: 0, removed: 0, providers: []});

test('Jev follows leads inside each website to the requested document and records how it got there', async () => {
 const pages: Record<string, PageEvidence> = {
   'https://ministry.example/': page('Ministry home', [{url: 'https://ministry.example/publications', title: 'Publications'},
     {url: 'https://ministry.example/contact-us', title: 'Contact us'}, {url: 'https://elsewhere.example/news', title: 'Related news'}]),
   'https://ministry.example/publications': page('Publications', [{url: 'https://ministry.example/files/annual-report-2018.pdf', title: 'Annual report 2018'},
     {url: 'https://ministry.example/files/annual-report-2014.pdf', title: 'Annual report 2014'},
     {url: 'https://cdn.example/uploads/statistics-2018.xlsx', title: 'Statistics 2018 (XLSX)'},
     {url: 'https://libgen.is/book/annual-report-2018.pdf', title: 'Annual report 2018 free'}]),
   'https://news.example/story': page('A story', [], 'The annual figures for 2018 are listed here in full.'),
   'https://empty.example/': page('Nothing here', []),
 };
 const visited: string[] = [];
 const hunter = new FakeHunter();
 const state = fresh('annual report 2018');
 await runHunt(await database(), config, state, true, {
   sites: async () => [site('https://ministry.example/', 'Ministry'), site('https://news.example/story', 'Story'), site('https://empty.example/', 'Empty'),
     site('https://www.amazon.com/dp/123', 'Annual report 2018 (print)'), site('https://libgen.is/x', 'Pirated')],
   pages: {check: async url => { visited.push(url); return pages[url] ?? {status: 'unavailable', title: null, description: null, text: null, libraries: [], badges: []}; }},
   hunter, peek: pdf, judge, review});

 const kept = state.docs.filter(d => d.state === 'kept');
 assert.deepEqual(kept.map(d => [d.url, d.doc_type]).sort(), [['https://cdn.example/uploads/statistics-2018.xlsx', 'xlsx'],
   ['https://ministry.example/files/annual-report-2018.pdf', 'pdf']], 'a document may live on another host; a pirate copy is never followed');
 assert.deepEqual(kept.find(d => d.doc_type === 'pdf')!.found_via.map(v => v.title), ['Ministry home', 'Publications']);
 assert.ok(!visited.includes('https://elsewhere.example/news'), 'leads stay on their own site');
 assert.ok(!visited.includes('https://ministry.example/contact-us'), 'irrelevant links are not followed');
 assert.ok(hunter.asked.flat().every(l => !l.url.includes('libgen')), 'unauthorized hosts are never even offered to Jev');
 assert.deepEqual(state.sites.map(s => [s.host, s.verdict, s.note]), [['ministry.example', 'document', null], ['news.example', 'web_only', null],
   ['empty.example', 'not_found', null], ['amazon.com', 'access', 'Buy']]);
 assert.ok(!state.sites.some(s => s.host === 'libgen.is'));
 assert.equal(state.removed, 1, 'the 2014 report was found but removed by the review');
 assert.match(state.providers.find(p => p.provider === 'doc_hunt')!.message, /4 websites searched, \d+ pages checked, 3 documents found inside them/);
});

test('the hunt stops at its page limit and reviews what the search itself found when Jev is unavailable', async () => {
 const deep = (n: number): PageEvidence => page(`Level ${n}`, [{url: `https://deep.example/reports/${n + 1}`, title: `Reports ${n + 1}`}]);
 const visited: string[] = [];
 const state = fresh('annual report 2018');
 await runHunt(await database(), {...config, DOC_HUNT_VISITS: 3, DOC_HUNT_ROUNDS: 5}, state, true, {
   sites: async () => [site('https://deep.example/reports/0', 'Deep')], hunter: new FakeHunter(), peek: pdf, judge, review,
   pages: {check: async url => { visited.push(url); return deep(Number(url.split('/').pop())); }}});
 assert.equal(visited.length, 3);

 const found: VerifiedDoc = {...site('https://a.example/report-2018.pdf', 'Report 2018'), doc_type: 'pdf', check: 'checked', bytes: 10};
 const down = fresh('annual report 2018', [found]);
 const failing: DocHunter = {classify: async () => { throw new Error('offline'); }};
 await runHunt(await database(), config, down, true, {sites: async () => [site('https://ministry.example/', 'Ministry')], hunter: failing, peek: pdf,
   judge, review, pages: {check: async () => page('Ministry', [{url: 'https://ministry.example/publications', title: 'Publications'}])}});
 assert.equal(down.providers.find(p => p.provider === 'jev_doc_hunt')?.status, 'unavailable');
 assert.deepEqual(down.docs.map(d => d.state), ['kept'], "the search's own documents are still reviewed");
});

test('later pages only review their documents; a hunt is polled by token until complete', async () => {
 const db = await database();
 try {
   const found: VerifiedDoc[] = [{...site('https://a.example/report-2018.pdf', 'Report 2018'), doc_type: 'pdf', check: 'checked', bytes: 10},
     {...site('https://a.example/report-2014.pdf', 'Report 2014'), doc_type: 'pdf', check: 'checked', bytes: 10}];
   let asked = false;
   const token = startHunt(db, config, 'report 2018', found, false, {sites: async () => { asked = true; return []; }, review, judge});
   const state = huntState(token)!;
   for (let i = 0; i < 50 && state.status !== 'complete'; i++) await new Promise(r => setTimeout(r, 20));
   assert.equal(state.status, 'complete');
   assert.equal(asked, false, 'no websites are explored');
   const snapshot = huntSnapshot(state);
   assert.deepEqual(snapshot.documents.map(d => d.title), ['Report 2018'], 'removed documents leave the snapshot');
   assert.equal('bytes' in snapshot.documents[0], false);
   assert.equal(huntState('00000000-0000-4000-8000-000000000000'), null);
 } finally { await db.close(); }
});

test("Jev reads each website's first page for its verdict; the judge decides only the pages Jev is unsure about", async () => {
 const pages: Record<string, PageEvidence> = {
   'https://campuslib.example/record/1': page('Details for Year Book 2018 › University Library', []),
   'https://books.example/year-book-2018': page('Year Book 2018 – buy now', []),
   'https://blog.example/post': page('Year Book 2018 review', [], 'The annual figures for 2018 are listed here in full.'),
 };
 const hunter = Object.assign(new FakeHunter(), {assessSites: async (_q: string, sitePages: {url: string}[]) => sitePages.map(p =>
   p.url.includes('campuslib') ? {url: p.url, choice: 'borrow' as const, confidence: 0.9}
   : p.url.includes('books') ? {url: p.url, choice: 'buy' as const, confidence: 0.85}
   : {url: p.url, choice: 'nothing' as const, confidence: 0.4})});
 const judged: string[] = [];
 const spy: Judge = {judge: async (q, candidates, context) => { judged.push(...candidates.map(c => c.site)); return judge.judge(q, candidates, context); }};
 const state = fresh('year book 2018');
 await runHunt(await database(), config, state, true, {hunter, peek: pdf, judge: spy, review,
   sites: async () => Object.keys(pages).map(url => site(url, pages[url].title!)),
   pages: {check: async url => pages[url]}});
 assert.deepEqual(state.sites.map(s => [s.host, s.verdict, s.note]), [['campuslib.example', 'access', 'Borrow'], ['books.example', 'access', 'Buy'],
   ['blog.example', 'web_only', null]]);
 assert.deepEqual(judged, ['blog.example'], 'only the unsure page goes to the judge');
});

test('links are read from script menus, drop-downs and embedded viewers, never from in-page or script targets', async () => {
 const { pageReferences } = await import('../src/pages.js');
 const refs = pageReferences(`<ul><li data-target="11.php?pid=11">Recent Trends in the Economy</li><li data-target="#modal1">Open menu</li>
   <li data-href="javascript:void(0)">Click here now</li></ul><select><option value="">Choose a year</option><option value="/files/report-2018.pdf">2018</option></select>
   <iframe src="/viewer/annual-2018.pdf"></iframe><a href="/about">About the board</a>`, 'https://board.example/er/index.php', 20);
 assert.deepEqual(refs, [{url: 'https://board.example/er/11.php?pid=11', title: 'Recent Trends in the Economy'},
   {url: 'https://board.example/files/report-2018.pdf', title: '2018'}, {url: 'https://board.example/viewer/annual-2018.pdf', title: 'annual-2018.pdf'},
   {url: 'https://board.example/about', title: 'About the board'}]);
});

test('leads may cross to the same organisation or a repository; viewer pages and unsafe links are handled while hunting', async () => {
 const { setBlocklist } = await import('../src/safety.js');
 setBlocklist(['malware.example']);
 try {
   const pages: Record<string, PageEvidence> = {
     'https://spb.state.gov.in/': page('Planning Board', [{url: 'https://finance.state.gov.in/publications', title: 'Publications'},
       {url: 'https://dspace.stateuni.ac.in/handle/123/456', title: 'Reports archive'}, {url: 'https://othersite.example/archive', title: 'Archive of others'},
       {url: 'https://www.scribd.com/document/77/Report-2018', title: 'Report 2018 (Scribd)'}, {url: 'https://malware.example/report-2018.pdf', title: 'Report 2018 fast download'}]),
     'https://finance.state.gov.in/publications': page('Finance publications', []),
     'https://dspace.stateuni.ac.in/handle/123/456': page('Reports archive', []),
   };
   const visited: string[] = [];
   const hunter = new FakeHunter();
   const state = fresh('report 2018');
   const html = async (url: string) => ({url, status: 200, contentType: 'text/html', length: null, head: Buffer.from('<!doctype html>')});
   await runHunt(await database(), config, state, true, {hunter, judge, review, peek: async url => url.includes('scribd') ? html(url) : pdf(url),
     sites: async () => [site('https://spb.state.gov.in/', 'Planning Board')],
     pages: {check: async url => { visited.push(url); return pages[url] ?? page('Empty', []); }}});
   assert.ok(visited.includes('https://finance.state.gov.in/publications'), 'same organisation');
   assert.ok(visited.includes('https://dspace.stateuni.ac.in/handle/123/456'), 'a repository');
   assert.ok(!visited.includes('https://othersite.example/archive'), 'another organisation is not followed');
   assert.ok(hunter.asked.flat().every(l => !l.url.includes('malware')), 'unsafe links are never offered to Jev');
   const scribd = state.docs.find(d => d.url.includes('scribd'));
   assert.deepEqual([scribd?.doc_type, scribd?.viewer, scribd?.preview], ['viewer', 'Scribd', null]);
 } finally { setBlocklist([]); }
});
