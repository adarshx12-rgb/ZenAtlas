import { canonicalize } from './urls.js';
import { youtubeId } from './youtube.js';

// Independent sources count. A candidate that other sites link to or embed is known in context: a news article that
// embeds the clip, a forum post that links it. Pages already read during the search are the only sources: nothing is
// fetched for this. The candidate's own site never corroborates it. Being linked is evidence the thing exists and is
// what those pages discuss, not that it meets the request, so it informs the judge and breaks ties; it decides nothing.

export interface LinkSource { url: string; links?: {url: string}[]; text?: string|null }
const host = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, ''); } catch { return null; } };
// youtu.be and youtube.com are one site.
const site = (h: string) => h === 'youtu.be' || h.endsWith('.youtube.com') ? 'youtube.com' : h;
// One key for one page: canonical form, then without www or a trailing slash.
const canonical = (url: string) => { try { const u = new URL(canonicalize(url)); return `${host(u.href)}${u.pathname.replace(/\/+$/, '')}${u.search}`; } catch { return url; } };
const VIDEO_ID = /(?:youtube\.com\/(?:watch\?(?:[^\s"'<>]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/g;
// At most this many sites are named per candidate.
const MAX_SITES = 5;

// The distinct other sites linking to each candidate, by candidate URL; candidates nobody links to are left out.
export function linkedFrom(candidates: string[], sources: LinkSource[]): Map<string, string[]> {
 const byUrl = new Map<string, string>(), byVideo = new Map<string, string>();
 for (const url of candidates) {
   byUrl.set(canonical(url), url);
   const id = youtubeId(url);
   if (id) byVideo.set(id, url);
 }
 const out = new Map<string, Set<string>>();
 for (const source of sources) {
   const from = host(source.url);
   if (!from) continue;
   const hits = new Set<string>();
   for (const link of source.links ?? []) { const hit = byUrl.get(canonical(link.url)); if (hit) hits.add(hit); }
   for (const text of [source.text ?? '', ...(source.links ?? []).map(l => l.url)])
     for (const m of text.matchAll(VIDEO_ID)) { const hit = byVideo.get(m[1]); if (hit) hits.add(hit); }
   for (const hit of hits) {
     const own = host(hit);
     if (!own || site(own) === site(from)) continue;
     (out.get(hit) ?? out.set(hit, new Set()).get(hit)!).add(site(from));
   }
 }
 return new Map([...out].map(([url, sites]) => [url, [...sites].sort().slice(0, MAX_SITES)]));
}
