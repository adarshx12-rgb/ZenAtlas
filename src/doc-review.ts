import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { contentInput, type ProviderStatus } from './types.js';
import { peekDocument, UpstreamError, type PeekResponse } from './http.js';
import { PageChecker, type PageCheck, type PageEvidence } from './pages.js';
import { makeJudge, type Judge, type JudgeCandidate, type Verdict } from './judge.js';
import { makeJevJudge } from './jev-judge.js';
import { makeScreener, screeningOrder, type Screener } from './screener.js';
import { accessKind } from './access.js';
import type { WebResult } from './web.js';

// The Docs tab in two stages. Verification (inside the search request) removes spam links, dead links and pages
// posing as documents, reading only the first 4 KB of each file. Review (a follow-up request) reads the text of real
// PDFs, then the Jev pre-judge and the LLM judge remove documents that are not what was asked for and order the rest.

export type DocCheck = {status: 'document'; kind: string; bytes: number|null} | {status: 'blocked'|'dead'|'not_document'};
// check: 'checked' when the file was confirmed to be a document; 'blocked' when the site refused the check.
export type VerifiedDoc = WebResult & {check: 'checked'|'blocked'; bytes: number|null};
type Peek = (url: string, options: {timeoutMs: number}) => Promise<PeekResponse>;

// Search engines index generated spam that poses as free copies of documents: a script path followed by a made-up file
// name (default.aspx/Title.pdf), "fulldisplay" listings, and titles that start with the spam site's own host name.
const SCRIPT_PATH_FILE = /\.(?:aspx?|php|jsp|cgi)\/[^?#]*\.(?:pdf|docx?|pptx?|xlsx?|odt|epub|rtf)$/i;
export function spamLink(result: Pick<WebResult, 'url'|'title'>): boolean {
 const url = new URL(result.url), host = url.hostname.toLowerCase().replace(/^www\./, '');
 const title = result.title.trim().toLowerCase().replace(/^www\./, '');
 return SCRIPT_PATH_FILE.test(decodeURIComponent(url.pathname)) || /\/fulldisplay\//i.test(url.pathname) || title.startsWith(`${host} - `);
}

// What the first bytes say the file is, whatever its name or declared type.
export function sniff(head: Buffer, contentType: string): 'pdf'|'zip'|'ole'|'rtf'|'html'|'text'|'unknown' {
 if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
 if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
 if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return 'ole';
 const start = head.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
 if (start.startsWith('{\\rtf')) return 'rtf';
 if (/^<(?:!doctype html|html|head|body|script|meta)\b/.test(start) || /<html[\s>]/.test(start)) return 'html';
 if ((contentType === 'text/csv' || contentType === 'text/plain') && !/[\u0000-\u0008]/.test(start)) return 'text';
 return 'unknown';
}

// Dead, unreachable and unsafe addresses are removed; a site that refuses automated requests (401, 403, 429) may still
// open in a browser, so its document is kept, marked unverified.
export async function checkDocument(url: string, timeoutMs: number, peek: Peek = peekDocument): Promise<DocCheck> {
 try {
   const file = await peek(url, {timeoutMs});
   const kind = sniff(file.head, file.contentType);
   return kind === 'html' || kind === 'unknown' ? {status: 'not_document'} : {status: 'document', kind, bytes: file.length};
 } catch (error) {
   const status = error instanceof UpstreamError ? error.status : undefined;
   return status === 401 || status === 403 || status === 429 ? {status: 'blocked'} : {status: 'dead'};
 }
}

export async function verifyDocuments(results: WebResult[], config: Config, peek: Peek = peekDocument) {
 const removed = {spam: 0, dead: 0, not_document: 0};
 const candidates = results.filter(r => !spamLink(r) || (removed.spam++, false));
 const checks = await Promise.all(candidates.map(r => checkDocument(r.url, config.PAGE_TIMEOUT_MS, peek)));
 const kept: VerifiedDoc[] = [];
 checks.forEach((c, i) => {
   if (c.status === 'document') kept.push({...candidates[i], check: 'checked', bytes: c.bytes});
   else if (c.status === 'blocked') kept.push({...candidates[i], check: 'blocked', bytes: null});
   else removed[c.status]++;
 });
 return {results: kept, removed};
}

// Verified documents wait here, by a random token, for their review request; single use, gone after ten minutes.
const reviews = new Map<string, {expires: number; query: string; docs: VerifiedDoc[]}>();
const REVIEW_MS = 10 * 60_000, MAX_REVIEWS = 500;
export function saveReview(entry: {query: string; docs: VerifiedDoc[]}): string {
 const now = Date.now();
 for (const [token, r] of reviews) if (r.expires < now || reviews.size >= MAX_REVIEWS) reviews.delete(token);
 const token = randomUUID();
 reviews.set(token, {...entry, expires: now + REVIEW_MS});
 return token;
}
export function takeReview(token: string): {query: string; docs: VerifiedDoc[]}|null {
 const entry = reviews.get(token);
 reviews.delete(token);
 return entry && entry.expires >= Date.now() ? entry : null;
}

export type ReviewedDoc = VerifiedDoc & {judgement?: {relevance: number; reason: string}};
// Documents are judged in one pool this size; the screener orders a longer list first, and the rest stay unjudged.
export const REVIEW_POOL = 20;
// Documents at or below this relevance are removed (4 is "only tangential"). Unlike video results, a plausible 5 stays:
// short document queries are often ambiguous, and an unconfirmed detail is not a miss.
const TANGENTIAL = 4;
type ReviewDeps = {judge?: Judge; pages?: PageCheck; screener?: Screener};

export async function reviewDocuments(db: DB, config: Config, query: string, docs: VerifiedDoc[], deps: ReviewDeps = {}) {
 const providers: ProviderStatus[] = [];
 // The pre-judge may remove documents here (not only record would-be rejections): a wrong edition or year is a miss.
 const judge = 'judge' in deps ? deps.judge : makeJevJudge(db, {...config, JEV_JUDGE_REJECT: true}, makeJudge(db, config));
 if (!judge || !docs.length) {
   if (docs.length) providers.push({provider: 'judge', status: 'disabled', message: 'Documents were checked to exist but not for relevance.'});
   return {results: docs as ReviewedDoc[], removed: 0, providers};
 }
 let pool = docs;
 const screener = 'screener' in deps ? deps.screener : makeScreener(db, config);
 if (screener && docs.length > REVIEW_POOL) {
   try {
     const leads = docs.map((d, i) => ({item: contentInput.parse({url: d.url, title: d.title, description: d.snippet, published_at: d.published}),
       provider: d.engine, position: i, doc: d}));
     pool = screeningOrder(leads, (await screener.screen(query, leads)).promising).map(l => l.doc);
   } catch { providers.push({provider: 'jev_screener', status: 'unavailable', message: 'Documents were reviewed in search order.'}); }
 }
 const judged = pool.slice(0, REVIEW_POOL), rest = pool.slice(REVIEW_POOL);

 // Text of real PDFs small enough to read; larger ones and other formats are judged on their title and snippet.
 const pages = deps.pages ?? new PageChecker(config);
 const text = new Map<string, PageEvidence>();
 await mapLimit(judged.filter(d => d.check === 'checked' && d.doc_type === 'pdf' && (d.bytes === null || d.bytes <= config.PDF_MAX_BYTES)), 6, async d => {
   const page = await pages.check(d.url).catch(() => null);
   if (page?.status === 'checked') text.set(d.url, page);
 });
 const keys = new Map(judged.map((d, i) => [`d${i + 1}`, d]));
 const candidates: JudgeCandidate[] = [...keys].map(([key, d]) => {
   const page = text.get(d.url);
   return {key, kind: 'website', site: d.source_name, url: d.url, title: d.title, channel: null, official: false, duration: null, live: null,
     description: d.snippet, comments: [], moments: [], discussions: [], description_source: 'search',
     inspected: {format: d.doc_type, published: page?.meta?.published ?? d.published?.slice(0, 10) ?? null, publisher: null, access: accessKind(d.url)},
     ...(page ? {page: {status: page.status, title: page.title, description: page.description, text: page.text, libraries: []}} : {})};
 });
 const context = {kind: 'websites' as const, criteria: ['A document file that is itself what the request asks for',
   'When the request is ambiguous (a name and a year can mean a book, an issue or a newspaper), a document that genuinely fits any reasonable reading matches; a different edition or year does not'],
   requirements: [{id: 'R1', text: `The document itself is what the request asks for: "${query.slice(0, 150)}" (its subject, edition, year and language as stated)`,
     evidence: 'The document text or title shows its subject, edition or year.'}]};
 let verdicts: Map<string, Verdict>;
 try { verdicts = (await judge.judge(query, candidates, context)).verdicts; }
 catch {
   providers.push({provider: 'judge', status: 'unavailable', message: 'Relevance checking is unavailable right now; documents are shown in search order.'});
   return {results: docs as ReviewedDoc[], removed: 0, providers};
 }
 const scored = [...keys].map(([key, d], i) => ({d, i, v: verdicts.get(key)}));
 const kept = scored.filter(s => s.v && s.v.relevance > TANGENTIAL && !s.v.intentChecks?.some(c => c.status === 'mismatch'))
   .sort((a, b) => b.v!.relevance - a.v!.relevance || a.i - b.i);
 const removed = judged.length - kept.length;
 providers.push({provider: 'judge', status: 'ok', message: `${judged.length} documents were checked for relevance; ${removed} did not match.`});
 return {results: [...kept.map(s => ({...s.d, judgement: {relevance: s.v!.relevance, reason: s.v!.reason}})), ...rest] as ReviewedDoc[], removed, providers};
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
 let next = 0;
 await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (next < items.length) await fn(items[next++]); }));
}
