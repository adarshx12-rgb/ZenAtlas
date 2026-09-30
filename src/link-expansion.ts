import type { DB } from './db.js';
import type { Config } from './config.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { cleanDecision } from './refill.js';
import { foldName } from './link-potential.js';

// Link expansion (docs/superpowers/specs/2026-09-29-link-building-design.md): when screening leaves too few candidates
// that look strong, search once more before judging. The request's own words found the weak pool, so the new searches
// use the words videos use ("giveaway to a fan" for "to a subscriber"), plus the named creator's channel.

// Fewer than strongMin candidates with a base link potential of 0.5 or more; a minimum of 0 turns expansion off.
export const needsExpansion = (potentials: number[], strongMin: number) => strongMin > 0 && potentials.filter(p => p >= 0.5).length < strongMin;

export const creatorSearch = (name: string, terms: string[]) =>
 [`site:youtube.com "${name.replace(/"/g, '').trim()}"`, ...terms.slice(0, 4)].join(' ');

// "Mr Beast" is the channel "MrBeast"; "MrBeast Gaming" is another channel.
export const sameCreator = (channelTitle: string, name: string) => { const a = foldName(channelTitle); return a.length >= 3 && a === foldName(name); };

// found: the best candidates so far, "title — channel", whose words the new searches reuse.
export type LinkRewriter = (query: string, requirements: {id: string; text: string}[], ran: string[], found?: string[]) => Promise<string[]>;
const SCHEMA = {type: 'object', properties: {complete: {type: 'boolean'}, missing: {type: 'string'},
 searches: {type: 'array', items: {type: 'string'}}}, required: ['complete', 'missing', 'searches']};
const system = (max: number) => `A video search found too little for a request. Write up to ${max} new video searches (YouTube-style titles or
phrases) that would find videos meeting the requirements, in the words video titles and creators actually use rather than the
request's own words (for "to a subscriber" try "giveaway to a fan" or "surprising a viewer"). Each must differ from the searches
already run. titles_found lists the best candidates found so far: reuse words and names they use for this subject when
they fit the request, but add no details the request does not ask for. Plain search text only, no markup. Answer JSON
{"complete": false, "missing": string, "searches": [string]}.`;

// The planner's answer made safe to act on (src/refill.ts): at most max searches, trimmed, none empty or already run.
export function rewriterFrom(ask: (text: string) => Promise<unknown>, max: number): LinkRewriter {
 return async (query, requirements, ran, found = []) => cleanDecision(await ask(JSON.stringify({request: query, requirements, searches_already_run: ran,
   titles_found: found.slice(0, 10)})), ran, max).searches.map(q => q.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// The planner models, on the refill round's budget and time limit.
export function makeLinkRewriter(db: DB, config: Config): LinkRewriter|undefined {
 const models = config.PLANNER_MODELS.split(',').map(m => m.trim()).filter(Boolean);
 if (!config.REFILL_ENABLED || !config.OPENROUTER_API_KEY || !models.length || !config.LINK_EXPANSION_SEARCHES) return undefined;
 const client = new OpenAICompatibleClient(db, {...config, JUDGE_DAILY_BUDGET: config.REFILL_DAILY_BUDGET, JUDGE_TIMEOUT_MS: config.REFILL_TIMEOUT_MS}, models, undefined, 1024);
 return rewriterFrom(async text => (await client.json('refill_calls', system(config.LINK_EXPANSION_SEARCHES), text, SCHEMA)).value, config.LINK_EXPANSION_SEARCHES);
}
