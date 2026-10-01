import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import { ModelJudge, groundedQuote, eligibleCheck, enforceRequirements, judgeModels, TANGENTIAL, type Judge, type JudgeCandidate, type JudgeContext, type Verdict } from './judge.js';
import { snippetsOf, type JevRecord } from './jev-judge.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { traceFields } from './search-trace.js';
import { requirementNeeds } from './search-contract.js';
import { judgeBatches } from './transcript-passages.js';

// The judge cascade (docs/superpowers/specs/2026-09-27-judge-cascade-design.md), in place of the council. Jev decides only
// on snippets cut verbatim from inspected content; the Scorer (the ordinary judge) scores the rest; each verdict is then
// flagged when it is uncertain, and one Strong judge re-judges only the flagged ones. Its verdict is final: no Chair.
// Confidence (Jev's or a model's) only routes work here; quotes are the only evidence.

export type Flag = 'borderline'|'conflicts_with_evidence'|'unbacked'|'jev_reject_unbacked'|'settle_audit'|'reject_audit'|'needs_evidence'|'interpretation';
export interface CascadeRecord { scorer: number; strong?: number; flags: Flag[]; missing?: string[]; inspected?: boolean; model?: string }
// border: Scorer relevance range the Strong judge re-checks (keep is relevance > 4). auditRate: share of Jev-settled
// verdicts still re-checked, to keep measuring settle precision. confidence: Jev's JEV_JUDGE_CONFIDENCE.
export interface CascadeOptions { border: [number, number]; auditRate: number; confidence: number; tier?: string; random?: () => number; log?: (line: Record<string, unknown>) => void;
 traceId?: string; requirements?: JudgeContext['requirements']; inspectionLimit?: number; inspectionMs?: number;
 // batchChars: transcript characters per Strong judge call; whole transcripts made batches of five too slow (spec 2026-09-29-link-building).
 batchChars?: number;
 inspection?: {judge: Judge; inspect: (candidate: JudgeCandidate, missing: string[], signal: AbortSignal) => Promise<JudgeCandidate|null>} }

// Retain the prior benchmark's 4-7 band: a 4-6 band missed a confident 7 that was the wrong kind of video.
// Those historical measurements predate evidence-v2; the new routing needs its own live quality/cost evaluation.
export const cascadeOptions = (config: Config): CascadeOptions =>
 ({border: [config.CASCADE_BORDER_LOW, config.CASCADE_BORDER_HIGH], auditRate: config.JEV_SETTLED_AUDIT_RATE, confidence: config.JEV_JUDGE_CONFIDENCE, tier: config.TIER,
   inspectionLimit: config.CASCADE_INSPECTION_LIMIT, inspectionMs: config.CASCADE_INSPECTION_MS, batchChars: Math.floor(config.LINK_BATCH_CHARS / 2)});

const list = (value: string) => [...new Set(value.split(',').map(m => m.trim()).filter(Boolean))];

// The Strong judge: its own models, budget and time limit. A second opinion from the Scorer's own model is none, so the
// Scorer's main model is left out (its backups may stay: in SSJ1 the Scorer's backups include the Strong judge's model).
export function makeStrongJudge(db: DB, config: Config): Judge|undefined {
 if (config.JUDGE_ARCHITECTURE !== 'cascade' || !config.OPENROUTER_API_KEY) return undefined;
 const scorer = judgeModels(config)[0], models = list(config.CASCADE_STRONG_MODELS).filter(m => m !== scorer);
 return models.length ? new ModelJudge(new OpenAICompatibleClient(db, {...config, JUDGE_DAILY_BUDGET: config.CASCADE_STRONG_DAILY_BUDGET,
   JUDGE_TIMEOUT_MS: config.CASCADE_STRONG_TIMEOUT_MS}, models, undefined, 8192), config, 'cascade_strong_calls') : undefined;
}

// Why a verdict needs the Strong judge; none means it stands. required: how many requirements the request carries.
export function flagsFor(c: JudgeCandidate, v: Verdict, jev: JevRecord|undefined, required: number, options: CascadeOptions): Flag[] {
 const answers = Object.values(jev?.requirements ?? {});
 const backed = (a: typeof answers[number]) => !!a.check && a.confidence >= options.confidence && eligibleCheck(c, a.check, options.requirements?.find(r => r.id === a.check!.id));
 const jevMismatch = answers.some(a => a.check?.status === 'mismatch' && backed(a));
 // Jev's own decisions: a settle is snippet-backed by construction, so only a random audit re-checks it; a rejection
 // stands only when a snippet shows a requirement fails, not when it rests on Jev's low score and confidence alone.
 if (jev?.outcome === 'settled' && answers.length === required && answers.every(a => a.check?.status === 'supported' && backed(a)))
   return (options.random ?? Math.random)() < options.auditRate ? ['settle_audit'] : [];
 if (jev?.outcome === 'rejected' && jevMismatch) return (options.random ?? Math.random)() < options.auditRate ? ['reject_audit'] : [];
 const out: Flag[] = [];
 const jevBacked = required > 0 && answers.length === required && answers.every(a => a.check?.status === 'supported' && backed(a));
 if ((jevMismatch && v.relevance > TANGENTIAL) || (jevBacked && v.relevance <= TANGENTIAL)) out.push('conflicts_with_evidence');
 if (!out.length && (inspectionRequirements(c, v, options.requirements).length ||
   v.relevance > TANGENTIAL && !c.visual && !snippetsOf(c).length)) return ['needs_evidence'];
 if (missingRequirements(c, v, options.requirements).length) out.push('interpretation');
 if (jev?.outcome === 'rejected' && !jevMismatch) out.push('jev_reject_unbacked');
 if (v.relevance >= options.border[0] && v.relevance <= options.border[1]) out.push('borderline');
 // Scored above the border with a requirement no grounded quote supports: a hallucination or injected text is possible.
 // Only when there was content to quote from; a page nobody could read is not suspicious.
 const grounded = (v.requirementChecks ?? []).filter(ch => ch.status === 'supported' && groundedQuote(c, ch)).length;
 if (v.relevance > options.border[1] && required > 0 && grounded < required && snippetsOf(c).length) out.push('unbacked');
 return out;
}

export function missingRequirements(c: JudgeCandidate, v: Verdict, requirements: JudgeContext['requirements']): string[] {
 if (v.requirementChecks?.some(ch => ch.status === 'mismatch' && eligibleCheck(c, ch, requirements?.find(r => r.id === ch.id)))) return [];
 return (requirements ?? []).filter(r => {
   const check = v.requirementChecks?.find(ch => ch.id === r.id);
   // As in enforceRequirements: an unchecked content exclusion is reported, not missing evidence.
   if ((!check || check.status === 'unknown') && r.polarity === 'exclude' && requirementNeeds(r) === 'content') return false;
   return !check || check.status === 'unknown' || !eligibleCheck(c, check, r);
 }).map(r => r.id);
}

function inspectionRequirements(c: JudgeCandidate, v: Verdict, requirements: JudgeContext['requirements']): string[] {
 return missingRequirements(c, v, requirements).filter(id => {
   const check = v.requirementChecks?.find(ch => ch.id === id);
   // A cheap model cannot send empty or fabricated evidence to Strong by merely asking for more reasoning.
   return check?.next_action !== 'reason' || !eligibleCheck(c, {...check, status: 'supported'}, requirements?.find(r => r.id === id));
 });
}

export const evidenceFingerprint = (c: JudgeCandidate) => createHash('sha256').update(JSON.stringify({
 page: c.page, description: c.description, description_source: c.description_source, comments: c.comments, moments: c.moments,
 transcripts: c.transcripts, scenes: c.scenes, inspected: c.inspected, visual: c.visual, provenance: c.provenance, facts: c.facts,
})).digest('hex');

const STRONG_BATCH = 5;
const STRONG_NOTE = 'A faster judge already scored these candidates, and each was flagged as uncertain: close to the keep line, '
 + 'in conflict with quoted evidence, or confident without quoted support. Judge each from its evidence yourself.';

export async function cascadeReview(query: string, candidates: JudgeCandidate[], scored: Map<string, Verdict>, jev: Map<string, unknown>|undefined,
 context: JudgeContext|undefined, screenshots: Map<string, Buffer>|undefined, strong: Judge|undefined, options: CascadeOptions) {
 const verdicts = new Map(scored), records = new Map<string, CascadeRecord>(), providers: ProviderStatus[] = [];
 const log = options.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`));
 const required = context?.requirements?.length ?? 0, reasons: Record<string, number> = {};
 const current = new Map(candidates.map(c => [c.key, c]));
 const reading = new Map(jev), traceId = options.traceId ?? traceFields().trace_id ?? randomUUID();
 const routing = {...options, requirements: context?.requirements};
 for (const c of candidates) {
   const v = verdicts.get(c.key);
   if (v) verdicts.set(c.key, enforceRequirements(c, v, context?.requirements));
 }
 const needing = candidates.filter(c => {
   const v = verdicts.get(c.key);
   return v && flagsFor(c, v, reading.get(c.key) as JevRecord|undefined, required, routing).includes('needs_evidence');
 }).slice(0, options.inspectionLimit ?? 3);
 let inspections = 0, refreshed = 0, answered = 0, escalated = 0, model: string|null = null;
 const started = Date.now();
 const strongContext: JudgeContext = {kind: context?.kind ?? 'mixed', ...context, criteria: [...(context?.criteria ?? []), STRONG_NOTE]};
 // A candidate's final routing: a record, its reasons, and either a cap (it still needs evidence), a place in a Strong
 // batch (flagged), or nothing (its score stands).
 const route = (c: JudgeCandidate): JudgeCandidate|null => {
   const v = verdicts.get(c.key);
   if (!v) return null;
   const flags = flagsFor(c, v, reading.get(c.key) as JevRecord|undefined, required, routing);
   const missing = missingRequirements(c, v, context?.requirements);
   records.set(c.key, {scorer: v.relevance, flags, missing, inspected: c !== candidates.find(x => x.key === c.key)});
   for (const f of flags) reasons[f] = (reasons[f] ?? 0) + 1;
   if (flags.includes('needs_evidence')) { verdicts.set(c.key, {...v, relevance: Math.min(v.relevance, 5)}); return null; }
   if (!flags.length) return null;
   escalated++;
   return {...c, review_focus: {flags, requirements: missing.length ? missing : (context?.requirements ?? []).map(r => r.id)}};
 };
 const review = async (flagged: JudgeCandidate[]) => {
   if (!flagged.length || !strong) return;
   const done = await Promise.allSettled(judgeBatches(flagged, STRONG_BATCH, options.batchChars ?? Infinity)
     .map(batch => strong.judge(query, batch, strongContext, screenshots)));
   for (const d of done) if (d.status === 'fulfilled') {
     model = d.value.model;
     for (const [key, v] of d.value.verdicts) { const record = records.get(key); if (!record?.flags.length || record.flags.includes('needs_evidence')) continue;
       const final = enforceRequirements(current.get(key)!, v, context?.requirements);
       verdicts.set(key, final); record.strong = final.relevance; record.model = d.value.model; answered++; }
   }
 };
 // Candidates needing no inspection are routed now and the Strong judge starts on them while inspections run; an
 // inspected candidate is routed after its re-judge and gets its own Strong check if it is still uncertain.
 const waiting = new Set(options.inspection ? needing.map(c => c.key) : []);
 const now = review(candidates.filter(c => !waiting.has(c.key)).flatMap(c => { const r = route(c); return r ? [r] : []; }));
 const later = options.inspection ? Promise.all(needing.map(async c => {
   inspections++;
   const abort = new AbortController();
   let timer: NodeJS.Timeout|undefined;
   try {
     const next = await Promise.race([options.inspection!.inspect(c, missingRequirements(c, verdicts.get(c.key)!, context?.requirements), abort.signal),
       new Promise<null>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(null); }, options.inspectionMs ?? 8000); })]);
     if (next && next.key === c.key && next.url === c.url && evidenceFingerprint(next) !== evidenceFingerprint(c)) {
       current.set(c.key, next); refreshed++;
       const out = await options.inspection!.judge.judge(query, [next], context, screenshots);
       const v = out.verdicts.get(c.key);
       if (v) verdicts.set(c.key, enforceRequirements(next, v, context?.requirements));
       reading.delete(c.key);
       if (out.jev?.has(c.key)) reading.set(c.key, out.jev.get(c.key));
     }
   } catch { /* Inspection failure leaves a possible lead, not a confident rejection. */ }
   finally { clearTimeout(timer); abort.abort(); }
   const r = route(current.get(c.key)!);
   if (r) await review([r]);
 })) : Promise.resolve([]);
 await Promise.all([now, later]);
 if (strong && answered < escalated) providers.push({provider: 'cascade', status: 'partial', message: 'Some uncertain results could not get a second check; they keep the first score.'});
 log({event: 'cascade', version: 'evidence-v2', trace_id: traceId, tier: options.tier, judged: records.size, escalated, answered, inspections, refreshed, reasons, strong: model, strong_ms: escalated && strong ? Date.now() - started : 0,
   candidates: [...records].map(([key, record]) => ({key, evidence_hash: evidenceFingerprint(current.get(key)!), ...record}))});
 return {verdicts, records, providers, candidates: [...current.values()], jev: reading};
}
