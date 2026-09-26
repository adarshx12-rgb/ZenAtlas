import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { fetchText } from './http.js';

// Links the Docs tab never serves or follows: hosts on public malware and phishing blocklists (DOC_BLOCKLISTS, refreshed
// daily and cached on disk), and explicit adult content. Search engines' strict safe search is the first line of that;
// this catches what they let through. Piracy sites are handled by data/access-sources.json.

const DAY_MS = 24 * 3600 * 1000;
let blocked = new Set<string>();
let loadedAt = 0, loading: Promise<void>|null = null;

// Hosts from a hosts file ("127.0.0.1 evil.example"), a plain domain list or a URL feed; comments are skipped.
export function parseBlocklist(text: string): string[] {
 const hosts: string[] = [];
 for (const raw of text.split(/\r?\n/)) {
   const line = raw.replace(/#.*$/, '').trim();
   if (!line) continue;
   const token = line.split(/\s+/).at(-1)!;
   try {
     const host = (/^[a-z]+:\/\//i.test(token) ? new URL(token).hostname : token).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
     if (/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host) && host !== 'localhost') hosts.push(host);
   } catch { /* not a host */ }
 }
 return hosts;
}

// Loads the lists once a day; a list that cannot be fetched keeps its last copy from disk. Never throws.
export function refreshBlocklists(config: Config, fetch = fetchText): Promise<void> {
 if (Date.now() - loadedAt < DAY_MS && blocked.size) return Promise.resolve();
 return loading ??= (async () => {
   const next = new Set<string>();
   for (const url of config.DOC_BLOCKLISTS.split(',').map(s => s.trim()).filter(Boolean)) {
     const cache = join(tmpdir(), `zenatlas-blocklist-${Buffer.from(url).toString('base64url').slice(0, 60)}.txt`);
     let text: string|null = null;
     try { text = (await fetch(url, {timeoutMs: 15000, maxBytes: 16 * 1024 * 1024, redirects: 3, accept: 'text/plain', contentTypes: ['text/plain']})).text;
       await writeFile(cache, text).catch(() => {}); }
     catch { text = await readFile(cache, 'utf8').catch(() => null); }
     for (const host of parseBlocklist(text ?? '')) next.add(host);
   }
   if (next.size) { blocked = next; loadedAt = Date.now(); }
 })().finally(() => { loading = null; });
}
export function setBlocklist(hosts: string[]) { blocked = new Set(hosts); loadedAt = Date.now(); }

// Explicit adult content, by strong terms in the address or title only: "sex education" or "breast cancer" stay.
const EXPLICIT = /\b(?:porn\w*|xxx|hentai|nsfw|onlyfans|camgirls?|escort(?:s|ing)?|xvideos|xnxx|redtube|youporn|pornhub)\b/i;
export function explicit(url: string, title = ''): boolean {
 try { const u = new URL(url); return EXPLICIT.test(`${u.hostname.replace(/[.-]/g, ' ')} ${decodeURIComponent(u.pathname).replace(/[/_.-]/g, ' ')} ${title}`); }
 catch { return false; }
}
export function blockedHost(url: string): boolean {
 try {
   const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
   const labels = host.split('.');
   // The host itself or any parent domain on a list (a malware host's subdomains are no safer).
   return labels.some((_, i) => i < labels.length - 1 && blocked.has(labels.slice(i).join('.')));
 } catch { return false; }
}
export const unsafeLink = (url: string, title = '') => blockedHost(url) || explicit(url, title);
