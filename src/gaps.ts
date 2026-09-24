import { coverage, type Finding, type Gap } from './evidence.js';
import { resolveDates, type RequirementsContract } from './requirements.js';
import type { PlannedSearch, SearchTarget } from './planner.js';

// Exploration that works toward the requirements still unmet after the first retrieval and inspection. Gap searches
// are built from the contract (never written by a model); Jev only chooses which real candidates and links to open.
// Bounded by rounds, visits, searches and the deadline; stops once the gaps are covered or a round closes nothing.
export interface GapCandidate {
 url: string; title: string; description: string|null; published_at: string|null;
 from_url: string|null; context?: string; target: SearchTarget;
}
export interface KeyedGap extends Gap { key: string }
export interface GapDecision { url: string; gap: string|null; confidence: number }
export interface GapChooser {
 choose(contract: RequirementsContract, gaps: KeyedGap[], coverage: string[], candidates: GapCandidate[]): Promise<{decisions: GapDecision[]; failed_batches: number}>;
}
export interface Inspected { findings: Finding[]; links: {url: string; title: string}[]; title?: string|null; description?: string|null }
export interface GapTrace {
 initial_gaps: KeyedGap[];
 rounds: {gaps: string[]; searches: {query: string; target: SearchTarget; targets: string[]}[];
   visits: {url: string; from_url: string|null; targets: string[]; access: string; new_support: string[]}[]; decisions_failed: number}[];
 stop: 'covered'|'no_gain'|'rounds'|'visits'|'deadline'|'no_candidates';
 visits: number; searches: number; closed: string[]; coverage_gain_per_visit: number; elapsed_ms: number;
}
export interface GapOptions {
 contract: RequirementsContract;
 // Ranked leads from the first retrieval; the first initialInspect are inspected before gaps are measured.
 initial: GapCandidate[]; initialInspect: number;
 inspect(candidate: GapCandidate): Promise<Inspected>;
 // Runs searches and returns the candidates they found.
 search(searches: PlannedSearch[]): Promise<GapCandidate[]>;
 chooser?: GapChooser; rounds: number; visits: number; searches: number; target: number; deadline: number;
 // Addresses never to open (unauthorized hosts, scoped searches).
 skip(url: string): boolean;
 ran?: string[];
}

const keyOf = (g: Gap) => g.item ? `${g.requirement_id}:${g.item}` : g.requirement_id;
const keyed = (gaps: Gap[]): KeyedGap[] => gaps.map(g => ({...g, key: keyOf(g)}));
const STOP = new Set(['from', 'over', 'in', 'during', 'the', 'of', 'for', 'to', 'within', 'across', 'and', 'with', 'about', 'on']);
const FORMAT_TERMS = /\b(?:articles?|pdfs?|videos?|clips?|footages?|web ?sites?|web ?pages?|images?|photos?|pictures?)\b/gi;

// The request's own topic words, without the date phrase, format words or "official", which gap searches add back.
function core(contract: RequirementsContract): string {
 let q = contract.query.replace(/(?:^|\s)-\w[\w'-]*/g, ' ');
 const dates = resolveDates(q, contract.search_date);
 if (dates) q = q.replace(new RegExp(dates.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
 q = q.replace(FORMAT_TERMS, ' ').replace(/\bofficial\b/gi, ' ');
 const words = q.split(/\s+/).filter(Boolean);
 while (words.length && STOP.has(words.at(-1)!.toLowerCase())) words.pop();
 while (words.length && STOP.has(words[0].toLowerCase())) words.shift();
 return words.join(' ');
}
const cap = (q: string) => q.split(/\s+/).slice(0, 12).join(' ');

// Deterministic searches for the gaps, plain queries first, then domain-restricted variants.
export function gapSearches(contract: RequirementsContract, gaps: Gap[], ran: string[], limit: number): (PlannedSearch & {targets: string[]})[] {
 const topic = core(contract) || contract.query;
 const formats = contract.deliverable.formats;
 const target: SearchTarget = formats.length && formats.every(f => f === 'video') ? 'videos' : 'web';
 const domains = contract.requirements.flatMap(r => r.authority?.domains ?? []);
 const full = contract.deliverable.completeness === 'full';
 const work = contract.entities.find(e => e.kind === 'work')?.name ?? topic;
 const plain: [string, string][] = [], scoped: [string, string][] = [];
 for (const g of gaps) {
   const r = contract.requirements.find(x => x.id === g.requirement_id);
   if (!r) continue;
   const key = keyOf(g);
   if (r.kind === 'date' && g.item) { plain.push([`${topic} ${g.item}`, key]); if (domains[0]) scoped.push([`site:${domains[0]} ${topic} ${g.item}`, key]); }
   else if (r.kind === 'date' && r.date_range && !contract.requirements.some(x => x.scope === 'set' && x.kind === 'date')) plain.push([`${topic} ${r.date_range.to.slice(0, 4)}`, key]);
   else if (r.kind === 'authority' && g.item) plain.push([`${g.item} ${topic}`, key]);
   else if (r.kind === 'authority') scoped.push([domains[0] ? `site:${domains[0]} ${topic}` : `${topic} official`, key]);
   else if (r.kind === 'format' && !full) plain.push([`${topic} ${(r.formats ?? []).filter(f => f !== 'any')[0] ?? ''}`.trim(), key]);
   else if (r.kind === 'completeness') { plain.push([`${work} ebook`, key]); plain.push([`${work} library borrow`, key]); }
   else if (r.kind === 'subject' || r.kind === 'property') plain.push([`${topic} ${r.text}`, key]);
 }
 const seen = new Set(ran.map(q => q.toLowerCase()));
 const out: (PlannedSearch & {targets: string[]})[] = [];
 for (const [raw, key] of [...plain, ...scoped]) {
   const query = cap(raw), lower = query.toLowerCase();
   const existing = out.find(o => o.query.toLowerCase() === lower);
   if (existing) { if (!existing.targets.includes(key)) existing.targets.push(key); continue; }
   if (seen.has(lower) || out.length >= limit) continue;
   out.push({query, target, targets: [key]});
 }
 return out;
}

const summary = (contract: RequirementsContract, findings: Finding[], target: number) => {
 const c = coverage(contract, findings, target);
 return [...c.each.map(e => `${e.id}: ${e.supported} supported result(s) of ${target} wanted`),
   ...c.set.map(s => `${s.id} ${s.item}: ${s.covered ? 'covered' : 'missing'}`)];
};

export async function exploreGaps(o: GapOptions): Promise<{findings: Finding[]; trace: GapTrace; found: GapCandidate[]}> {
 const started = Date.now(), findings: Finding[] = [], visited = new Set<string>(), found: GapCandidate[] = [];
 const frontier = new Map<string, GapCandidate>();
 const ran = [...(o.ran ?? [])];
 const add = (c: GapCandidate) => { if (!visited.has(c.url) && !frontier.has(c.url) && !o.skip(c.url)) frontier.set(c.url, c); };
 const open = async (c: GapCandidate) => {
   visited.add(c.url); frontier.delete(c.url);
   const seen = await o.inspect(c).catch((): Inspected => ({findings: [], links: []}));
   findings.push(...seen.findings);
   for (const link of seen.links) add({url: link.url, title: link.title, description: null, published_at: null, from_url: c.url,
     context: `${seen.title ?? c.title}`.slice(0, 300), target: 'web'});
   return seen;
 };
 const trace: GapTrace = {initial_gaps: [], rounds: [], stop: 'rounds', visits: 0, searches: 0, closed: [], coverage_gain_per_visit: 0, elapsed_ms: 0};
 const finish = (stop: GapTrace['stop']) => {
   const now = new Set(keyed(coverage(o.contract, findings, o.target).gaps).map(g => g.key));
   trace.stop = stop; trace.closed = trace.initial_gaps.map(g => g.key).filter(k => !now.has(k));
   trace.coverage_gain_per_visit = trace.visits ? trace.closed.length / trace.visits : 0;
   trace.elapsed_ms = Date.now() - started;
   return {findings, trace, found};
 };
 const candidates = o.initial.filter(c => !o.skip(c.url));
 if (Date.now() > o.deadline) { trace.initial_gaps = keyed(coverage(o.contract, findings, o.target).gaps); return finish('deadline'); }
 await Promise.all(candidates.slice(0, o.initialInspect).map(open));
 for (const c of candidates.slice(o.initialInspect)) add(c);
 trace.initial_gaps = keyed(coverage(o.contract, findings, o.target).gaps);
 for (let round = 0; round < o.rounds; round++) {
   const gaps = keyed(coverage(o.contract, findings, o.target).gaps);
   if (!gaps.length) return finish('covered');
   if (Date.now() > o.deadline) return finish('deadline');
   if (trace.visits >= o.visits) return finish('visits');
   const entry: GapTrace['rounds'][number] = {gaps: gaps.map(g => g.key), searches: [], visits: [], decisions_failed: 0};
   trace.rounds.push(entry);
   const searches = gapSearches(o.contract, gaps, ran, o.searches);
   if (searches.length) {
     ran.push(...searches.map(s => s.query)); trace.searches += searches.length;
     entry.searches = searches.map(s => ({query: s.query, target: s.target, targets: s.targets}));
     const results = await o.search(searches.map(({query, target}) => ({query, target}))).catch(() => [] as GapCandidate[]);
     for (const c of results) { add(c); if (!found.some(f => f.url === c.url)) found.push(c); }
   }
   const pool = [...frontier.values()].slice(0, 40);
   if (!pool.length) return finish('no_candidates');
   let picks: {candidate: GapCandidate; targets: string[]}[];
   const choice = o.chooser ? await o.chooser.choose(o.contract, gaps, summary(o.contract, findings, o.target), pool).catch(() => null) : null;
   if (o.chooser && !choice) entry.decisions_failed = 1;
   else if (choice) entry.decisions_failed = choice.failed_batches;
   if (choice && choice.decisions.length) {
     const byUrl = new Map(pool.map(c => [c.url, c]));
     picks = choice.decisions.filter(d => d.gap && gaps.some(g => g.key === d.gap) && byUrl.has(d.url))
       .sort((a, b) => b.confidence - a.confidence).map(d => ({candidate: byUrl.get(d.url)!, targets: [d.gap!]}));
   } else if (choice) picks = [];
   // Without usable decisions, candidates are opened in their ranked order, aimed at every open gap.
   else picks = pool.map(c => ({candidate: c, targets: gaps.map(g => g.key)}));
   if (!picks.length) return finish('no_candidates');
   const slots = Math.min(o.visits - trace.visits, Math.ceil((o.visits - trace.visits) / (o.rounds - round)));
   const before = new Set(findings.filter(f => !f.provisional && f.status === 'supported').map(f => `${f.url}|${f.requirement_id}|${f.location.key ?? ''}`));
   const chosen = picks.slice(0, slots);
   trace.visits += chosen.length;
   await Promise.all(chosen.map(async ({candidate, targets}) => {
     const seen = await open(candidate);
     const fresh = seen.findings.filter(f => !f.provisional && f.status === 'supported' &&
       gaps.some(g => g.requirement_id === f.requirement_id && (!g.item || g.item.toLowerCase() === f.location.key?.toLowerCase())));
     entry.visits.push({url: candidate.url, from_url: candidate.from_url, targets,
       access: seen.findings[0]?.access ?? 'unavailable', new_support: [...new Set(fresh.map(f => f.location.key ? `${f.requirement_id}:${f.location.key}` : f.requirement_id))]});
   }));
   const gained = findings.some(f => !f.provisional && f.status === 'supported' && !before.has(`${f.url}|${f.requirement_id}|${f.location.key ?? ''}`) &&
     gaps.some(g => g.requirement_id === f.requirement_id && (!g.item || g.item.toLowerCase() === f.location.key?.toLowerCase())));
   if (!coverage(o.contract, findings, o.target).gaps.length) return finish('covered');
   if (!gained) return finish('no_gain');
 }
 return finish(trace.visits >= o.visits ? 'visits' : 'rounds');
}

