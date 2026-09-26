import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { ModelJudge, judgeModels, type Judge, type JudgeCandidate, type JudgeContext, type Verdict } from './judge.js';
import { OpenAICompatibleClient } from './openai-compatible.js';

// The judge council (docs/superpowers/specs/2026-09-26-judge-council-design.md). After the Scorer (the ordinary batched
// judge) has scored every candidate, a Checker from another provider re-scores the top ones without seeing those
// verdicts, and a Chair decides only where the two disagree. All seats share one prompt and scale (ModelJudge), so the
// final ranking stays consistent. Every seat has its own fallback models and its own daily budget.

export interface CouncilSeats { checker?: Judge; chair?: Judge }
export interface CouncilRecord { scorer: number; checker?: number; chair?: number; disputed: boolean }
export interface CouncilOptions { top: number; disagreement?: number; log?: (line: Record<string, unknown>) => void }
// Small batches in parallel: measured on 2026-09-26, the Checker answers 5 candidates in about 16 s but timed out on 15
// in one call, and the Chair (which reasons first) timed out on 6-10 disputes at once.
const CHECK_BATCH = 5, CHAIR_BATCH = 3;
async function inBatches(judge: Judge, query: string, list: JudgeCandidate[], size: number, context: JudgeContext|undefined,
 screenshots: Map<string, Buffer>|undefined) {
 const verdicts = new Map<string, Verdict>(); let model: string|null = null;
 const settled = await Promise.allSettled(Array.from({length: Math.ceil(list.length / size)}, (_, i) => list.slice(i * size, (i + 1) * size))
   .map(batch => judge.judge(query, batch, context, screenshots)));
 for (const s of settled) if (s.status === 'fulfilled') { model = s.value.model; for (const [k, v] of s.value.verdicts) verdicts.set(k, v); }
 return {verdicts, model, failed: settled.every(s => s.status === 'rejected')};
}

const list = (value: string) => [...new Set(value.split(',').map(m => m.trim()).filter(Boolean))];

export function makeCouncil(db: DB, config: Config): CouncilSeats|null {
 if (!config.COUNCIL_ENABLED || !config.OPENROUTER_API_KEY) return null;
 // A second opinion from the model that gave the first is no second opinion.
 const scorer = new Set(judgeModels(config));
 const checkers = list(config.COUNCIL_CHECKER_MODELS).filter(m => !scorer.has(m)), chairs = list(config.COUNCIL_CHAIR_MODELS);
 // Each seat has its own budget and time limit: the Checker judges up to 15 candidates in one call, and the Chair reasons
 // before answering (Sonnet 5 thinks adaptively), so both get longer than a batch of the Scorer.
 const seat = (models: string[], bucket: string, budget: number, timeout: number, maxTokens: number) => models.length
   ? new ModelJudge(new OpenAICompatibleClient(db, {...config, JUDGE_DAILY_BUDGET: budget, JUDGE_TIMEOUT_MS: timeout}, models, undefined, maxTokens), config, bucket)
   : undefined;
 return {checker: seat(checkers, 'council_checker_calls', config.COUNCIL_CHECKER_DAILY_BUDGET, config.COUNCIL_CHECKER_TIMEOUT_MS, 8192),
   chair: seat(chairs, 'council_chair_calls', config.COUNCIL_CHAIR_DAILY_BUDGET, config.COUNCIL_CHAIR_TIMEOUT_MS, 16000)};
}

const mismatch = (v: Verdict) => !!v.intentChecks?.some(c => c.status === 'mismatch');
// Two verdicts disagree when their scores are far apart, when only one finds the candidate misses the request, or when
// one confirms a requirement the other finds violated.
export function disputed(a: Verdict, b: Verdict, gap: number): boolean {
 if (Math.abs(a.relevance - b.relevance) >= gap || mismatch(a) !== mismatch(b)) return true;
 const status = (v: Verdict) => new Map((v.requirementChecks ?? []).map(r => [r.id, r.status]));
 const sa = status(a), sb = status(b);
 return [...sa].some(([id, s]) => { const t = sb.get(id); return (s === 'supported' && t === 'mismatch') || (s === 'mismatch' && t === 'supported'); });
}

const CHAIR_NOTE = 'Two judges scored each of these candidates independently and disagreed; their verdicts are in its council field. '
 + 'Decide from the evidence yourself: the verdicts are opinions to check, not evidence, and neither is right by default.';

export async function councilReview(query: string, candidates: JudgeCandidate[], scored: Map<string, Verdict>, context: JudgeContext|undefined,
 screenshots: Map<string, Buffer>|undefined, seats: CouncilSeats, options: CouncilOptions) {
 const verdicts = new Map(scored), records = new Map<string, CouncilRecord>(), providers: ProviderStatus[] = [];
 const log = options.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`));
 const byKey = new Map(candidates.map(c => [c.key, c]));
 const top = [...scored.values()].filter(v => v.relevance >= 3 && byKey.has(v.key))
   .sort((a, b) => b.relevance - a.relevance).slice(0, options.top).map(v => byKey.get(v.key)!);
 if (!seats.checker || !top.length) return {verdicts, records, providers};
 const started = Date.now();
 const checked = await inBatches(seats.checker, query, top, CHECK_BATCH, context, screenshots);
 const checkerMs = Date.now() - started;
 const second = checked.verdicts, checkerModel = checked.model;
 if (checked.failed) {
   providers.push({provider: 'council', status: 'partial', message: 'The second relevance check was unavailable; results were checked by one judge.'});
   return {verdicts, records, providers};
 }
 const gap = options.disagreement ?? 2, disputes: JudgeCandidate[] = [];
 for (const c of top) {
   const a = scored.get(c.key)!, b = second.get(c.key);
   if (!b) continue;
   if (disputed(a, b, gap)) {
     records.set(c.key, {scorer: a.relevance, checker: b.relevance, disputed: true});
     disputes.push({...c, council: {first: {relevance: a.relevance, reason: a.reason}, second: {relevance: b.relevance, reason: b.reason}}});
   } else {
     records.set(c.key, {scorer: a.relevance, checker: b.relevance, disputed: false});
     verdicts.set(c.key, {...a, relevance: Math.floor((a.relevance + b.relevance) / 2)});
   }
 }
 let chaired = 0, chairModel: string|null = null;
 const chairStarted = Date.now();
 if (disputes.length) {
   const chairContext: JudgeContext = {kind: context?.kind ?? 'mixed', ...context, criteria: [...(context?.criteria ?? []), CHAIR_NOTE]};
   const decided = seats.chair ? await inBatches(seats.chair, query, disputes, CHAIR_BATCH, chairContext, screenshots) : null;
   chairModel = decided?.model ?? null;
   for (const c of disputes) {
     const final = decided?.verdicts.get(c.key), record = records.get(c.key)!;
     if (final) { verdicts.set(c.key, final); record.chair = final.relevance; chaired++; continue; }
     // No Chair: the more cautious of the two verdicts stands.
     const a = scored.get(c.key)!, b = second.get(c.key)!, low = a.relevance <= b.relevance ? a : b;
     verdicts.set(c.key, {...low, reason: `${low.reason} Judges disagreed; the more cautious score was kept.`});
   }
   if (!decided || decided.failed) providers.push({provider: 'council', status: 'partial', message: 'The deciding judge was unavailable; disputed results keep the more cautious score.'});
 }
 const opinions = [...records.values()];
 log({event: 'council', checked: opinions.length, disputed: disputes.length, chaired,
   agreement: opinions.length ? opinions.filter(r => !r.disputed).length / opinions.length : null, checker: checkerModel, chair: chairModel,
   checker_ms: checkerMs, chair_ms: disputes.length ? Date.now() - chairStarted : 0});
 return {verdicts, records, providers};
}
