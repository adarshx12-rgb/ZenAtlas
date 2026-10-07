import type { Config } from './config.js';
import type { DB } from './db.js';
import { fetchJSON, probeURL, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { publicURL } from './urls.js';
import { deepCircuit, remaining, SourceCircuit, within } from './deep-runtime.js';

export type RescueDeps = {json?: typeof fetchJSON; probe?: typeof probeURL; budget?: typeof takeBudget; circuit?: SourceCircuit};
export function snapshotURL(value: unknown, original: string, file = false): string|null {
 const closest = (value as any)?.archived_snapshots?.closest;
 if (closest?.available !== true || String(closest.status) !== '200' || typeof closest.url !== 'string') return null;
 try {
   const snapshot = publicURL(closest.url);
   if (snapshot.hostname !== 'web.archive.org') return null;
   const match = /^\/web\/(\d{14})(?:id_)?\/(https?:\/\/.+)$/.exec(snapshot.pathname + snapshot.search);
   if (!match || publicURL(match[2]).href !== publicURL(original).href) return null;
   return `https://web.archive.org/web/${match[1]}${file ? 'id_' : ''}/${match[2]}`;
 } catch { return null; }
}
export async function rescueDeadLinks(db: DB, config: Config, candidates: {url: string; doc_type?: string|null}[], deps: RescueDeps = {}): Promise<Map<string, string>> {
 const swaps = new Map<string, string>();
 if (!config.DEEP_SOURCES) return swaps;
 const deadline = Date.now() + config.DEEP_SOURCES_TIMEOUT_MS, circuit = deps.circuit ?? deepCircuit;
 await Promise.all(candidates.slice(0, 5).map(async row => {
   try {
     const replacement = await within(deadline, async () => {
       publicURL(row.url);
       if (new URL(row.url).hostname === 'web.archive.org') return null;
       let dead = false;
       try { dead = [404, 410].includes((await (deps.probe ?? probeURL)(row.url, remaining(deadline), true)).status); }
       catch (e) { dead = e instanceof UpstreamError && (e.code === 'dns_failure' || [404, 410].includes(e.status ?? 0)); }
       if (!dead || !circuit.allows('wayback')) return null;
       if (!await (deps.budget ?? takeBudget)(db, 'deep:wayback', config.DEEP_SOURCES_DAILY_BUDGET)) return null;
       const url = new URL('https://archive.org/wayback/available'); url.searchParams.set('url', row.url);
       try {
         const data = await within(deadline, () => (deps.json ?? fetchJSON)(url.href, {trustedOrigin: url.origin, redirects: 0, maxBytes: 64 * 1024, timeoutMs: remaining(deadline)}));
         circuit.success('wayback');
         return snapshotURL(data, row.url, !!row.doc_type);
       } catch { circuit.failure('wayback'); return null; }
     });
     if (replacement) swaps.set(row.url, replacement);
   } catch { /* A rescue never delays or fails the original search beyond its deadline. */ }
 }));
 return swaps;
}
