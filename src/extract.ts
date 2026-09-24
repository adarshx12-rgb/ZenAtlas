import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { PdfEvidence } from './pages.js';

export interface TextExtractor { text(html: string): Promise<string|null>; pdf?(data: Buffer): Promise<PdfEvidence|null>; close(): void }

const TIMEOUT_MS = 15_000, RETRY_MS = 60_000;

// One long-lived Python process runs trafilatura (scene-worker/src/zenatlas_scenes/pagetext.py). It never fetches:
// Node sends HTML it already fetched through its own public-address checks. Any failure answers null, so callers fall back.
export class Trafilatura implements TextExtractor {
 private child?: ChildProcessWithoutNullStreams;
 private pending = new Map<number, (answer: any) => void>();
 private next = 0;
 private retryAt = 0;
 constructor(private command: string, private args = ['-m', 'zenatlas_scenes.pagetext']) {}
 private start() {
   if (this.child || Date.now() < this.retryAt) return this.child;
   let answered = false;
   const child = spawn(this.command, this.args, {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
   const stop = () => {
     if (this.child !== child) return;
     this.child = undefined;
     // A helper that never answered (missing interpreter or package) is not restarted for every page.
     if (!answered) this.retryAt = Date.now() + RETRY_MS;
     for (const done of [...this.pending.values()]) done(null);
   };
   child.on('error', stop).on('exit', stop);
   child.stdin.on('error', stop);
   child.stderr.resume();
   createInterface({input: child.stdout}).on('line', line => {
     try {
       const answer = JSON.parse(line);
       answered = true;
       this.pending.get(answer.id)?.(answer);
     } catch { /* Ignore anything that is not an answer. */ }
   });
   for (const stream of [child, child.stdin, child.stdout, child.stderr] as {unref?: () => void}[]) stream.unref?.();
   return this.child = child;
 }
 async text(html: string): Promise<string|null> {
   const answer = await this.ask({html});
   return typeof answer?.text === 'string' && answer.text ? answer.text : null;
 }
 // Page count, document metadata and the first pages' text of a PDF Node already fetched.
 async pdf(data: Buffer): Promise<PdfEvidence|null> {
   const pdf = (await this.ask({pdf: data.toString('base64')}))?.pdf;
   if (!pdf || typeof pdf !== 'object') return null;
   const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
   return {pages: Number.isInteger(pdf.pages) ? pdf.pages : null, title: text(pdf.title), author: text(pdf.author),
     created: text(pdf.created), text: text(pdf.text)};
 }
 private ask(request: Record<string,string>): Promise<any> {
   const child = this.start();
   if (!child) return Promise.resolve(null);
   const id = ++this.next;
   return new Promise(resolve => {
     const finish = (answer: any) => { clearTimeout(timer); this.pending.delete(id); resolve(answer); };
     // Requests are answered in order, so a timeout means the helper is stuck; replace it.
     const timer = setTimeout(() => { finish(null); child.kill(); }, TIMEOUT_MS);
     this.pending.set(id, finish);
     child.stdin.write(JSON.stringify({id, ...request}) + '\n');
   });
 }
 close() { this.child?.kill(); }
}
