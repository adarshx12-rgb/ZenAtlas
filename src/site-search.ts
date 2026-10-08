import type { Config } from './config.js';
import type { DB } from './db.js';
import type { SourceRow } from './doc-sources.js';
import { fetchText, UpstreamError } from './http.js';
import { publicURL } from './urls.js';
import { cleanSite } from './field-routing.js';
import { robotsAllows } from './pages.js';
import { takeBudget } from './budgets.js';
import { deepCircuit, interleave, remaining, SourceCircuit, within } from './deep-runtime.js';

export interface SiteCredit {domain: string; template: string}
export type SiteRow = SourceRow & {siteSearch?: SiteCredit};
export type SiteAttribution = Map<string, SiteCredit>;
type CacheRow = {domain: string; template: string|null; status: 'active'|'manual'|'absent'|'rejected'; checked_at: Date|string; hits: number; good: number};
export const MANUAL_DOMAINS = ['rbi.org.in', 'sebi.gov.in', 'egazette.gov.in', 'egazette.nic.in', 'elephind.com'] as const;
const TTL = 7 * 86400_000;
const decode = (v: string) => v.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([0-9a-f]+));/gi, (raw, n, x) => {
 const code = n ? Number(n) : x ? parseInt(x, 16) : 0;
 return code ? code <= 0x10ffff ? String.fromCodePoint(code) : raw : ({'&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>'}[raw.toLowerCase()] ?? raw);
});
function attributes(tag: string): Record<string, string> {
 return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
   .map(m => [m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4])]));
}
export function sameSite(url: string, domain: string): boolean {
 try { const h = publicURL(url).hostname.replace(/^www\./, ''); return h === domain || h.endsWith(`.${domain}`); } catch { return false; }
}
export function discoverDescriptor(html: string, base: string, domain: string): string|null {
 for (const [tag] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<link\b[^>]*>/gi)) {
   const a = attributes(tag);
   if (!a.rel?.toLowerCase().split(/\s+/).includes('search') || a.type?.toLowerCase() !== 'application/opensearchdescription+xml' || !a.href) continue;
   try { const url = new URL(a.href, base).href; if (sameSite(url, domain)) return url; } catch { /* malformed link */ }
 }
 return null;
}
export function validTemplate(template: string, domain: string): boolean {
 if (template.length > 4096 || !template.includes('{searchTerms}')) return false;
 const expanded = template.replaceAll('{searchTerms}', 'probe');
 if (/[{}]/.test(expanded) || !sameSite(expanded, domain)) return false;
 try {
   const original = new URL(template), expandedURL = new URL(expanded);
   return !original.hash && original.host === expandedURL.host;
 } catch { return false; }
}
export function parseTemplate(xml: string, base: string, domain: string): string|null {
 if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
 for (const [tag] of xml.matchAll(/<(?:[\w-]+:)?Url\b[^>]*>/g)) {
   const a = attributes(tag);
   if (a.type !== 'text/html' || (a.method && a.method.toUpperCase() !== 'GET') || !a.template) continue;
   let template = a.template.replace(/\{(count|startIndex|startPage|language|inputEncoding|outputEncoding)\??\}/g,
     (_, key: string) => ({count: '5', startIndex: '1', startPage: '1', language: 'en', inputEncoding: 'UTF-8', outputEncoding: 'UTF-8'}[key]!))
     .replace(/\{[\w:]+\?\}/g, '');
   if (/[{}]/.test(template.replaceAll('{searchTerms}', ''))) continue;
   try { template = new URL(template.replaceAll('{searchTerms}', 'ZENATLASSEARCHTERM'), base).href.replaceAll('ZENATLASSEARCHTERM', '{searchTerms}'); }
   catch { continue; }
   if (validTemplate(template, domain)) return template;
 }
 return null;
}
export function parseSiteResults(html: string, base: string, domain: string): SourceRow[] {
 const seen = new Set<string>(), rows: SourceRow[] = [];
 const body = html.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
 for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
   const a = attributes(m[1]), title = decode(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
   if (!a.href || a.href.startsWith('#') || !title || /^(home|next|previous|log ?in|sign ?in|privacy|terms|contact|search|\d+)$/i.test(title)) continue;
   try {
     const u = new URL(a.href, base); u.hash = '';
     if (!sameSite(u.href, domain) || u.href === base || u.pathname === '/' || u.pathname === new URL(base).pathname || seen.has(u.href)) continue;
     seen.add(u.href); rows.push({url: u.href, title, snippet: null, published: null, engine: `deep:site:${domain}`});
     if (rows.length === 5) break;
   } catch { /* invalid result */ }
 }
 return rows;
}

export type SiteDeps = {text?: typeof fetchText; budget?: typeof takeBudget; circuit?: SourceCircuit; log?: (line: Record<string, unknown>) => void};
class RobotsDenied extends Error {}
// Redirects are not followed: a new destination needs its own robots check first.
function robotReader(deadline: number, transport: typeof fetchText) {
 const rules = new Map<string, Promise<string>>();
 return async (url: string, xml = false) => {
   const u = publicURL(url);
   let rule = rules.get(u.origin);
   if (!rule) {
     rule = transport(`${u.origin}/robots.txt`, {timeoutMs: remaining(deadline), redirects: 0, contentTypes: ['text/plain'], accept: 'text/plain', maxBytes: 512 * 1024})
       .then(r => r.text, e => { if (e instanceof UpstreamError && [404, 410].includes(e.status ?? 0)) return ''; throw e; });
     rules.set(u.origin, rule);
   }
   if (!robotsAllows(await rule, u.pathname + u.search)) throw new RobotsDenied();
   return transport(url, {timeoutMs: remaining(deadline), redirects: 0, maxBytes: 1024 * 1024,
     ...(xml ? {contentTypes: ['application/opensearchdescription+xml', 'application/xml', 'text/xml'], accept: 'application/opensearchdescription+xml,application/xml,text/xml'} : {})});
 };
}
export async function searchSites(db: DB, config: Config, query: string, domains: string[], deps: SiteDeps = {},
 deadline = Date.now() + config.DEEP_SOURCES_TIMEOUT_MS): Promise<SiteRow[]> {
 if (!config.DEEP_SOURCES) return [];
 const circuit = deps.circuit ?? deepCircuit, read = robotReader(deadline, deps.text ?? fetchText);
 const log = deps.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`));
 const lists = await Promise.all([...new Set(domains.map(cleanSite).filter((s): s is string => !!s))].slice(0, 2).map(async domain => {
   const key = `site:${domain}`, started = Date.now();
   if (!circuit.allows(key)) return [];
   // How far each site got (cache, home page, descriptor, search page), for tuning: never the query or the site.
   let stage = 'cache';
   const done = (rows: SiteRow[], e?: unknown) => {
     log({event: 'site_search', tier: config.TIER, stage, rows: rows.length, ms: Date.now() - started,
       ...(e ? {error: e instanceof RobotsDenied ? 'robots_denied' : e instanceof UpstreamError ? e.code : 'error',
         ...(e instanceof UpstreamError && e.status ? {status: e.status} : {})} : {})});
     return rows;
   };
   try {
     return await within(deadline, async () => {
       let cached = (await db.query<CacheRow>('SELECT * FROM site_search WHERE domain=$1', [domain])).rows[0];
       remaining(deadline);
       if (cached?.status === 'rejected') { stage = 'rejected'; return []; }
       if (!await (deps.budget ?? takeBudget)(db, `deep:${key}`, config.DEEP_SOURCES_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
       remaining(deadline);
       if (!cached || cached.status !== 'manual' && Date.now() - +new Date(cached.checked_at) >= TTL) {
         stage = 'home';
         const base = `https://${domain}/`, home = await read(base);
         const descriptor = discoverDescriptor(home.text, home.url, domain);
         stage = descriptor ? 'descriptor' : 'no_descriptor';
         const template = descriptor ? parseTemplate((await read(descriptor, true)).text, descriptor, domain) : null;
         remaining(deadline);
         const saved = await db.query<CacheRow>(`INSERT INTO site_search(domain,template,status) VALUES($1,$2,$3)
           ON CONFLICT(domain) DO UPDATE SET template=$2,status=$3,checked_at=now(),
           hits=CASE WHEN site_search.template IS NOT DISTINCT FROM $2 THEN site_search.hits ELSE 0 END,
           good=CASE WHEN site_search.template IS NOT DISTINCT FROM $2 THEN site_search.good ELSE 0 END
           WHERE site_search.status NOT IN ('manual','rejected') RETURNING *`, [domain, template, template ? 'active' : 'absent']);
         cached = saved.rows[0];
       }
       if (!cached?.template || !validTemplate(cached.template, domain)) { if (stage === 'descriptor') stage = 'no_template'; return []; }
       stage = 'search';
       const url = cached.template.replaceAll('{searchTerms}', encodeURIComponent(query)), page = await read(url);
       remaining(deadline);
       return parseSiteResults(page.text, page.url, domain).map(r => ({...r, siteSearch: {domain, template: cached!.template!}}));
     }).then(rows => { circuit.success(key); return done(rows); });
   } catch (e) {
     if (!(e instanceof RobotsDenied) && !(e instanceof UpstreamError && e.code === 'budget_exhausted')) circuit.failure(key);
     return done([], e);
   }
 }));
 return interleave(lists);
}

export async function addSiteTemplate(db: DB, domain: string, template: string) {
 if (!(MANUAL_DOMAINS as readonly string[]).includes(domain) || !validTemplate(template, domain)) throw new Error('invalid_site_template');
 await db.query(`INSERT INTO site_search(domain,template,status) VALUES($1,$2,'manual') ON CONFLICT(domain)
   DO UPDATE SET template=$2,status='manual',checked_at=now(),hits=0,good=0`, [domain, template]);
}
export async function learnSiteSearch(db: DB, judged: {url: string; relevance?: number|null}[], attribution: ReadonlyMap<string, SiteCredit>) {
 const seen = new Set<string>();
 for (const j of judged) {
   const source = attribution.get(j.url);
   if (!source || j.relevance == null || !Number.isFinite(j.relevance) || seen.has(j.url)) continue;
   seen.add(j.url);
   await db.query(`UPDATE site_search SET hits=hits+1,good=good+$3,
     status=CASE WHEN hits+1>20 AND (good+$3)::numeric/(hits+1)<0.1 THEN 'rejected' ELSE status END,
     template=CASE WHEN hits+1>20 AND (good+$3)::numeric/(hits+1)<0.1 THEN NULL ELSE template END
     WHERE domain=$1 AND template=$2 AND status IN ('active','manual')`, [source.domain, source.template, j.relevance >= 8 ? 1 : 0]);
 }
}
