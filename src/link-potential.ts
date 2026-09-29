import { hardEach, type RequirementsContract } from './requirements.js';
import { STOPWORDS } from './ranking.js';

// Link potential (docs/superpowers/specs/2026-09-29-link-building-design.md): how likely a candidate is to link to the
// request once more evidence is fetched, from what is already known. It orders comment and caption fetches; it never
// decides relevance.
export type ScreenSignal = {choice: 'promising'|'uncertain'|'mismatch'; confidence: number; probabilities: {promising: number; uncertain: number; mismatch: number}};
export interface LinkInput { screen?: ScreenSignal; channel?: string|null; creators: string[]; comments: string[]; terms: string[] }
export interface LinkScore { value: number; base: number; creator: boolean; comment: boolean; capped: boolean }

// Channel names are compared without case, spaces or punctuation: "Mr Beast" is the channel "MrBeast".
export const foldName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(w => !STOPWORDS.has(w));

export function linkPotential(input: LinkInput): LinkScore {
 const p = input.screen?.probabilities;
 // Unscreened candidates sit just above the caption threshold, so a screener outage keeps today's order.
 const base = p ? p.promising + 0.5 * p.uncertain : 0.3;
 const channel = foldName(input.channel ?? '');
 const creator = channel.length >= 3 && input.creators.some(name => foldName(name) === channel);
 const terms = new Set(input.terms);
 // Two distinct requirement words in one comment: one shared word is usually just the topic.
 const comment = input.comments.some(c => new Set(words(c).filter(w => terms.has(w))).size >= 2);
 const capped = input.screen?.choice === 'mismatch' && input.screen.confidence >= 0.8;
 const raw = base + (creator ? 0.2 : 0) + (comment ? 0.15 : 0);
 const value = +Math.min(1, Math.max(0, capped ? Math.min(raw, 0.1) : raw)).toFixed(4);
 return {value, base: +base.toFixed(4), creator, comment, capped};
}

// Words that show a requirement is met: the hard requirements' text and evidence, or the query's own words without a contract.
export function requirementTerms(contract?: RequirementsContract, query = ''): string[] {
 return [...new Set(words(contract ? hardEach(contract).flatMap(r => [r.text, r.evidence ?? '']).join(' ') : query))];
}

// People and organisations the request names: the only channels link building ever searches on its own.
export function creatorNames(contract?: RequirementsContract): string[] {
 return (contract?.entities ?? []).filter(e => e.kind === 'person' || e.kind === 'organisation').map(e => e.name.trim()).filter(n => n.length >= 3);
}
