import type { DB } from './db.js';
import type { Config } from './config.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { cleanDecision } from './refill.js';
import { foldName } from './link-potential.js';
import type { AnswerPicture } from './planner.js';

// Link expansion (docs/superpowers/specs/2026-09-29-link-building-design.md): when screening leaves too few candidates
// that look strong, search once more before judging. The request's own words found the weak pool, so the new searches
// use the words videos use ("giveaway to a fan" for "to a subscriber"), plus the named creator's channel.

// Fewer than strongMin candidates with a base link potential of 0.5 or more; a minimum of 0 turns expansion off.
export const needsExpansion = (potentials: number[], strongMin: number) => strongMin > 0 && potentials.filter(p => p >= 0.5).length < strongMin;

export const creatorSearch = (name: string, terms: string[]) =>
 [`site:youtube.com "${name.replace(/"/g, '').trim()}"`, ...terms.slice(0, 4)].join(' ');

// "Mr Beast" is the channel "MrBeast"; "MrBeast Gaming" is another channel.
export const sameCreator = (channelTitle: string, name: string) => { const a = foldName(channelTitle); return a.length >= 3 && a === foldName(name); };

// found: the best candidates so far, "title — channel". target: the planner's picture of the answer (src/planner.ts).
// name: what the found titles show the request is about; discovery keeps it only when those titles carry it.
export type LinkRewriter = (query: string, requirements: {id: string; text: string}[], ran: string[], found?: string[], target?: AnswerPicture) =>
 Promise<{searches: string[]; name: string|null}>;
export const REWRITE_SCHEMA = {type: 'object', properties: {complete: {type: 'boolean'}, missing: {type: 'string'}, name: {type: 'string'},
 searches: {type: 'array', items: {type: 'string'}}}, required: ['complete', 'missing', 'name', 'searches']};
export const rewriteSystem = (max: number) => `A video search found too little for a request. Write up to ${max} new video searches (YouTube-style titles or
phrases) that would find videos meeting the requirements. picture is how the answer was imagined before searching; titles_found are
the best candidates the search really found. Prefer the words, names and channels titles_found use for this subject over the
request's own words (for "to a subscriber" the titles may say "surprises a fan"). Add no detail the request does not ask for.
Plain search text only, no markup. name: the film, show, song, game or creator the request is about, when the titles make it
clear, written as in the titles; never the title of one found video, and an empty string when unsure. Do not steer searches
toward one found video unless it clearly matches the request. Each search must differ from the searches already run. Answer JSON
{"complete": false, "missing": string, "name": string, "searches": [string]}.`;

// The planner's answer made safe to act on (src/refill.ts): at most max searches, trimmed, none empty or already run.
export function rewriterFrom(ask: (text: string) => Promise<unknown>, max: number): LinkRewriter {
 return async (query, requirements, ran, found = [], target) => {
   const raw = await ask(JSON.stringify({request: query, requirements, searches_already_run: ran, titles_found: found.slice(0, 10), ...(target ? {picture: target} : {})}));
   const name = raw && typeof raw === 'object' && typeof (raw as {name?: unknown}).name === 'string' ? (raw as {name: string}).name.trim().slice(0, 120) : '';
   return {name: name || null, searches: cleanDecision(raw, ran, max).searches.map(q => q.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean)};
 };
}

// The planner models, on the refill round's budget and time limit.
export function makeLinkRewriter(db: DB, config: Config): LinkRewriter|undefined {
 const models = config.PLANNER_MODELS.split(',').map(m => m.trim()).filter(Boolean);
 if (!config.REFILL_ENABLED || !config.OPENROUTER_API_KEY || !models.length || !config.LINK_EXPANSION_SEARCHES) return undefined;
 const client = new OpenAICompatibleClient(db, {...config, JUDGE_DAILY_BUDGET: config.REFILL_DAILY_BUDGET, JUDGE_TIMEOUT_MS: config.REFILL_TIMEOUT_MS}, models, undefined, 1024);
 return rewriterFrom(async text => (await client.json('refill_calls', rewriteSystem(config.LINK_EXPANSION_SEARCHES), text, REWRITE_SCHEMA)).value, config.LINK_EXPANSION_SEARCHES);
}
