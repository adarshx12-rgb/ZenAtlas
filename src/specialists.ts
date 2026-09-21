import { z } from 'zod';
import type { Config } from './config.js';
import { contentInput, type DiscoveryPage, type SourceAdapter, type SearchInput } from './types.js';
import { fetchJSON } from './http.js';
import { publicURL } from './urls.js';
import { fallbackPlan, type PlannedSearch } from './planner.js';

// These routes suggest where to look, never confer trust or boost a result's score.
const routes = [
 {match: /\b(?:lecture|research|science|university|course|education|documentary)\b/i,
  domains: ['videolectures.net', 'ocw.mit.edu']},
 {match: /\b(?:programming|software|computing|security|hacking|conference)\b/i,
  domains: ['media.ccc.de', 'videolectures.net']},
 {match: /\b(?:film|animation|animated|cinema|filmmaker|short film|stop.motion)\b/i,
  domains: ['shortoftheweek.com', 'blender.org']},
 {match: /\b(?:history|historical|historic|archive|archival|vintage|newsreel|documentary)\b/i,
  domains: ['loc.gov', 'europeana.eu', 'archive.org']},
];
export function specialistSearches(query: string, limit: number): PlannedSearch[] {
 // Respect explicit site restrictions; never replace the user's scope with a preferred site.
 if (/(?:^|\s)-?site:/i.test(query)) return [];
 const domains = [...new Set(routes.filter(r => r.match.test(query)).flatMap(r => r.domains))];
 return domains.slice(0, limit).map(domain => ({query: `${query} site:${domain}`, target: 'web'}));
}

const caps = {transcripts: false, comments: false, embeds: false, accessible_media: false};
const rowsPerPage = 30;
const pageNumber = (cursor: string) => z.coerce.number().int().min(1).max(5).parse(cursor);
const plain = (value: unknown, max: number): string|null => {
 const text = (Array.isArray(value) ? value.filter(v => typeof v === 'string').join('; ') : typeof value === 'string' ? value : '')
   .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
 return text ? text.slice(0, max) : null;
};
const safeLink = (value: unknown) => { try { return typeof value === 'string' ? publicURL(value).href : null; } catch { return null; } };
const date = (value: unknown) => {
 // Historical year-only dates are not invented as January 1st timestamps.
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
 const parsed = new Date(value);
 return Number.isFinite(parsed.getTime()) && parsed.getTime() <= Date.now() ? parsed.toISOString() : null;
};

// Keyless native catalogue APIs. Returned links still pass through the normal source policy and
// relevance checks. A catalogue entry is not evidence that its media is playable or reusable.
export class InternetArchive implements SourceAdapter {
 name = 'internet_archive'; capabilities = caps;
 constructor(private config: Config, private transport = fetchJSON) {}
 async search(query: string, _filters: SearchInput, cursor = '1'): Promise<DiscoveryPage> {
   const page = pageNumber(cursor);
   // Quote literal tokens so user syntax cannot override the media-type constraint.
   const terms = query.match(/"[^"]+"|[^\s]+/g) ?? [];
   const literal = terms.map(t => `"${t.replace(/^"|"$/g, '').replace(/[\\"]/g, '\\$&')}"`).join(' AND ');
   const collections = this.config.ARCHIVE_COLLECTIONS.split(',').map(c => `collection:"${c.trim()}"`).join(' OR ');
   const url = new URL('https://archive.org/advancedsearch.php');
   url.search = new URLSearchParams({q: `mediatype:movies AND (${collections}) AND (title:(${literal}) OR description:(${literal}) OR subject:(${literal}))`,
     output: 'json', rows: String(rowsPerPage), page: String(page)}).toString();
   for (const field of ['identifier', 'title', 'description', 'creator', 'date', 'licenseurl', 'mediatype']) url.searchParams.append('fl[]', field);
   const data = z.object({response: z.object({numFound: z.number().nonnegative(), docs: z.array(z.unknown()).max(1000)})})
     .parse(await this.transport(url.href, {timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects: 0}));
   const results = [];
   for (const raw of data.response.docs.slice(0, rowsPerPage)) try {
     const row = z.record(z.string(), z.unknown()).parse(raw);
     const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/).parse(row.identifier);
     if (row.mediatype !== 'movies') continue;
     results.push(contentInput.parse({url: `https://archive.org/details/${id}`, provider_id: id,
       title: plain(row.title, 500), description: plain(row.description, 10000), creator: plain(row.creator, 300),
       published_at: date(row.date), license_url: safeLink(Array.isArray(row.licenseurl) ? row.licenseurl[0] : row.licenseurl)}));
   } catch { /* One malformed catalogue record must not discard the whole page. */ }
   return {results, next_cursor: page < 5 && page*rowsPerPage < data.response.numFound ? String(page + 1) : null,
     status: {provider: this.name, status: 'ok', message: 'Internet Archive film catalogue searched directly.'}};
 }
}

export class LibraryOfCongress implements SourceAdapter {
 name = 'library_of_congress'; capabilities = caps;
 constructor(private config: Config, private transport = fetchJSON) {}
 async search(query: string, _filters: SearchInput, cursor = '1'): Promise<DiscoveryPage> {
   const page = pageNumber(cursor);
   const url = new URL('https://www.loc.gov/film-and-videos/');
   url.search = new URLSearchParams({q: query, fo: 'json', c: String(rowsPerPage), sp: String(page),
     fa: 'online-format:video', at: 'results,pagination'}).toString();
   const data = z.object({results: z.array(z.unknown()).max(1000), pagination: z.object({next: z.string().nullable().optional()}).optional()})
     .parse(await this.transport(url.href, {timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects: 0}));
   const results = [];
   for (const raw of data.results.slice(0, rowsPerPage)) try {
     const row = z.record(z.string(), z.unknown()).parse(raw);
     const link = new URL(z.string().parse(row.id ?? row.url));
     if (!['www.loc.gov', 'loc.gov'].includes(link.hostname) || !link.pathname.startsWith('/item/')) continue;
     link.protocol = 'https:';
     results.push(contentInput.parse({url: publicURL(link.href).href, title: plain(row.title, 500),
       description: plain(row.description, 10000), creator: plain(row.contributor, 300), published_at: date(row.date)}));
   } catch { /* Preserve usable individual item links, never collection or navigation pages. */ }
   return {results, next_cursor: page < 5 && data.pagination?.next ? String(page + 1) : null,
     status: {provider: this.name, status: 'ok', message: 'Library of Congress film catalogue searched directly.'}};
 }
}

export function configuredArchives(config: Config, query: string): SourceAdapter[] {
 if (!config.ARCHIVE_DISCOVERY || fallbackPlan(query).kind === 'websites') return [];
 // Native APIs cannot implement general search-engine site operators. Leave those searches to the web adapters.
 if (/(?:^|\s)-?site:/i.test(query)) return [];
 return [new InternetArchive(config), ...(config.LIBRARY_OF_CONGRESS_DISCOVERY ? [new LibraryOfCongress(config)] : [])];
}
