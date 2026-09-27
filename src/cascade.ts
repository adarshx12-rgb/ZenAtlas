import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { ModelJudge, groundedQuote, judgeModels, TANGENTIAL, type Judge, type JudgeCandidate, type JudgeContext, type Verdict } from './judge.js';
import { snippetsOf, type JevRecord } from './jev-judge.js';
import { OpenAICompatibleClient } from './openai-compatible.js';

// The judge cascade (docs/superpowers/specs/2026-09-27-judge-cascade-design.md), in place of the council. Jev decides only
// on snippets cut verbatim from inspected content; the Scorer (the ordinary judge) scores the rest; each verdict is then
// flagged when it is uncertain, and one Strong judge re-judges only the flagged ones. Its verdict is final: no Chair.
// Confidence (Jev's or a model's) only routes work here; quotes are the only evidence.

export type Flag = 'borderline'|'conflicts_with_evidence'|'unbacked'|'jev_reject_unbacked'|'settle_audit';
export interface CascadeRecord { scorer: number; strong?: number; flags: Flag[] }
// border: Scorer relevance range the Strong judge re-checks (keep is relevance > 4). auditRate: share of Jev-settled
// verdicts still re-checked, to keep measuring settle precision. confidence: Jev's JEV_JUDGE_CONFIDENCE.
export interface CascadeOptions { border: [number, number]; auditRate: number; confidence: number; tier?: string; random?: () => number; log?: (line: Record<string, unknown>) => void }

// Measured on 2026-09-27 (scripts/judge-arch-bench.ts): flash-lite then terra on 4-7 matched or beat the council's
// accuracy at about 60% of its cost and time; a 4-6 band missed a confident 7 that was the wrong kind of video.
export const cascadeOptions = (config: Config): CascadeOptions =>
 ({border: [config.CASCADE_BORDER_LOW, config.CASCADE_BORDER_HIGH], auditRate: config.JEV_SETTLED_AUDIT_RATE, confidence: config.JEV_JUDGE_CONFIDENCE, tier: config.TIER});

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
 const jevMismatch = answers.some(a => a.choice === 'mismatch' && a.confidence >= options.confidence);
 // Jev's own decisions: a settle is snippet-backed by construction, so only a random audit re-checks it; a rejection
 // stands only when a snippet shows a requirement fails, not when it rests on Jev's low score and confidence alone.
 if (jev?.outcome === 'settled') return (options.random ?? Math.random)() < options.auditRate ? ['settle_audit'] : [];
 if (jev?.outcome === 'rejected') return jevMismatch ? [] : ['jev_reject_unbacked'];
 const out: Flag[] = [];
 if (v.relevance >= options.border[0] && v.relevance <= options.border[1]) out.push('borderline');
 const jevBacked = required > 0 && answers.length === required && answers.every(a => a.choice.startsWith('s') && a.confidence >= options.confidence);
 if ((jevMismatch && v.relevance > TANGENTIAL) || (jevBacked && v.relevance <= TANGENTIAL)) out.push('conflicts_with_evidence');
 // Scored above the border with a requirement no grounded quote supports: a hallucination or injected text is possible.
 // Only when there was content to quote from; a page nobody could read is not suspicious.
 const grounded = (v.requirementChecks ?? []).filter(ch => ch.status === 'supported' && groundedQuote(c, ch)).length;
 if (v.relevance > options.border[1] && required > 0 && grounded < required && snippetsOf(c).length) out.push('unbacked');
 return out;
}

const STRONG_BATCH = 5;
const STRONG_NOTE = 'A faster judge already scored these candidates, and each was flagged as uncertain: close to the keep line, '
 + 'in conflict with quoted evidence, or confident without quoted support. Judge each from its evidence yourself.';

export async function cascadeReview(query: string, candidates: JudgeCandidate[], scored: Map<string, Verdict>, jev: Map<string, unknown>|undefined,
 context: JudgeContext|undefined, screenshots: Map<string, Buffer>|undefined, strong: Judge|undefined, options: CascadeOptions) {
 const verdicts = new Map(scored), records = new Map<string, CascadeRecord>(), providers: ProviderStatus[] = [];
 const log = options.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`));
 const required = context?.requirements?.length ?? 0, flagged: JudgeCandidate[] = [], reasons: Record<string, number> = {};
 for (const c of candidates) {
   const v = scored.get(c.key);
   if (!v) continue;
   const flags = flagsFor(c, v, jev?.get(c.key) as JevRecord|undefined, required, options);
   records.set(c.key, {scorer: v.relevance, flags});
   if (flags.length) flagged.push(c);
   for (const f of flags) reasons[f] = (reasons[f] ?? 0) + 1;
 }
 let answered = 0, model: string|null = null;
 const started = Date.now();
 if (flagged.length && strong) {
   const strongContext: JudgeContext = {kind: context?.kind ?? 'mixed', ...context, criteria: [...(context?.criteria ?? []), STRONG_NOTE]};
   const done = await Promise.allSettled(Array.from({length: Math.ceil(flagged.length / STRONG_BATCH)}, (_, i) => flagged.slice(i * STRONG_BATCH, (i + 1) * STRONG_BATCH))
     .map(batch => strong.judge(query, batch, strongContext, screenshots)));
   for (const d of done) if (d.status === 'fulfilled') {
     model = d.value.model;
     for (const [key, v] of d.value.verdicts) { const record = records.get(key); if (!record?.flags.length) continue; verdicts.set(key, v); record.strong = v.relevance; answered++; }
   }
   if (answered < flagged.length) providers.push({provider: 'cascade', status: 'partial', message: 'Some uncertain results could not get a second check; they keep the first score.'});
 }
 log({event: 'cascade', tier: options.tier, judged: records.size, escalated: flagged.length, answered, reasons, strong: model, strong_ms: flagged.length && strong ? Date.now() - started : 0});
 return {verdicts, records, providers};
}
