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

// The Web tab's relevance review, run in the background after /api/web answers with the search results. Every page is
// read (no browser); Jev analyses each page's text for relevance and accuracy and removes confident failures; every page
// that passes goes to the LLM judge, which removes what is tangential and orders the rest. The page polls
// /api/web/review with the token. Unreadable pages are judged on their title and snippet: many good sites block reads.

export interface WebReviewState { status: 'running'|'complete'; results: WebResult[]; removed: number; providers: ProviderStatus[] }
// refill: the planner's check of what was kept (null turns it off); fetch: runs its searches (web.ts passes the Brave search).
export type WebReviewDeps = {judge?: Judge; pages?: PageCheck; screener?: Screener; council?: CouncilSeats|null; strong?: Judge|null;
 refill?: RefillPlanner|null; fetch?: (searches: string[]) => Promise<WebResult[]>; log?: (line: Record<string, unknown>) => void};
// New pages a refill may add to the review.
const REFILL_POOL = 20;
// A results page holds about 20 results, at most about 40: all are read and judged.
const WEB_POOL = 40, READS = 6;
const CRITERIA = ['A web page that itself answers, explains or provides what the request asks for',
 'When the request is ambiguous, a page that genuinely fits any reasonable reading matches',
 'Home pages, search or listing pages and link farms match only when the request asks for that site',
 "The page's information is accurate and trustworthy: prefer primary, specific, current sources. jev_check, when present, is a fast first reading (relevance 0-4, accuracy 0-1): advisory only"];

// Jev in gate mode in front of the LLM judge: Jev removes pages that confidently miss or look unreliable and, unless
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
 const pages = deps.pages ?? new PageChecker(config, undefined, {...pageTools(config), renders: 0});
 const read = async (items: WebResult[]) => {
   const text = new Map<string, PageEvidence>();
   let timer: NodeJS.Timeout|undefined;
   await Promise.race([mapLimit(items, READS, async r => { const page = await pages.check(r.url).catch(() => null); if (page?.status === 'checked') text.set(r.url, page); }),
     new Promise(resolve => { timer = setTimeout(resolve, config.WEB_REVIEW_READ_MS); })]);
   clearTimeout(timer);
   return new Map(text);
 };
 const plan = {noun: 'pages', criteria: CRITERIA, textPool: WEB_POOL, reviewPool: WEB_POOL, read, judge: deps.judge,
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
     .map(r => ({title: r.title, host: r.source_name, relevance: r.judgement!.relevance, reason: r.judgement!.reason}));
   const decision = await refill(query, kept, [query]).catch(() => null);
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
 return out;
}

// Reviews wait here by token for the page to poll, for ten minutes.
const reviews = new Map<string, {state: WebReviewState; expires: number}>();
const REVIEW_MS = 10 * 60_000, MAX_REVIEWS = 200, MAX_RUNNING = 4;
let running = 0;
export function webReviewState(token: string): WebReviewState|null {
 const review = reviews.get(token);
 return review && review.expires >= Date.now() ? review.state : null;
}
export function webReviewSnapshot(state: WebReviewState): WebReviewState { return state; }

// Starts a review of one page of web results and returns its token; null when there is nothing to review or no judge.
export function startWebReview(db: DB, config: Config, query: string, results: WebResult[], deps: WebReviewDeps = {}): string|null {
 if (!config.WEB_REVIEW_ENABLED || !results.length) return null;
 const judge = 'judge' in deps ? deps.judge : webJudge(db, config);
 if (!judge) return null;
 const now = Date.now();
 for (const [token, r] of reviews) if (r.expires < now || reviews.size >= MAX_REVIEWS) reviews.delete(token);
 const token = randomUUID();
 const state: WebReviewState = {status: 'running', results, removed: 0, providers: []};
 reviews.set(token, {state, expires: now + REVIEW_MS});
 if (running >= MAX_RUNNING) {
   state.status = 'complete';
   state.providers.push({provider: 'web_review', status: 'unavailable', message: 'The server is busy; results were not checked for relevance.'});
   return token;
 }
 running++;
 void reviewWeb(db, config, query, results, {...deps, judge})
   .then(out => Object.assign(state, {results: out.results, removed: out.removed, providers: out.providers}))
   .catch(() => state.providers.push({provider: 'web_review', status: 'unavailable', message: 'Relevance checking stopped early; results are shown in search order.'}))
   .finally(() => { running--; state.status = 'complete'; });
 return token;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
 let next = 0;
 await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (next < items.length) await fn(items[next++]); }));
}
