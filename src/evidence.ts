import type { PageEvidence } from './pages.js';
import { accessKind, accessLabel, fullCopyAccess } from './access.js';
import { hardEach, type Format, type Requirement, type RequirementsContract } from './requirements.js';

// One finding links a candidate to a requirement: what supports or contradicts it, where, and how it was obtained.
// Provisional findings (search snippets, URL guesses, model predictions) steer priority and exploration; they never
// verify or exclude a result. A failed fetch or missing field is unknown, never contradicted.
export type FindingStatus = 'supported'|'contradicted'|'unknown';
export type Method = 'page_fetch'|'browser_render'|'pdf_parse'|'video_api'|'captions'|'comments'|'url'|'search_snippet'|'jev'|'judge';
export type Access = 'ok'|'robots_disallowed'|'unavailable'|'not_permitted'|'not_fetched';
export interface Finding {
 url: string; requirement_id: string; status: FindingStatus; excerpt: string|null;
 location: {field: 'title'|'url'|'description'|'page'|'pdf'|'comments'|'transcripts'|'metadata'; page?: number; key?: string};
 method: Method; access: Access; provisional: boolean; confidence?: number;
}
export interface InspectionInput {
 url: string; title: string; description: string|null; published_at?: string|null;
 page?: PageEvidence;
 // From the video platform's API, not from the search result.
 video?: {publishedAt: string|null; official: boolean; channel?: string|null};
}

const VIDEO_URL = [/(^|\.)youtube\.com\/(watch|shorts\/|live\/)/, /^youtu\.be\//, /(^|\.)vimeo\.com\/\d+/, /(^|\.)dailymotion\.com\/video\//,
 /(^|\.)bilibili\.com\/video\//, /(^|\.)tiktok\.com\/@[^/]+\/video\//, /(^|\.)twitch\.tv\/videos\//, /(^|\.)rumble\.com\/v/, /(^|\.)odysee\.com\/@/];
const ARTICLE_TYPES = /^(?:Article|NewsArticle|BlogPosting|ReportageNewsArticle|AnalysisNewsArticle|ScholarlyArticle|TechArticle|OpinionNewsArticle)$/;
// Wording that marks a derivative of a work rather than the work itself.
const DERIVATIVE = /\b(?:summary|summaries|key takeaways|book review|study guide|sparknotes|cliffs ?notes|storyshots|blinkist|book notes|notes on|excerpt|sample chapter|free preview|chapter \d+ only|cheat ?sheet)\b/i;

const host = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const hostPath = (url: string) => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, '')}${u.pathname}`; } catch { return ''; } };
const words = (s: string): string[] => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
const GENERIC = new Set(['the', 'blog', 'newsroom', 'news', 'official', 'inc', 'llc', 'ltd', 'site', 'website',
 'com', 'org', 'net', 'io', 'co', 'gov', 'edu', 'int', 'uk', 'in']);
// A publisher name that is the organisation's own, ignoring generic words ("WhatsApp Blog" is WhatsApp; "WhatsApp Tips" is not).
const sameName = (declared: string, owner: string) => {
 const a = words(declared).filter(w => !GENERIC.has(w)).join(' '), b = words(owner).filter(w => !GENERIC.has(w)).join(' ');
 return !!a && a === b;
};

// Where evidence for this candidate came from, and whether it could be reached.
function source(input: InspectionInput): {method: Method; access: Access; checked: boolean} {
 const p = input.page;
 if (!p) return {method: 'search_snippet', access: 'not_fetched', checked: false};
 if (p.status !== 'checked') return {method: 'page_fetch', access: p.status === 'robots_disallowed' ? 'robots_disallowed' : 'unavailable', checked: false};
 return {method: p.pdf || p.meta?.content_type === 'application/pdf' ? 'pdf_parse' : p.rendered ? 'browser_render' : 'page_fetch', access: 'ok', checked: true};
}

// The format of what was retrieved. 'website' means an HTML page that declares no more specific type.
export function detectFormat(url: string, page: PageEvidence|undefined): {format: Format|'website'|null; excerpt: string|null; provisional: boolean; field: Finding['location']['field']} {
 if (VIDEO_URL.some(p => p.test(hostPath(url)))) return {format: 'video', excerpt: host(url), provisional: false, field: 'url'};
 if (page?.meta?.content_type === 'application/pdf' || page?.pdf) return {format: 'pdf', excerpt: 'application/pdf', provisional: false, field: 'metadata'};
 // Unread: a .pdf address is probably a PDF; any other ordinary address is a web page, which is all a "website"
 // request needs, but says nothing about whether it is an article or a document (see inspect).
 if (!page || page.status !== 'checked') return /\.pdf$/i.test(new URL(url).pathname)
   ? {format: 'pdf', excerpt: '.pdf', provisional: true, field: 'url'} : {format: 'website', excerpt: host(url), provisional: false, field: 'url'};
 const type = page.meta?.schema_types?.find(t => ARTICLE_TYPES.test(t));
 if (type) return {format: 'article', excerpt: type, provisional: false, field: 'metadata'};
 if (page.meta?.og_type === 'article') return {format: 'article', excerpt: 'article', provisional: false, field: 'metadata'};
 if (page.meta?.og_type?.startsWith('video')) return {format: 'video', excerpt: page.meta.og_type, provisional: false, field: 'metadata'};
 return {format: 'website', excerpt: null, provisional: false, field: 'metadata'};
}

function formatStatus(wanted: Format[], found: Format|'website'|null): FindingStatus {
 if (!found || wanted.includes('any')) return found ? 'supported' : 'unknown';
 if (wanted.includes(found as Format)) return 'supported';
 if (found === 'article' && wanted.includes('website')) return 'supported';
 // A page that declares no type may still be an article.
 if (found === 'website' && wanted.includes('article')) return 'unknown';
 return 'contradicted';
}

// Deterministic findings for the requirements that can be checked without a model: format, date, authority,
// completeness and quoted phrases. Subject and property requirements are left to the judge and Jev.
export function inspect(contract: RequirementsContract, input: InspectionInput): Finding[] {
 const src = source(input), out: Finding[] = [];
 const add = (r: Requirement, f: Omit<Finding,'url'|'requirement_id'>) => out.push({url: input.url, requirement_id: r.id, ...f});
 const unknown = (r: Requirement) => add(r, {status: 'unknown', excerpt: null, location: {field: 'page'}, method: src.method, access: src.access, provisional: false});
 const page = input.page?.status === 'checked' ? input.page : undefined;
 const retrieved = page ? [page.pdf?.title, page.title, page.description, page.text, page.pdf?.text].filter((s): s is string => !!s) : [];
 // Dates, best source first: what the page or PDF declares, the video platform, then the search result (provisional).
 const dated = page?.meta?.published ? {day: page.meta.published, method: src.method, field: 'metadata' as const, provisional: false}
   : input.video?.publishedAt ? {day: input.video.publishedAt.slice(0, 10), method: 'video_api' as const, field: 'metadata' as const, provisional: false}
   : input.published_at ? {day: input.published_at.slice(0, 10), method: 'search_snippet' as const, field: 'metadata' as const, provisional: true} : null;
 for (const r of contract.requirements) {
   if (r.kind === 'format' && r.formats) {
     const d = detectFormat(input.url, input.page);
     const unread = d.field === 'url' && d.format === 'website';
     const status = formatStatus(r.formats, d.format);
     // An unread page supports a website request, and nothing else: it may still be an article or a document.
     if (!d.format || (unread && status !== 'supported')) { unknown(r); continue; }
     add(r, {status, excerpt: d.excerpt, location: {field: d.field}, method: d.field === 'url' ? 'url' : src.method,
       access: d.field === 'url' ? src.access : 'ok', provisional: d.provisional});
   } else if (r.kind === 'date' && r.date_range) {
     if (!dated) { if (r.scope === 'each') unknown(r); continue; }
     if (r.scope === 'set') {
       const year = dated.day.slice(0, 4);
       if (r.set_items?.includes(year) && dated.day >= r.date_range.from && dated.day <= r.date_range.to)
         add(r, {status: 'supported', excerpt: dated.day, location: {field: dated.field, key: year}, method: dated.method, access: 'ok', provisional: dated.provisional});
       continue;
     }
     const inside = dated.day >= r.date_range.from && dated.day <= r.date_range.to;
     add(r, {status: inside ? 'supported' : 'contradicted', excerpt: dated.day, location: {field: dated.field}, method: dated.method,
       access: 'ok', provisional: dated.provisional});
   } else if (r.kind === 'authority' && r.scope === 'each') {
     const domains = r.authority?.domains ?? [], h = host(input.url);
     const onDomain = domains.some(d => h === d || h.endsWith(`.${d}`));
     // The publishers that count as official. A page that declares itself one of them (og:site_name or its JSON-LD
     // publisher, matched exactly) is official; a title that merely mentions one also needs the official domain.
     const names = (r.authority?.names ?? [r.authority?.entity ?? '']).filter(n => n && !/^the named/.test(n));
     const declared = [page?.meta?.site_name, page?.meta?.publisher].find(s => s && names.some(n => sameName(s, n)));
     const titled = page?.title && names.some(n => words(page.title!).join(' ').includes(words(n).join(' '))) ? page.title : null;
     if (input.video?.official) add(r, {status: 'supported', excerpt: input.video.channel ?? null, location: {field: 'metadata'}, method: 'video_api', access: 'ok', provisional: false});
     else if (declared) add(r, {status: 'supported', excerpt: declared, location: {field: 'metadata'}, method: src.method, access: 'ok', provisional: false});
     else if (onDomain && page && titled) add(r, {status: 'supported', excerpt: titled, location: {field: 'metadata'}, method: src.method, access: 'ok', provisional: false});
     else if (onDomain) add(r, {status: 'supported', excerpt: h, location: {field: 'url'}, method: 'url', access: src.access, provisional: true});
     else unknown(r);
   } else if (r.kind === 'authority' && r.scope === 'set') {
     const h = host(input.url);
     for (const item of r.set_items ?? []) {
       const token = words(item).join('');
       const named = page && [page.meta?.site_name, page.meta?.publisher].find(s => s && words(s).join(' ').includes(words(item).join(' ')));
       if (named) add(r, {status: 'supported', excerpt: named, location: {field: 'metadata', key: item}, method: src.method, access: 'ok', provisional: false});
       else if (token && h.split('.').includes(token)) add(r, {status: 'supported', excerpt: h, location: {field: 'url', key: item}, method: 'url',
         access: src.access, provisional: !page});
     }
   } else if (r.kind === 'completeness' && r.access === 'legitimate') {
     const kind = accessKind(input.url);
     const derivative = retrieved.map(text => ({text, match: DERIVATIVE.exec(text)})).find(x => x.match);
     const guessed = !page && DERIVATIVE.exec(input.title);
     if (kind === 'unauthorized') add(r, {status: 'contradicted', excerpt: host(input.url), location: {field: 'url'}, method: 'url', access: src.access, provisional: false});
     else if (derivative) add(r, {status: 'contradicted', excerpt: derivative.text.length <= 200 ? derivative.text : derivative.match![0],
       location: {field: page?.pdf ? 'pdf' : 'page', page: page?.pdf ? 1 : undefined}, method: src.method, access: 'ok', provisional: false});
     else if (guessed) add(r, {status: 'contradicted', excerpt: guessed[0], location: {field: 'title'}, method: 'search_snippet', access: src.access, provisional: true});
     else if (fullCopyAccess(kind)) {
       const work = contract.entities.find(e => e.kind === 'work')?.name;
       const titled = !work || words(work).filter(w => w.length > 2).every(w => words(page?.title ?? input.title).includes(w));
       if (titled) add(r, {status: 'supported', excerpt: accessLabel(kind), location: {field: 'metadata'}, method: page ? src.method : 'url',
         access: src.access, provisional: !page});
       else unknown(r);
     } else unknown(r);
   } else if (r.kind === 'subject' && r.hardness === 'hard') {
     const phrase = /^Mentions "(.+)"$/.exec(r.text)?.[1];
     if (!phrase) continue;
     const hit = retrieved.find(t => t.toLowerCase().includes(phrase.toLowerCase()));
     if (hit) add(r, {status: 'supported', excerpt: phrase, location: {field: 'page'}, method: src.method, access: 'ok', provisional: false});
     else unknown(r);
   }
 }
 return out;
}

export interface RequirementCheck { id: string; status: 'supported'|'unknown'|'mismatch'; field: string; quote: string }
const INSPECTED_KINDS = new Set<Requirement['kind']>(['format', 'date', 'authority', 'completeness']);
export interface RequirementState { id: string; text: string; status: FindingStatus|'waived'; excerpt: string|null; method: Method|null }
export interface Decision {
 status: 'verified'|'uncertain'|'excluded';
 requirements: RequirementState[]; contradicted: string[]; unconfirmed: string[]; notes: string[];
}

// One candidate against every hard per-result requirement. Inspected evidence beats a model's prediction on the
// same requirement; a grounded judge quote counts where nothing was inspected; provisional findings count for nothing.
// "Not X", "no talking", "exclude background music": metadata can rarely prove an absence, so an exclusion the evidence
// neither confirms nor contradicts is waived (named in the notes) instead of making every candidate unverified. A
// contradicted exclusion still removes the candidate.
const EXCLUSION = /^\s*(?:not|no|never|without|exclud\w*|avoid\w*)\b/i;
export function decide(contract: RequirementsContract, findings: Finding[], judged: RequirementCheck[] = []): Decision {
 const states: RequirementState[] = [], notes: string[] = [];
 for (const r of hardEach(contract)) {
   const own = findings.filter(f => f.requirement_id === r.id && !f.provisional);
   const inspected = own.find(f => f.status === 'contradicted') ?? own.find(f => f.status === 'supported');
   // Format, date, authority and completeness have inspectors; a model quoting a title cannot establish them.
   const model = INSPECTED_KINDS.has(r.kind) ? undefined : judged.find(c => c.id === r.id);
   if (inspected) states.push({id: r.id, text: r.text, status: inspected.status, excerpt: inspected.excerpt, method: inspected.method});
   else if (model?.status === 'mismatch') states.push({id: r.id, text: r.text, status: 'contradicted', excerpt: model.quote || null, method: 'judge'});
   else if (model?.status === 'supported') states.push({id: r.id, text: r.text, status: 'supported', excerpt: model.quote, method: 'judge'});
   else states.push({id: r.id, text: r.text, status: 'unknown', excerpt: null, method: null});
 }
 // A legitimately available full work in another file format is shown, with the format named as unmet.
 const full = states.find(s => contract.requirements.find(r => r.id === s.id)?.kind === 'completeness' && s.status === 'supported');
 for (const s of states) {
   const r = contract.requirements.find(x => x.id === s.id)!;
   if (full && r.kind === 'format' && s.status === 'contradicted') {
     s.status = 'waived';
     notes.push(`Full work available (${full.excerpt ?? 'legitimate source'}); not as ${(r.formats ?? []).map(f => f.toUpperCase()).join(' or ')}.`);
   }
 }
 for (const s of states) if (s.status === 'unknown' && EXCLUSION.test(s.text)) { s.status = 'waived'; notes.push(`Could not check: ${s.text}.`); }
 const contradicted = states.filter(s => s.status === 'contradicted').map(s => s.id);
 const unconfirmed = states.filter(s => s.status === 'unknown').map(s => s.id);
 return {status: contradicted.length ? 'excluded' : unconfirmed.length ? 'uncertain' : 'verified', requirements: states, contradicted, unconfirmed, notes};
}

export interface Gap { requirement_id: string; item?: string; text: string }
// How well a set of candidates covers the contract. An "each" requirement is covered once `target` candidates support
// it with non-provisional evidence and contradict no hard requirement; a "set" requirement needs every item covered.
export function coverage(contract: RequirementsContract, findings: Finding[], target: number) {
 const hard = hardEach(contract);
 const excluded = new Set(findings.filter(f => !f.provisional && f.status === 'contradicted' && hard.some(r => r.id === f.requirement_id)).map(f => f.url));
 const solid = findings.filter(f => !f.provisional && f.status === 'supported' && !excluded.has(f.url));
 const each = hard.map(r => ({id: r.id, supported: new Set(solid.filter(f => f.requirement_id === r.id).map(f => f.url)).size}));
 const set = contract.requirements.filter(r => r.scope === 'set').flatMap(r => (r.set_items ?? []).map(item => ({id: r.id, item,
   covered: solid.some(f => f.requirement_id === r.id && f.location.key?.toLowerCase() === item.toLowerCase())})));
 const gaps: Gap[] = [
   ...each.filter(e => e.supported < target).map(e => ({requirement_id: e.id, text: hard.find(r => r.id === e.id)!.text})),
   ...set.filter(s => !s.covered).map(s => ({requirement_id: s.id, item: s.item,
     text: `${contract.requirements.find(r => r.id === s.id)!.text}: ${s.item}`})),
 ];
 return {each, set, gaps};
}
