import { UpstreamError } from './http.js';

// Per process, bounded, and shared by connector, site-search and archive requests.
export class SourceCircuit {
 private states = new Map<string, {failures: number; until: number}>();
 constructor(private now = Date.now) {}
 allows(name: string): boolean {
   const state = this.states.get(name);
   if (!state) return true;
   if (state.until && state.until <= this.now()) { this.states.delete(name); return true; }
   return !state.until;
 }
 success(name: string) { this.states.delete(name); }
 failure(name: string) {
   const state = this.states.get(name) ?? {failures: 0, until: 0};
   if (state.until > this.now()) return;
   state.failures++;
   if (state.failures >= 3) state.until = this.now() + 30 * 60_000;
   if (!this.states.has(name) && this.states.size >= 2000) this.states.delete(this.states.keys().next().value!);
   this.states.set(name, state);
 }
}
export const deepCircuit = new SourceCircuit();
export const remaining = (deadline: number) => {
 const ms = deadline - Date.now();
 if (ms <= 0) throw new UpstreamError('timeout');
 return ms;
};
export async function within<T>(deadline: number, task: () => Promise<T>): Promise<T> {
 let timer: NodeJS.Timeout|undefined;
 try {
   const ms = remaining(deadline);
   return await Promise.race([task(), new Promise<never>((_, reject) => {
     timer = setTimeout(() => reject(new UpstreamError('timeout')), ms);
   })]);
 } finally { clearTimeout(timer); }
}
export function interleave<T>(lists: T[][]): T[] {
 return Array.from({length: Math.max(0, ...lists.map(l => l.length))}, (_, i) => lists.flatMap(l => i < l.length ? [l[i]] : [])).flat();
}
