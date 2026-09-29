import { readFileSync } from 'node:fs';
import { z } from 'zod';

const OWNERS: {brands: string[]; owner: string; domains: string[]}[] = JSON.parse(readFileSync(new URL('../data/owning-companies.json', import.meta.url), 'utf8'))
 .owners.map((o: {brands: string[]; owner: string; domains: string[]}) => ({...o, brands: o.brands.map(b => b.toLowerCase())}));

// The one interpretation of a request that every stage works from: planning, discovery, exploration, screening,
// inspection, judging and presentation. The model drafts it; deterministic rules own dates, formats and syntax.
export const FORMATS = ['article', 'video', 'pdf', 'website', 'image', 'any'] as const;
export type Format = typeof FORMATS[number];
const format = z.enum(FORMATS);
const requirement = z.object({
 id: z.string().regex(/^R\d{1,2}$/), text: z.string().min(1).max(200),
 source_quote: z.string().max(500).optional(),
 evidence_kind: z.enum(['content', 'visual', 'provenance']).optional(),
 // "exclude": the request rules something out ("not from big news channels"); only evidence of it can fail a result.
 polarity: z.literal('exclude').optional(),
 kind: z.enum(['subject', 'format', 'date', 'duration', 'authority', 'completeness', 'property']),
 hardness: z.enum(['hard', 'preferred']), scope: z.enum(['each', 'set']), evidence: z.string().max(300),
 date_range: z.object({from: z.string(), to: z.string()}).optional(),
 // Seconds; either bound may be absent ("under 10 minutes" has only max).
 duration_range: z.object({min: z.number().optional(), max: z.number().optional()}).optional(),
 formats: z.array(format).optional(),
 authority: z.object({entity: z.string(), names: z.array(z.string()).max(6).optional(), domains: z.array(z.string())}).optional(),
 set_items: z.array(z.string().max(80)).max(12).optional(),
 access: z.literal('legitimate').optional(),
});
export type Requirement = z.infer<typeof requirement>;
const entity = z.object({name: z.string().min(1).max(120), kind: z.enum(['organisation', 'person', 'work', 'event', 'product', 'place', 'other'])});
export const contractSchema = z.object({
 version: z.literal('req-v1'), query: z.string(), search_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 intent: z.string().max(300), deliverable: z.object({formats: z.array(format), completeness: z.enum(['full', 'any'])}),
 requirements: z.array(requirement).max(12), entities: z.array(entity).max(8), exclusions: z.array(z.string()).max(10),
 ambiguities: z.array(z.string().max(200)).max(5), assumptions: z.array(z.string().max(200)).max(5),
 source: z.enum(['model', 'rules']),
});
export type RequirementsContract = z.infer<typeof contractSchema>;

// What the planner model may contribute. Every field is optional so a partial or older reply still yields a contract.
export const contractDraft = z.object({
 intent: z.string().max(300).optional(),
 completeness: z.enum(['full', 'any']).optional(),
 entities: z.array(entity).max(8).optional(),
 official_domains: z.array(z.string().max(100)).max(6).optional(),
 requirements: z.array(z.object({
   text: z.string().min(1).max(200), kind: z.enum(['subject', 'format', 'date', 'authority', 'completeness', 'property']),
   source_quote: z.string().max(500).optional(),
   hardness: z.enum(['hard', 'preferred']).default('preferred'), scope: z.enum(['each', 'set']).default('each'),
   evidence: z.string().max(300).default(''), set_items: z.array(z.string().max(80)).max(12).optional(),
 })).max(8).optional(),
 ambiguities: z.array(z.string().max(200)).max(5).optional(),
 assumptions: z.array(z.string().max(200)).max(5).optional(),
});
export type ContractDraft = z.infer<typeof contractDraft>;

// The planner's JSON schema for the draft, added to its existing reply.
export const DRAFT_SCHEMA = {
 intent: {type: 'string'},
 completeness: {type: 'string', enum: ['full', 'any']},
 entities: {type: 'array', items: {type: 'object', properties: {name: {type: 'string'},
   kind: {type: 'string', enum: ['organisation', 'person', 'work', 'event', 'product', 'place', 'other']}}, required: ['name', 'kind']}},
 official_domains: {type: 'array', items: {type: 'string'}},
 requirements: {type: 'array', items: {type: 'object', properties: {text: {type: 'string'},
   source_quote: {type: 'string', description: 'Exact words from the original request that require this property.'},
   kind: {type: 'string', enum: ['subject', 'format', 'date', 'authority', 'completeness', 'property']},
   hardness: {type: 'string', enum: ['hard', 'preferred']}, scope: {type: 'string', enum: ['each', 'set']},
   evidence: {type: 'string'}, set_items: {type: 'array', items: {type: 'string'}}}, required: ['text', 'source_quote', 'kind', 'hardness', 'scope', 'evidence', 'set_items']}},
 ambiguities: {type: 'array', items: {type: 'string'}},
 assumptions: {type: 'array', items: {type: 'string'}},
};
// Strict structured output (see openai-compatible.ts) only returns properties listed as required, so all of them are.
export const DRAFT_REQUIRED = Object.keys(DRAFT_SCHEMA);
export const DRAFT_INSTRUCTION =`Also describe the request as a contract: intent (one sentence), completeness ("full" only when the request asks for a whole work such as a complete book, paper, issue or document; otherwise "any"), entities it names, official_domains (web domains you believe the named organisation or product officially publishes on; they are checked before use), and requirements. Each requirement is one atomic, checkable property copied from the request: kind subject, property, authority or completeness (dates and file formats are handled separately); hardness "hard" only when the request states it as essential (for example "real", "official", "full"), otherwise "preferred"; scope "each" when every result must meet it, "set" when the results together must cover it (then list set_items, such as each organisation that must be represented); evidence states what would show a result meets it. Write each requirement's text in English, translating transliterated or non-English words (Hinglish "kaise kaam karta hai" is "explains how it works"), and never copy the whole request as one requirement. A year that identifies an event belongs in that event's requirement ("first Falcon Heavy launch (2018)"), not a requirement of its own. State an exclusion as "Not …". Never invent requirements the request does not state. Write each requirement as the outcome the request wants, not its exact wording, and name the equivalent wordings that meet it in its evidence: for "mr beast buys ps5 to a subscriber" the subject is "MrBeast gives a PS5 to a fan or subscriber" and buying, gifting, giving away or awarding it, to a subscriber, fan, viewer or follower, all count. A property only watching can confirm (slow motion, camera angle, background music, image quality) is "preferred" unless the request insists on it ("must", "only", "exactly"). List material ambiguities and the assumptions you made instead of asking.`;

const NUMBERS: Record<string,number> = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const years = (from: string, to: string) => {
 const out: string[] = [];
 for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)) && out.length < 12; y++) out.push(String(y));
 return out;
};

// Duration limits the request states in words, in seconds. A bare length ("10 minute abs workout") names the content
// rather than a limit, so only a comparison word or a range makes one.
const UNIT = String.raw`(seconds?|secs?|minutes?|mins?|hours?|hrs?)`, AMOUNT = String.raw`(\d+(?:\.\d+)?|an?|one)`;
const SECONDS: [RegExp, number][] = [[/^s/, 1], [/^m/, 60], [/^h/, 3600]];
const seconds = (amount: string, unit: string) => (/^\d/.test(amount) ? Number(amount) : 1) * SECONDS.find(([p]) => p.test(unit))![1];
export function resolveDuration(query: string): {text: string; min?: number; max?: number}|null {
 const q = query.toLowerCase();
 const range = new RegExp(String.raw`\bbetween\s+${AMOUNT}\s+and\s+${AMOUNT}\s+${UNIT}\b`).exec(q);
 if (range) return {text: range[0], min: seconds(range[1], range[3]), max: seconds(range[2], range[3])};
 const under = new RegExp(String.raw`\b(?:under|less than|shorter than|below|at most|no more than|up to|max(?:imum)?(?: of)?)\s+${AMOUNT}\s+${UNIT}\b`).exec(q);
 if (under) return {text: under[0], max: seconds(under[1], under[2])};
 const over = new RegExp(String.raw`\b(?:over|more than|longer than|at least|above|min(?:imum)?(?: of)?)\s+${AMOUNT}\s+${UNIT}\b`).exec(q);
 if (over) return {text: over[0], min: seconds(over[1], over[2])};
 return null;
}
const DURATION_WORDS = /\b(?:duration|runtime|length|long|minutes?|mins?|seconds?|secs?|hours?|hrs?)\b/i;

// Publication windows the request states in words, resolved against the search date. Bare years ("roswell 1947")
// usually name the event rather than a publication window, so they are left to the model as subject matter.
export function resolveDates(query: string, searchDate: string): {text: string; from: string; to: string}|null {
 const today = new Date(`${searchDate}T00:00:00Z`), q = query.toLowerCase();
 const relative = /\b(?:past|last|previous|recent)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a)\s+(year|month|week|day)s?\b/.exec(q);
 if (relative) {
   const n = NUMBERS[relative[1]] ?? Number(relative[1]), from = new Date(today);
   if (relative[2] === 'year') from.setUTCFullYear(from.getUTCFullYear() - n);
   else if (relative[2] === 'month') from.setUTCMonth(from.getUTCMonth() - n);
   else from.setUTCDate(from.getUTCDate() - n * (relative[2] === 'week' ? 7 : 1));
   return {text: relative[0], from: iso(from), to: searchDate};
 }
 const range = /\b(?:from|between)?\s*((?:19|20)\d{2})\s*(?:-|–|—|to|through|until|and)\s*((?:19|20)\d{2})\b/.exec(q);
 if (range && Number(range[2]) >= Number(range[1])) return {text: range[0].trim(), from: `${range[1]}-01-01`, to: `${range[2]}-12-31`};
 const since = /\bsince\s+((?:19|20)\d{2})\b/.exec(q);
 if (since) return {text: since[0], from: `${since[1]}-01-01`, to: searchDate};
 if (/\blast year\b/.test(q)) { const y = today.getUTCFullYear() - 1; return {text: 'last year', from: `${y}-01-01`, to: `${y}-12-31`}; }
 if (/\bthis year\b/.test(q)) return {text: 'this year', from: `${today.getUTCFullYear()}-01-01`, to: searchDate};
 return null;
}

const FORMAT_WORDS: [Format, RegExp][] = [
 ['article', /\b(?:articles?|news (?:story|stories|report)|blog posts?|essays?|write-?ups?)\b/],
 ['pdf', /\bpdfs?\b/],
 ['video', /\b(?:videos?|clips?|footages?|vlogs?|livestreams?)\b/],
 ['website', /\b(?:web ?sites?|web ?pages?|landing pages?|homepages?)\b/],
 ['image', /\b(?:images?|photos?|photographs?|pictures?|wallpapers?)\b/],
];
// Formats only from words the user wrote.
export function explicitFormats(query: string): Format[] {
 const q = query.toLowerCase();
 return FORMAT_WORDS.filter(([, pattern]) => pattern.test(q)).map(([f]) => f);
}
// "Websites" usually names the subject ("websites with 3D elements"), and a video presenting such sites still serves the
// request: making it a hard format once rejected every video for these queries (the relevance-v4 recall collapse).
export const siteOnly = (formats: Format[]) => formats.length > 0 && formats.every(f => f === 'website');
const FULL_WORK = /\b(?:full|complete|entire|whole)\s+(?:book|novel|text|paper|issue|document|magazine|journal)\b|\be-?books?\b/;

// A contract from the query's own words alone: used as the base for every contract and alone when planning fails.
export function rulesContract(query: string, searchDate: string, draft: ContractDraft = {}, source: 'model'|'rules' = 'rules'): RequirementsContract {
 const q = query.toLowerCase();
 const out: Omit<Requirement,'id'>[] = [];
 const formats = explicitFormats(query);
 if (formats.length) out.push({text: `Is ${formats.map(f => f === 'pdf' ? 'a PDF' : f === 'image' ? 'an image' : `a${f === 'article' ? 'n' : ''} ${f}`).join(' or ')}`,
   kind: 'format', hardness: siteOnly(formats) ? 'preferred' : 'hard', scope: 'each', formats,
   evidence: 'The inspected page or file is of this format (content type, page structure or video host).'});
 const dates = resolveDates(query, searchDate);
 if (dates) {
   out.push({text: `Published within ${dates.text} (${dates.from} to ${dates.to})`, kind: 'date', hardness: 'hard', scope: 'each',
     date_range: {from: dates.from, to: dates.to}, evidence: 'A publication date on the page, in its metadata or from the video platform.'});
   const items = years(dates.from, dates.to);
   if (items.length > 1) out.push({text: `Results together cover ${items[0]}–${items.at(-1)}`, kind: 'date', hardness: 'preferred', scope: 'set',
     date_range: {from: dates.from, to: dates.to}, set_items: items, evidence: 'At least one result dated in each year.'});
 }
 const duration = resolveDuration(query);
 if (duration) out.push({text: `Duration ${duration.text}`, kind: 'duration', hardness: 'hard', scope: 'each',
   duration_range: {...(duration.min !== undefined ? {min: duration.min} : {}), ...(duration.max !== undefined ? {max: duration.max} : {})},
   evidence: 'The duration from the video platform or the file.'});
 if (/\bofficial\b/.test(q)) {
   // When the request names several publishers ("official NASA, ESA and CSA sources"), any one of them is official.
   const listed = draft.requirements?.find(r => r.kind === 'authority' && r.scope === 'set' && r.set_items?.length)?.set_items;
   // Without a draft, the word the user put after "official" names the owner ("official whatsapp ..." → whatsapp).
   const said = /\bofficial\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N}&'-]*)/u.exec(query)?.[1];
   const names = listed?.length ? listed.slice(0, 6)
     : [draft.entities?.find(e => e.kind === 'organisation' || e.kind === 'product')?.name ?? said ?? 'the named organisation'];
   const owner = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
   // A brand's owning company publishes for it officially too (Meta for WhatsApp): see data/owning-companies.json.
   const owning = OWNERS.filter(o => names.some(n => o.brands.includes(n.toLowerCase())));
   const domains = [...(draft.official_domains ?? []).map(d => d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean),
     ...owning.flatMap(o => o.domains)];
   out.push({text: `From an official ${owner} source`, kind: 'authority', hardness: 'hard', scope: 'each',
     authority: {entity: owner, names: [...names, ...owning.map(o => o.owner)].slice(0, 6), domains: [...new Set(domains)]},
     evidence: `Published on a domain the page itself identifies as ${owner}'s.`});
 }
 const completeness = draft.completeness === 'full' || FULL_WORK.test(q) ? 'full' : 'any';
 if (completeness === 'full') out.push({text: 'The complete work, not a summary, review or excerpt', kind: 'completeness', hardness: 'hard', scope: 'each',
   access: 'legitimate', evidence: 'The page serves, sells, lends or licenses the full work through a legitimate store, library, subscription, open-access, publisher or public-domain source.'});
 for (const phrase of query.matchAll(/"([^"]{2,80})"/g)) out.push({text: `Mentions "${phrase[1]}"`, kind: 'subject', hardness: 'hard', scope: 'each',
   evidence: 'The phrase appears in the inspected content.'});
 // The model's own dates, formats and completeness are replaced by the rules above; authority only when "official" was said.
 for (const r of draft.requirements ?? []) {
   if (r.kind === 'date' || r.kind === 'format' || r.kind === 'completeness') continue;
   if (r.kind === 'authority' && !/\bofficial\b/.test(q)) continue;
   if (r.kind === 'authority' && r.scope === 'each') continue;
   // A set with nothing to cover checks nothing; a requirement restating the date phrase duplicates the rules' own.
   if (r.scope === 'set' && !r.set_items?.length) continue;
   if (dates && (resolveDates(r.text, searchDate) || r.text.toLowerCase().includes(dates.text))) continue;
   // The rules check a stated duration against the platform's figure; the model's restatement would need a quote.
   if (duration && DURATION_WORDS.test(r.text)) continue;
   out.push({text: r.text, kind: r.kind, hardness: r.hardness, scope: r.scope, evidence: r.evidence || 'Stated in the inspected content.',
     ...(r.source_quote && query.includes(r.source_quote) ? {source_quote: r.source_quote} : {}),
     ...(r.scope === 'set' && r.set_items?.length ? {set_items: r.set_items.slice(0, 12)} : {})});
 }
 const exclusions = [...new Set([...query.matchAll(/(?:^|\s)-(\w[\w'-]*)/g)].map(m => m[1].toLowerCase()))];
 const requirements = out.slice(0, 12).map((r, i) => ({...r, id: `R${i + 1}`}));
 return contractSchema.parse({version: 'req-v1', query, search_date: searchDate,
   intent: draft.intent?.trim() || query, deliverable: {formats: formats.length ? formats : ['any'], completeness},
   requirements, entities: draft.entities ?? [], exclusions, ambiguities: draft.ambiguities ?? [],
   assumptions: draft.assumptions ?? [], source});
}

// Normalise whatever the planner returned into a valid contract. An unusable draft degrades to the rules-only contract.
export function normaliseContract(query: string, searchDate: string, raw: unknown): RequirementsContract {
 const draft = contractDraft.safeParse(raw ?? {});
 return draft.success && Object.keys(draft.data).length ? rulesContract(query, searchDate, draft.data, 'model') : rulesContract(query, searchDate);
}

export const hardEach = (c: RequirementsContract) => c.requirements.filter(r => r.hardness === 'hard' && r.scope === 'each');
export const setRequirements = (c: RequirementsContract) => c.requirements.filter(r => r.scope === 'set');
// Plain-text criteria for components that predate the contract (trace, critic).
export const criteriaOf = (c: RequirementsContract) => hardEach(c).map(r => r.text).slice(0, 5);
