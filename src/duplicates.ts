import { STOPWORDS, tokens } from './ranking.js';

// The final check before display (step D of the 2026-10-01 pipeline redesign): one item shown twice wastes a slot. Two
// results are copies when their titles carry exactly the same words once site decoration is removed (" - YouTube",
// " | Site", " | by Author", "r/sub on Reddit:") and they are on the same site, or both on video sites (a re-upload under
// the identical title). Different outlets covering one story, or different videos on one topic, are separate results
// and stay. The higher-ranked copy is kept.

const VIDEO_SITES = new Set(['youtube.com', 'youtu.be', 'dailymotion.com', 'vimeo.com', 'odysee.com', 'bilibili.com', 'rumble.com']);
const PLATFORM_NAMES = /^(?:youtube|reddit|medium|dailymotion|vimeo|odysee|bilibili|rumble)$/i;
const SEPARATOR = /\s+[|\-–—]\s+(?=[^|\-–—]*$)/;
const host = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^(?:www|m|old)\./, ''); } catch { return ''; } };
const words = (text: string) => tokens(text).filter(t => !STOPWORDS.has(t));

// The title's own words: a trailing segment naming the site, its platform or the author ("by …") is decoration.
function titleWords(title: string, site: string): string[] {
 let t = title.replace(/^r\/[\w-]+ on reddit:\s*/i, '').trim();
 const label = site.split('.')[0];
 for (let i = 0; i < 3; i++) {
   const m = t.match(SEPARATOR);
   if (!m || m.index === undefined) break;
   const tail = t.slice(m.index + m[0].length).trim();
   // Exactly the platform or the site's own name, the site written as a domain ("BGRemover.video"), or an author credit:
   // "Youtube Videos to Text" mentions the site but is part of the title.
   const bare = tail.toLowerCase().replace(/[^a-z0-9.]/g, '');
   const decoration = tail.split(/\s+/).length <= 4 && (/^by\s/i.test(tail) || PLATFORM_NAMES.test(tail)
     || (label.length >= 3 && (bare === label || (bare.includes('.') && bare.startsWith(label)))));
   if (!decoration) break;
   t = t.slice(0, m.index).trim();
 }
 return [...new Set(words(t))].sort();
}

export interface Duplicate { url: string; of: string }
export function collapseDuplicates<T>(items: T[], get: (t: T) => {url: string; title: string} = t => t as unknown as {url: string; title: string}) {
 const kept: T[] = [], dropped: Duplicate[] = [];
 const seen: {key: string; site: string; url: string}[] = [];
 for (const item of items) {
   const {url, title} = get(item), site = host(url), w = titleWords(title, site);
   // Too few words to tell a copy from a different page that shares a short title ("Home"; "How to get a YouTube
   // transcript" from two creators). Every copy found in the stored searches had five or more.
   const key = w.length >= 4 ? w.join(' ') : null;
   const copy = key ? seen.find(s => s.key === key && (s.site === site || VIDEO_SITES.has(s.site) && VIDEO_SITES.has(site))) : undefined;
   if (copy) { dropped.push({url, of: copy.url}); continue; }
   if (key) seen.push({key, site, url});
   kept.push(item);
 }
 return {kept, dropped};
}
