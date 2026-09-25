import {test} from 'node:test';
import assert from 'node:assert/strict';
import { database, testConfig } from './helpers.js';
import { spamLink, sniff, checkDocument, verifyDocuments, reviewDocuments, saveReview, takeReview, type VerifiedDoc } from '../src/doc-review.js';
import { UpstreamError, type PeekResponse } from '../src/http.js';
import type { Judge, JudgeCandidate, JudgeContext } from '../src/judge.js';
import type { WebResult } from '../src/web.js';

const doc = (url: string, title: string, extra: Partial<WebResult> = {}): WebResult => ({id: url, title, url, source_name: new URL(url).hostname.replace(/^www\./, ''),
 snippet: null, published: null, doc_type: 'pdf', access: null, engine: 'brave', preview: null, ...extra});
const pdf = (length = 2048): PeekResponse => ({url: 'x', status: 200, contentType: 'application/pdf', length, head: Buffer.from('%PDF-1.7\n%âãÏÓ')});

test('spam links: script paths posing as files, fulldisplay pages and titles that begin with their own host', () => {
 assert.ok(spamLink(doc('https://www.wiki.conexionmigrante.com/public/Resources/default.aspx/Manorama%20Yearbook%20Filename.pdf', 'Manorama Yearbook Filename')));
 assert.ok(spamLink(doc('https://blog.tyfoster.com/fetch.php/Resources/423313/Manorama_Year_Book_2014.pdf', 'Manorama Year Book 2014 Full PDF')));
 assert.ok(spamLink(doc('https://ftp.simlab-soft.com/fulldisplay/9936434/Manorama-Year%20Book%20-%202014.pdf', 'Manorama Year Book 2014')));
 assert.ok(spamLink(doc('https://www.staff.ces.funai.edu.ng/form-library/_pdfs/Manorama_Yearbook_2014.pdf', 'www.staff.ces.funai.edu.ng - Manorama Yearbook 2014 Free In English')));
 assert.ok(!spamLink(doc('https://archive.org/download/in.ernet.dli.2015.114869/Manorama-Year-Book.pdf', 'manorama yearbook 2002')));
 assert.ok(!spamLink(doc('https://www.tcs.com/content/dam/global-tcs/en/pdfs/inquizitive/2018/kochi/Malayala-Manorama2.pdf', 'Published Date: 18 Oct 2018 Publication: Malayala Manorama')));
 assert.ok(!spamLink(doc('https://www.ipcc.ch/site/assets/uploads/2018/02/SYR_AR5_FINAL_full.pdf', 'IPCC - AR5 Synthesis Report')));
});

test('a file is judged by its own signature, not its name', () => {
 assert.equal(sniff(Buffer.from('%PDF-1.4'), 'application/pdf'), 'pdf');
 assert.equal(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'application/octet-stream'), 'zip');
 assert.equal(sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]), 'application/msword'), 'ole');
 assert.equal(sniff(Buffer.from('{\\rtf1\\ansi'), 'application/rtf'), 'rtf');
 assert.equal(sniff(Buffer.from('﻿  <!DOCTYPE html><html><head>'), 'text/html'), 'html');
 assert.equal(sniff(Buffer.from('<html lang="en">'), 'application/pdf'), 'html', 'a page claiming to be a PDF is still a page');
 assert.equal(sniff(Buffer.from('year,value\n2018,4'), 'text/csv'), 'text');
 assert.equal(sniff(Buffer.from([0x1f, 0x8b, 8, 0]), 'application/pdf'), 'unknown');
});

test('checks: dead links and pages posing as documents are removed; sites that refuse checks are kept as unverified', async () => {
 const fail = (code: string, status?: number) => async () => { throw new UpstreamError(code, status); };
 assert.deepEqual(await checkDocument('https://a.example/x.pdf', 5000, async () => pdf(33_000_000)), {status: 'document', kind: 'pdf', bytes: 33_000_000});
 assert.equal((await checkDocument('https://a.example/x.pdf', 5000, async () => ({...pdf(), head: Buffer.from('<!doctype html>')}))).status, 'not_document');
 for (const [code, status] of [['network_error'], ['timeout'], ['upstream_failure', 404], ['upstream_failure', 500], ['unsafe_destination']] as const)
   assert.equal((await checkDocument('https://a.example/x.pdf', 5000, fail(code, status))).status, 'dead', `${code} ${status ?? ''}`);
 for (const status of [401, 403, 429]) assert.equal((await checkDocument('https://a.example/x.pdf', 5000, fail('upstream_failure', status))).status, 'blocked');
});

test('verification keeps real documents in order and reports what it removed', async () => {
 const docs = [doc('https://real.example/a.pdf', 'Annual report 2018'), doc('https://gone.example/b.pdf', 'Annual report 2018 copy'),
   doc('https://spam.example/default.aspx/report.pdf', 'Annual report free'), doc('https://fake.example/c.pdf', 'Annual report scan'),
   doc('https://shy.example/d.pdf', 'Annual report mirror')];
 const peek = async (url: string): Promise<PeekResponse> => {
   if (url.includes('gone')) throw new UpstreamError('network_error');
   if (url.includes('shy')) throw new UpstreamError('upstream_failure', 403);
   if (url.includes('fake')) return {...pdf(), contentType: 'text/html', head: Buffer.from('<html><body>Download now')};
   return pdf();
 };
 const out = await verifyDocuments(docs, testConfig, peek);
 assert.deepEqual(out.results.map(r => [r.url, r.check]), [['https://real.example/a.pdf', 'checked'], ['https://shy.example/d.pdf', 'blocked']]);
 assert.deepEqual(out.removed, {spam: 1, dead: 1, not_document: 1});
});

class FakeJudge implements Judge {
 calls: {candidates: JudgeCandidate[]; context?: JudgeContext}[] = [];
 constructor(private scores: Record<string, number>) {}
 async judge(_query: string, candidates: JudgeCandidate[], context?: JudgeContext) {
   this.calls.push({candidates, context});
   return {model: 'fake', verdicts: new Map(candidates.map(c => [c.key, {key: c.key, relevance: this.scores[c.title] ?? 0, reason: `scored ${c.title}`, momentKeys: []}]))};
 }
}

test('review: inspected text reaches the judge, weak or wrong documents are removed and the rest ordered by relevance', async () => {
 const db = await database();
 try {
   const docs: VerifiedDoc[] = [
     {...doc('https://a.example/2014.pdf', 'Manorama Year Book 2014'), check: 'checked', bytes: 1000},
     {...doc('https://a.example/2018.pdf', 'Manorama Year Book 2018'), check: 'checked', bytes: 1000},
     {...doc('https://a.example/big.pdf', 'Manorama 2018 scan'), check: 'checked', bytes: 90_000_000},
     {...doc('https://b.example/blocked.pdf', 'Malayala Manorama 2018 page'), check: 'blocked', bytes: null},
   ];
   const judge = new FakeJudge({'Manorama Year Book 2014': 3, 'Manorama Year Book 2018': 9, 'Manorama 2018 scan': 7, 'Malayala Manorama 2018 page': 6});
   const inspected: string[] = [];
   const pages = {check: async (url: string) => { inspected.push(url); return {status: 'checked' as const, title: 'Manorama Year Book 2018',
     description: null, text: 'Manorama Year Book 2018 — the complete reference', libraries: [], badges: [], meta: {content_type: 'application/pdf'}}; }};
   const out = await reviewDocuments(db, testConfig, 'manorama 2018', docs, {judge, pages, screener: undefined});
   assert.deepEqual(out.results.map(r => r.title), ['Manorama Year Book 2018', 'Manorama 2018 scan', 'Malayala Manorama 2018 page']);
   assert.deepEqual(out.results.map(r => r.judgement?.relevance), [9, 7, 6]);
   assert.equal(out.removed, 1);
   assert.deepEqual(inspected.sort(), ['https://a.example/2014.pdf', 'https://a.example/2018.pdf'], 'only checked PDFs within the size limit are read');
   const sent = judge.calls[0];
   assert.equal(sent.candidates.find(c => c.url === 'https://a.example/2018.pdf')?.page?.text, 'Manorama Year Book 2018 — the complete reference');
   assert.equal(sent.candidates.find(c => c.url === 'https://a.example/big.pdf')?.page, undefined, 'too large to read: judged on its metadata');
   assert.match(sent.context!.requirements![0].text, /manorama 2018/);
 } finally { await db.close(); }
});

test('review without a judge keeps the verified order and says so; tokens are single-use and expire', async () => {
 const db = await database();
 try {
   const docs: VerifiedDoc[] = [{...doc('https://a.example/x.pdf', 'X'), check: 'checked', bytes: 10}];
   const out = await reviewDocuments(db, testConfig, 'x', docs, {judge: undefined, pages: {check: async () => { throw new Error('no'); }}, screener: undefined});
   assert.deepEqual(out.results.map(r => r.url), ['https://a.example/x.pdf']);
   assert.equal(out.providers[0].status, 'disabled');

   const token = saveReview({query: 'x', docs});
   assert.equal(takeReview(token)?.query, 'x');
   assert.equal(takeReview(token), null, 'single use');
   assert.equal(takeReview('not-a-token'), null);
 } finally { await db.close(); }
});

test('more than 20 documents: the screener picks which ones are judged; the rest follow unjudged', async () => {
 const db = await database();
 try {
   const docs: VerifiedDoc[] = Array.from({length: 24}, (_, i) => ({...doc(`https://a.example/${i}.pdf`, `Doc ${i}`), check: 'checked' as const, bytes: null}));
   const screener = {screen: async () => ({screened: 24, promising: new Set(['https://a.example/22.pdf', 'https://a.example/23.pdf'])})};
   const judge = new FakeJudge(Object.fromEntries(docs.map(d => [d.title, 8])));
   const out = await reviewDocuments(db, testConfig, 'docs', docs, {judge, screener, pages: {check: async () => { throw new Error('offline'); }}});
   const judged = judge.calls[0].candidates.map(c => c.title);
   assert.equal(judged.length, 20);
   assert.ok(judged.includes('Doc 22') && judged.includes('Doc 23'), 'promising documents are judged even from the end of the list');
   assert.equal(out.results.length, 24);
   assert.deepEqual(out.results.slice(20).map(r => r.judgement), [undefined, undefined, undefined, undefined]);
 } finally { await db.close(); }
});
