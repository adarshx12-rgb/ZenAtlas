import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface TextExtractor { text(html: string): Promise<string|null>; close(): void }

const TIMEOUT_MS = 15_000, RETRY_MS = 60_000;

// One long-lived Python process runs trafilatura (scene-worker/src/zenatlas_scenes/pagetext.py). It never fetches:
// Node sends HTML it already fetched through its own public-address checks. Any failure answers null, so callers fall back.
export class Trafilatura implements TextExtractor {
 private child?: ChildProcessWithoutNullStreams;
 private pending = new Map<number, (text: string|null) => void>();
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
       this.pending.get(answer.id)?.(typeof answer.text === 'string' && answer.text ? answer.text : null);
     } catch { /* Ignore anything that is not an answer. */ }
   });
   for (const stream of [child, child.stdin, child.stdout, child.stderr] as {unref?: () => void}[]) stream.unref?.();
   return this.child = child;
 }
 text(html: string): Promise<string|null> {
   const child = this.start();
   if (!child) return Promise.resolve(null);
   const id = ++this.next;
   return new Promise(resolve => {
     const finish = (text: string|null) => { clearTimeout(timer); this.pending.delete(id); resolve(text); };
     // Requests are answered in order, so a timeout means the helper is stuck; replace it.
     const timer = setTimeout(() => { finish(null); child.kill(); }, TIMEOUT_MS);
     this.pending.set(id, finish);
     child.stdin.write(JSON.stringify({id, html}) + '\n');
   });
 }
 close() { this.child?.kill(); }
}
