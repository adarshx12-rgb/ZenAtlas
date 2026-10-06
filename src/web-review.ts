import { learnFailed, learnFieldSources } from './field-routing.js';
import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { ProviderStatus } from './types.js';
import { PageChecker, pageTools, type PageCheck, type PageEvidence } from './pages.js';
import { makeJudge, type Judge } from './judge.js';
import { makeJevJudge } from './jev-judge.js';
import { makeScreener, type Screener } from './screener.js';
import { reviewResults, type ReviewOutcome } from './review.js';
import { makeCouncil, type CouncilSeats } from './council.js';
import { cascadeOptions, makeStrongJudge } from './cascade.js';
import { makeRefillPlanner, mergeReviewed, type RefillPlanner } from './refill.js';
import type { WebResult } from './web.js';
import { planContract, type ContractDeps } from './search-contract.js';
import {answerState, collectAnswerSources, generateAnswer, type CitedAnswer, type AnswerDeps} from './answer.js';

// The Web tab's relevance review, run in the background after /api/web answers with the search results. Every page is
// read (no browser); Jev analyses each page's text for relevance and accuracy and removes confident failures; every page
// that passes goes to the LLM judge, which removes what is tangential and orders the rest. The page polls
// /api/web/review with the token. Unreadable pages are judged on their title and snippet: many good sites block reads.

export interface WebReviewState { status: 'running'|'complete'; results: WebResult[]; removed: number; providers: ProviderStatus[]; answer?: CitedAnswer }
// refill: the planner's check of what was kept (null turns it off); fetch: runs its searches (web.ts passes the Brave search).
export type WebReviewDeps = ContractDeps & {judge?: Judge; pages?: PageCheck; screener?: Screener; council?: CouncilSeats|null; strong?: Judge|null;
 owner?: string; answer?: boolean; answerDeps?: AnswerDeps; originalQuery?: string;
 refill?: RefillPlanner|null; fetch?: (searches: string[]) => Promise<WebResult[]>; log?: (line: Record<string, unknown>) => void;
 // field: the request's field (src/field-routing.ts); the review's verdicts teach which sites answer it.
 // routed: the URLs that came from the field's specialist sites.
 field?: string|null; routed?: ReadonlySet<string>};
// New pages a refill may add to the review.
const REFILL_POOL = 20;
// A results page holds about 20 results, at most about 40: all are read and judged.
export const WEB_POOL = 40;
const READS = 6;
// Routed specialist pages start at this place at the earliest. Graded by hand (output/field-eval, 2026-10-04), the ones the
// judge put in the top five were model cards, act listings and court orders it scored high but searchers do not want first.
const ROUTED_FROM = 5;
export function holdBackRouted<T extends {url: string}>(results: T[], routed: ReadonlySet<string>): T[] {
 if (!routed.size) return results;
 const first = results.filter(r => !routed.has(r.url)).slice(0, ROUTED_FROM);
 return [...first, ...results.filter(r => !first.includes(r))];
}
const CRITERIA = ['A web page that itself answers, explains or provides what the request asks for',
 'When the request is ambiguous, a page that genuinely fits any reasonable reading matches',
 'Home pages, search or listing pages and link farms match only when the request asks for that site',
 "The page's information is accurate and trustworthy: prefer primary, specific, current sources. jev_check, when present, is a fast first reading (relevance 0-4, accuracy 0-1): advisory only"];

// Jev in gate mode in front of the LLM judge: Jev removes pages with grounded contradictions and, unless
// WEB_JEV_SETTLE, forwards even its confident matches.
export function webJudge(db: DB, config: Config): Judge|undefined {
 return makeJevJudge(db, {...config, JEV_JUDGE_REJECT: true}, makeJudge(db, config), {settle: config.WEB_JEV_SETTLE, accuracy: true});
}

export function webReviewMetrics(trace: ReviewOutcome<unknown>['trace']) {
 const outcome = (t: {jev?: unknown}) => (t.jev as {outcome?: string}|undefined)?.outcome;
 const settle = trace.filter(t => outcome(t) === 'would_settle');
 return {judged: trace.length, jev_rejected: trace.filter(t => outcome(t) === 'rejected').length, jev_would_settle: settle.length,
   settle_agreement: settle.length ? settle.filter(t => (t.relevance ?? 0) >= 7).length / settle.length : null};
}

export async function reviewWeb(db: DB, config: Config, query: string, results: WebResult[], deps: WebReviewDeps & {judge: Judge}) {
 const contract = await planContract(db, config, query, 'web', deps);
 const pages = deps.pages ?? new PageChecker(config, undefined, {...pageTools(config), renders: 0, evidence: config.ANSWER_ENABLED && deps.answer !== false});
 const evidence = new Map<string, PageEvidence>();
 const read = async (items: WebResult[]) => {
   const text = new Map<string, PageEvidence>();
   let timer: NodeJS.Timeout|undefined;
   await Promise.race([mapLimit(items, READS, async r => { const page = await pages.check(r.url).catch(() => null); if (page?.status === 'checked') text.set(r.url, page); }),
     new Promise(resolve => { timer = setTimeout(resolve, config.WEB_REVIEW_READ_MS); })]);
   clearTimeout(timer);
   for (const [url,page] of text) evidence.set(url,page);
   return new Map(text);
 };
 const plan = {noun: 'pages', contract, criteria: CRITERIA, textPool: WEB_POOL, reviewPool: WEB_POOL, read, judge: deps.judge,
   // A council passed in (tests) keeps the council; otherwise JUDGE_ARCHITECTURE picks the second stage.
   council: 'council' in deps ? deps.council : config.JUDGE_ARCHITECTURE === 'council' ? makeCouncil(db, config) : null,
   strong: 'strong' in deps ? deps.strong : 'council' in deps ? null : makeStrongJudge(db, config), cascade: cascadeOptions(config), councilTop: config.COUNCIL_CHECK_TOP, councilGap: config.COUNCIL_DISAGREEMENT, councilSure: config.COUNCIL_SURE_SCORE,
   screener: 'screener' in deps ? deps.screener : makeScreener(db, config), keepUnjudged: true,
   requirement: {text: `The page itself is what the request asks for: "${query.slice(0, 150)}" (its subject and intent as stated)`,
     evidence: 'The page text, title or snippet shows its subject.'}};
 const log = deps.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`));
 let out = await reviewResults(query, results, plan);
 // One line per review for tuning Jev (PM2 keeps it): counts only, never the query.
 log({event: 'web_review', tier: config.TIER, ...webReviewMetrics(out.trace)});
 // Refill: the planner checks what was kept against the request; its searches bring new pages, reviewed the same way.
 const refill = 'refill' in deps ? deps.refill : makeRefillPlanner(db, config);
 if (refill && deps.fetch) {
   const started = Date.now();
   const kept = out.results.filter(r => r.judgement).slice(0, 15)
     .map(r => ({title: r.title, host: r.source_name, relevance: r.judgement!.relevance, reason: r.judgement!.reason, missing: r.unmet_requirements}));
   const decision = await refill(query, kept, [query], contract).catch(() => null);
   let added = 0, fetched = 0;
   if (decision?.searches.length) {
     const seen = new Set(results.map(r => r.url));
     const fresh = (await deps.fetch(decision.searches).catch(() => [] as WebResult[]))
       .filter(r => !seen.has(r.url) && !!seen.add(r.url)).slice(0, REFILL_POOL);
     fetched = fresh.length;
     if (fresh.length) {
       const more = await reviewResults(query, fresh, plan);
       added = more.results.filter(r => r.judgement).length;
       out = {...out, results: mergeReviewed(query, out.results, more.results), removed: out.removed + more.removed, trace: [...out.trace, ...more.trace]};
     }
     out.providers.push({provider: 'refill', status: 'ok', message: `Looked again for what was missing${decision.missing ? ` (${decision.missing})` : ''}: `
       + `${decision.searches.length} ${decision.searches.length === 1 ? 'search' : 'searches'}, ${added} more ${added === 1 ? 'page' : 'pages'} kept.`});
   }
   log({event: 'refill', tier: config.TIER, tab: 'web', complete: decision?.complete ?? null, failed: !decision, searches: decision?.searches.length ?? 0,
     fetched, added, ms: Date.now() - started});
 }
 await learnFieldSources(db, deps.field ?? null, out.trace).catch(learnFailed);
 return {...out, evidence, results: holdBackRouted(out.results, deps.routed ?? new Set())};
}

// Reviews wait here by token for the page to poll, for ten minutes.
const reviews = new Map<string, {state: WebReviewState; expires: number; owner?: string; abort: AbortController}>();
const REVIEW_MS = 10 * 60_000, MAX_REVIEWS = 200, MAX_RUNNING = 4, MAX_ANSWERS = 4;
let running = 0, answering = 0;
export function webReviewState(token: string, owner?: string): WebReviewState|null {
 const review = reviews.get(token);
 return review && review.expires >= Date.now() && (!review.owner || review.owner===owner) ? review.state : null;
}
export function cancelWebAnswer(token: string, owner: string) {
 const review=reviews.get(token);
 if (!review || !webReviewState(token,owner)) return false;
 review.abort.abort();
 if (review.state.answer) review.state.answer=answerState('cancelled','Answer stopped.');
 return true;
}
export function webReviewSnapshot(state: WebReviewState): WebReviewState { return state; }

// Starts a review of one page of web results and returns its token; null when there is nothing to review or no judge.
export function startWebReview(db: DB, config: Config, query: string, results: WebResult[], deps: WebReviewDeps = {}): string|null {
 if (!config.WEB_REVIEW_ENABLED || !results.length) return null;
 const judge = 'judge' in deps ? deps.judge : webJudge(db, config);
 if (!judge) return null;
 const now = Date.now();
 for (const [token, r] of reviews) if (r.expires < now || reviews.size >= MAX_REVIEWS) { r.abort.abort(); reviews.delete(token); }
 const token = randomUUID();
 const state: WebReviewState = {status: 'running', results, removed: 0, providers: []};
 const abort=new AbortController();
 const summarize=config.ANSWER_ENABLED && deps.answer!==false && (!!config.OPENROUTER_API_KEY || !!deps.answerDeps);
 if (summarize) state.answer=answerState('reading','Reading sources for a cited answer…');
 reviews.set(token, {state, expires: now + REVIEW_MS, owner:deps.owner, abort});
 if (running >= MAX_RUNNING) {
   state.status = 'complete';
   state.providers.push({provider: 'web_review', status: 'unavailable', message: 'The server is busy; results were not checked for relevance.'});
   if (summarize) state.answer=answerState('unavailable','An answer could not be started. Search results are still available.');
   return token;
 }
 running++;
 void reviewWeb(db, config, query, results, {...deps, judge})
   .then(out => { Object.assign(state, {results:out.results, removed:out.removed, providers:out.providers}); return out; }, () => {
     state.providers.push({provider: 'web_review', status: 'unavailable', message: 'Relevance checking stopped early; results are shown in search order.'});
     if (summarize && !abort.signal.aborted) state.answer=answerState('unavailable','A checked answer could not be completed. Search results are still available.');
     return null;
   })
   // The review's slot is freed before the answer starts: answers have their own limit, so a slow answer never
   // leaves another search's results unchecked.
   .finally(() => { running--; state.status = 'complete'; })
   .then(async out => {
     if (!out || !summarize || abort.signal.aborted) return;
     if (answering >= MAX_ANSWERS) { state.answer=answerState('unavailable','An answer could not be started. Search results are still available.'); return; }
     answering++;
     try {
       const original=deps.originalQuery ?? query;
       const sources=collectAnswerSources(original,out.results,out.evidence,config.ANSWER_SOURCES,deps.routed);
       state.answer=await generateAnswer(db,config,original,sources,{signal:abort.signal,field:deps.field,routed:deps.routed,deps:deps.answerDeps,
         onStage:answer=>{state.answer=answer;}});
     } catch { state.answer=answerState('unavailable','A checked answer could not be completed. Search results are still available.'); }
     finally { answering--; }
   });
 return token;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
 let next = 0;
 await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (next < items.length) await fn(items[next++]); }));
}
