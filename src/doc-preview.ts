import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { fetchDocument, type BinaryResponse } from './http.js';
import { takeBudget } from './budgets.js';
import { accessKind } from './access.js';
import { documentType } from './web.js';
import { PDFDocument } from 'pdf-lib';

// Documents found by the Docs tab are previewed inside ZenAtlas: fetched from their source, checked to be what the link
// promised, converted to PDF when they are office files, cut to the first DOC_PREVIEW_PAGES pages, and cached briefly.
// The whole document is one click away at its source; only the preview is served from here. Only links this server returned (signed
// with previewToken) are fetched, so the endpoint cannot be used as an open proxy.

export interface Preview { pdf: Buffer; pages: number; shown: number }

export class PreviewError extends Error {
 constructor(public code: string, public status: number, message: string) { super(message); }
}

export function previewToken(secret: string, url: string) {
 return createHmac('sha256', secret).update(`doc-preview:${url}`).digest('base64url').slice(0, 32);
}
function validToken(secret: string, url: string, token: string) {
 const expected = Buffer.from(previewToken(secret, url)), given = Buffer.from(token);
 return expected.length === given.length && timingSafeEqual(expected, given);
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]), OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
// A document link that answers with a web page (a login wall, a download landing page) must not be passed off as the document.
export function looksLike(type: string, data: Buffer) {
 const head = data.subarray(0, 4096);
 if (type === 'pdf') return head.includes('%PDF-');
 if (['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'key'].includes(type)) return head.subarray(0, 4).equals(ZIP);
 if (['doc', 'ppt', 'xls'].includes(type)) return head.subarray(0, 8).equals(OLE);
 if (type === 'rtf') return head.subarray(0, 5).toString('latin1') === '{\\rtf';
 if (type === 'csv') return !head.includes(0) && !/^\s*<(!doctype|html)/i.test(head.toString('utf8'));
 return false;
}

const DAY_MS = 24 * 3600 * 1000;
type Deps = {
 fetch: (url: string, options: {timeoutMs: number; maxBytes: number}) => Promise<BinaryResponse>;
 convert: (input: string, ext: string) => Promise<Buffer>;
 budget: (db: DB, key: string, limit: number) => Promise<boolean>;
};

export class DocumentPreviews {
 private dir: string;
 private queue: Promise<unknown> = Promise.resolve();
 private deps: Deps;
 constructor(private db: DB, private config: Config, deps?: Partial<Deps>) {
   this.dir = config.DOC_PREVIEW_CACHE_DIR || join(tmpdir(), 'zenatlas-doc-previews');
   this.deps = {fetch: (url, o) => fetchDocument(url, o), convert: (input, ext) => this.soffice(input, ext), budget: takeBudget, ...deps};
 }

 async get(url: string, token: string): Promise<Preview> {
   if (!validToken(this.config.SESSION_SECRET, url, token) || accessKind(url) === 'unauthorized')
     throw new PreviewError('preview_forbidden', 403, 'This document cannot be previewed.');
   const type = documentType(url);
   const convertible = type && type !== 'pdf' && type !== 'epub';
   if (!type || type === 'epub' || (convertible && !this.config.DOC_PREVIEW_CONVERTER))
     throw new PreviewError('preview_unsupported', 415, 'This kind of document cannot be previewed here. Open it from its source.');

   await mkdir(this.dir, {recursive: true});
   const key = join(this.dir, createHash('sha256').update(`${this.config.DOC_PREVIEW_PAGES}:${url}`).digest('hex'));
   const age = await stat(`${key}.pdf`).then(s => Date.now() - s.mtimeMs, () => Infinity);
   if (age < DAY_MS) {
     const meta = await readFile(`${key}.json`, 'utf8').then(JSON.parse, () => null);
     if (meta) return {pdf: await readFile(`${key}.pdf`), pages: meta.pages, shown: meta.shown};
   }

   if (!await this.deps.budget(this.db, 'doc_preview', this.config.DOC_PREVIEW_DAILY_BUDGET))
     throw new PreviewError('preview_budget', 429, 'Document previews have reached today’s limit. Open it from its source.');
   let file: BinaryResponse;
   try { file = await this.deps.fetch(url, {timeoutMs: 20000, maxBytes: this.config.DOC_PREVIEW_MAX_MB * 1024 * 1024}); }
   catch { throw new PreviewError('preview_unavailable', 502, 'The source did not send the document. Open it from its source.'); }
   if (!looksLike(type, file.data)) throw new PreviewError('preview_mismatch', 502, 'The source sent a web page instead of the document. Open it from its source.');

   const preview = await this.firstPages(type === 'pdf' ? file.data : await this.converted(file.data, type));
   await writeFile(`${key}.json`, JSON.stringify({pages: preview.pages, shown: preview.shown}));
   await writeFile(`${key}.pdf`, preview.pdf);
   await this.prune();
   return preview;
 }

 private async firstPages(full: Buffer): Promise<Preview> {
   let doc: PDFDocument;
   // An encrypted PDF cannot be cut to a preview, and passing it on whole would serve the entire document from here.
   try { doc = await PDFDocument.load(full, {updateMetadata: false}); }
   catch { throw new PreviewError('preview_unavailable', 502, 'This document is protected and cannot be previewed here. Open it from its source.'); }
   const pages = doc.getPageCount(), limit = this.config.DOC_PREVIEW_PAGES;
   if (!limit || pages <= limit) return {pdf: full, pages, shown: pages};
   const preview = await PDFDocument.create();
   for (const page of await preview.copyPages(doc, [...Array(limit).keys()])) preview.addPage(page);
   return {pdf: Buffer.from(await preview.save()), pages, shown: limit};
 }

 // One conversion at a time: LibreOffice takes a few hundred MB while it runs, which a small VPS has room for only once.
 private converted(data: Buffer, ext: string): Promise<Buffer> {
   const run = this.queue.then(async () => {
     const work = await mkdtemp(join(tmpdir(), 'zenatlas-convert-'));
     try {
       const input = join(work, `document.${ext}`);
       await writeFile(input, data);
       const pdf = await this.deps.convert(input, ext);
       if (!pdf.subarray(0, 1024).includes('%PDF-')) throw new Error('no pdf');
       return pdf;
     } catch { throw new PreviewError('preview_unavailable', 502, 'This document could not be converted for preview. Open it from its source.'); }
     finally { await rm(work, {recursive: true, force: true}); }
   });
   this.queue = run.catch(() => {});
   return run;
 }

 private soffice(input: string, _ext: string): Promise<Buffer> {
   const out = join(input, '..', 'out');
   const profile = pathToFileURL(join(this.dir, 'libreoffice-profile')).href;
   return new Promise((resolve, reject) => {
     execFile(this.config.DOC_PREVIEW_CONVERTER, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
       `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', out, input],
     {timeout: 90000, windowsHide: true}, error => error ? reject(error) : readFile(join(out, 'document.pdf')).then(resolve, reject));
   });
 }

 // Oldest previews go first once the cache passes its size limit.
 private async prune() {
   const files = await Promise.all((await readdir(this.dir)).filter(f => f.endsWith('.pdf') || f.endsWith('.json'))
     .map(async f => ({path: join(this.dir, f), ...(await stat(join(this.dir, f)).then(s => ({size: s.size, time: s.mtimeMs})))})));
   let total = files.reduce((sum, f) => sum + f.size, 0);
   for (const f of files.sort((a, b) => a.time - b.time)) {
     if (total <= this.config.DOC_PREVIEW_CACHE_MB * 1024 * 1024) break;
     await unlink(f.path).catch(() => {}); total -= f.size;
   }
 }
}
