import type { DB } from './db.js';
import type { Config } from './config.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { contractDraft, DRAFT_INSTRUCTION, DRAFT_REQUIRED, DRAFT_SCHEMA, hardEach, normaliseContract, type Requirement, type RequirementsContract } from './requirements.js';

export type SearchModality = 'videos'|'web'|'docs'|'images';
const BARE_YEAR = /^\s*(?:in\s+)?((?:19|20)\d{2})\s*$/i;
const NEGATED = /^\s*(?:not|no|non|never|without|excluding|except|avoid)\b/i;
export const provenanceRequest =(s: string) => /\b(?:licen[cs]e|attribution|copyright|creative commons|free to use|not AI|no AI|non-AI|not generated|not AI-generated)\b/i.test(s);

// Complete a planner's contract from the actual request. Fallback clauses preserve all words, including constraints
// beyond the old 150-character review limit. The original request remains authoritative in every judge call.
export function completeContract(contract: RequirementsContract, modality?: SearchModality): RequirementsContract {
 const query = contract.query;
 // A bare year names the event ("first launch in 2018"): attach it to the first event requirement instead of letting it
 // stand alone, where no evidence field ever states it and it held every correct result at 5.
 const years = contract.requirements.flatMap(r => BARE_YEAR.exec(r.text)?.[1] ?? []);
 const events = contract.requirements.filter(r => !BARE_YEAR.test(r.text));
 const host = events.find(r => r.kind === 'subject' && r.scope === 'each');
 const missing = host ? years.filter(y => !host.text.includes(y)) : [];
 const folded = !years.length ? contract.requirements
   : host ? events.map(r => r === host && missing.length ? {...r, text: `${r.text} (${missing.join(', ')})`} : r)
   : contract.requirements.map(r => BARE_YEAR.test(r.text) ? {...r, hardness: 'preferred' as const} : r);
 const requirements = folded.map(r => ({...r, hardness: r.kind === 'subject' && r.scope === 'each' && !BARE_YEAR.test(r.text) ? 'hard' as const : r.hardness}));
 const setItems = requirements.filter(r => r.scope === 'set').flatMap(r => r.set_items ?? []);
 // A set-level publisher list must not become a demand that every result comes from every publisher.
 const names = setItems.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
 const fallbackQuery = names ? query.replace(new RegExp(`\\b(?:with|from)\\s+official\\s+(?:(?:${names})|and|or|[,\\s])+sources?\\b`, 'i'), '').trim() : query;
 const clauses = fallbackQuery.split(/\s*[,;]\s*|\s+(?=(?:not|without|under|less than|with licen[cs]e|in Hindi|in English|from engineers|when|where)\b)/i)
   .flatMap(s => s.match(/.{1,180}(?:\s|$)|.{1,180}/g) ?? []).map(s => s.trim()).filter(Boolean);
 for (const [i, text] of clauses.entries()) {
   if (i === 0 && requirements.some(r => r.kind === 'subject' && r.scope === 'each')) continue;
   if (requirements.some(r => r.text.toLowerCase() === text.toLowerCase() || r.source_quote === text)) continue;
   // "where the two side boosters touch down together" restates "two side boosters touch down together".
   if (requirements.some(r => r.text.length >= 12 && text.toLowerCase().includes(r.text.toLowerCase()))) continue;
   if (/^(?:under|less than)\b/i.test(text) && requirements.some(r => r.kind === 'duration')) continue;
   requirements.push({id: '', text, source_quote: text, kind: i === 0 ? 'subject' : 'property', hardness: 'hard', scope: 'each',
     evidence: provenanceRequest(text) ? 'Explicit source provenance or licence and attribution; appearance and missing labels prove nothing.'
       : /\b(?:current|latest|today)\b/i.test(text) ? `Dated primary-source evidence establishing the claim as of ${contract.search_date}; a page title saying current is insufficient.`
       : 'Inspected content establishing this exact property and event, not merely the same topic.'});
 }
 if (modality === 'images') for (const match of query.matchAll(/free to use|not AI-generated|not AI generated|no AI|non-AI|with licen[cs]e(?: and attribution)?/gi)) {
   if (!requirements.some(r => r.kind === 'property' && r.text === match[0])) requirements.push({id: '', text: match[0], source_quote: match[0], kind: 'property',
     hardness: 'hard', scope: 'each', evidence: 'Explicit source provenance, licence terms or creator attribution. Absence of an AI label is unknown.'});
 }
 const tagged = requirements.map(r => ({...r,
   text: modality === 'images' && r.kind === 'subject' ? r.text.replace(/\bfree to use\s+|\bnon-AI\s+/gi, '').trim() : r.text,
   evidence_kind: modality === 'images' && r.kind === 'subject' ? 'visual' as const : provenanceRequest(r.source_quote ?? r.text) ? 'provenance' as const
   : modality === 'images' && r.kind === 'property' ? 'visual' as const : r.evidence_kind ?? 'content' as const}))
   // Provenance exclusions ("not AI-generated") stay strict: the user needs that assurance, not just an absence of doubt.
   .map(r => r.evidence_kind !== 'provenance' && NEGATED.test(r.text) ? {...r, polarity: 'exclude' as const} : r);
 // Preserve hard requirements before preferences when a verbose draft fills the contract.
 const ordered = [...tagged.filter(r => r.hardness === 'hard'), ...tagged.filter(r => r.hardness !== 'hard')].slice(0, 12);
 return {...contract, requirements: ordered.map((r, i) => ({...r, id: `R${i + 1}`}))};
}

export const judgeRequirements = (contract: RequirementsContract) => hardEach(contract).map(r =>
 ({id: r.id, text: r.text, evidence: r.evidence, kind: r.kind, evidence_kind: r.evidence_kind, source_quote: r.source_quote, polarity: r.polarity}));

type DraftModel = (query: string, modality: SearchModality) => Promise<unknown>;
export interface ContractDeps { contract?: RequirementsContract; contractModel?: DraftModel; searchDate?: string }
const cache = new Map<string, {contract: RequirementsContract; expires: number}>();

// One primary planner call, with provider fallbacks; no ensemble on every review. Reused across Docs hunt/refill passes.
export async function planContract(db: DB, config: Config, query: string, modality: SearchModality, deps: ContractDeps = {}) {
 if (deps.contract) return deps.contract;
 const date = deps.searchDate ?? new Date().toISOString().slice(0, 10);
 const models = config.PLANNER_MODELS.split(',').map(s => s.trim()).filter(Boolean);
 const key = JSON.stringify([config.TIER, models, modality, query, date]);
 const hit = !deps.contractModel && cache.get(key);
 if (hit && hit.expires > Date.now()) return hit.contract;
 const client = config.REQUIREMENTS_ENABLED && config.OPENROUTER_API_KEY && models.length
   ? new OpenAICompatibleClient(db, {...config, JUDGE_TIMEOUT_MS: config.PLANNER_ASSIST_TIMEOUT_MS}, models, undefined, 1800) : undefined;
 const model = deps.contractModel ?? (client ? async (request: string, tab: SearchModality) =>
   (await client.json('contract_calls', `${DRAFT_INSTRUCTION}\nEvery requirement must include source_quote copied exactly from the request. Never add an unstated constraint.`,
     JSON.stringify({request, tab, search_date: date}), {type: 'object', properties: DRAFT_SCHEMA, required: DRAFT_REQUIRED})).value : undefined);
 let draft: unknown;
 if (model) {
   let timer: NodeJS.Timeout|undefined;
   try {
     const raw = await Promise.race([model(query, modality), new Promise<never>((_, reject) => {
       timer = setTimeout(() => reject(new Error('contract_timeout')), config.PLANNER_ASSIST_TIMEOUT_MS);
     })]);
     const parsed = contractDraft.parse(raw);
     draft = {...parsed, completeness: /\b(?:full|complete|entire|whole|e-?book)\b/i.test(query) ? parsed.completeness : 'any',
       requirements: parsed.requirements?.filter(r => r.source_quote && r.source_quote.length <= 200 && query.includes(r.source_quote))
         .map(r => ({...r, text: r.source_quote!}))};
   } catch { /* The request's own words are the fallback. */ }
   finally { clearTimeout(timer); }
 }
 const contract = completeContract(normaliseContract(query, date, draft), modality);
 if (draft && !deps.contractModel) {
   if (cache.size >= 500) cache.delete(cache.keys().next().value!);
   cache.set(key, {contract, expires: Date.now() + 10 * 60_000});
 }
 return contract;
}

export function requirementNeeds(r: Pick<Requirement, 'text'|'evidence_kind'>) {
 return r.evidence_kind ?? (provenanceRequest(r.text) ? 'provenance' : 'content');
}
