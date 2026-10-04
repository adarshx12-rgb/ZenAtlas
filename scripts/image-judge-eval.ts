// Image judge comparison: every judge model sees the same images for each image query in evaluation/field-queries.json
// (collected once, with field routing, then screened and ordered as the live review does, and cut to the judged window
// without the live spares for duplicates), with the same request
// contract and the same thumbnails. Only the first-stage judge differs; the Strong judge is left out so its re-checks do
// not hide the difference, and each run counts how many images would have gone to it (scores in the cascade's border band).
// Runs land in output/image-judge in the field evaluation's format, so grading and scoring use scripts/field-eval.ts:
// Every judge gets a 60 s limit (the live one is JUDGE_TIMEOUT_MS) so slower models are compared on quality; their time is
// recorded. "model@low" asks OpenRouter for low reasoning effort (GLM 5.3 Flash spends 8k tokens reasoning otherwise).
//   node --env-file=.env --import tsx scripts/image-judge-eval.ts <label> <openrouter model[@effort]> [<label> <model> ...]
//   FIELD_EVAL_DIR=output/image-judge node --import tsx scripts/field-eval.ts label|score
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { connect } from '../src/db.js';
import { collectImages, imageSearchInput, type ImageResult } from '../src/images.js';
import { reviewImages } from '../src/image-review.js';
import { strongFirst } from '../src/image-sources.js';
import { makeScreener, screeningOrder } from '../src/screener.js';
import { contentInput } from '../src/types.js';
import { planContract, judgeRequirements } from '../src/search-contract.js';
import { ModelJudge, TANGENTIAL } from '../src/judge.js';
import { OpenAICompatibleClient } from '../src/openai-compatible.js';
import { fetchImage, fetchJSON } from '../src/http.js';

const DIR = 'output/image-judge', POOLS = join(DIR, 'pools');
mkdirSync(POOLS, {recursive: true});
const config = {...readConfig(), JUDGE_TIMEOUT_MS: 60_000}, db = connect(config.DATABASE_URL);
const args = process.argv.slice(2);
if (!args.length || args.length % 2) throw new Error('Give label/model pairs, e.g. flashlite google/gemini-3.5-flash-lite');
const judges = Array.from({length: args.length / 2}, (_, i) => { const [model, effort] = args[i * 2 + 1]!.split('@'); return {label: args[i * 2]!, model: model!, effort}; });
const client = (model: string, effort?: string) => new OpenAICompatibleClient(db, config, [model],
 ((url: string, init: any) => fetchJSON(url, effort ? {...init, body: {...init.body, reasoning: {effort}}} : init)) as typeof fetchJSON);
const only = process.env.FIELD_EVAL_IDS?.split(',');
const queries = (JSON.parse(readFileSync('evaluation/field-queries.json', 'utf8')).queries as {id: string; field: string; tab: string; kind: string; q: string}[])
 .filter(q => q.tab === 'images' && (!only || only.includes(q.id)));

// Each model call logs a model_cost line on stdout: counted per run, and kept off the console.
let costs: {bucket: string; cost: number}[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: any, ...rest: any[]) => {
 const text = String(chunk);
 if (text.startsWith('{"event":')) { try { const j = JSON.parse(text); if (j.event === 'model_cost') costs.push(j); } catch {} appendFileSync(join(DIR, 'events.log'), text); return true; }
 return write(chunk, ...rest);
}) as typeof process.stdout.write;

type Pool = {field: string|null; contract: unknown; images: ImageResult[]; routed: string[]};
async function pool(query: {id: string; q: string}): Promise<Pool> {
 const file = join(POOLS, `${query.id}.json`);
 if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
 const input = imageSearchInput.parse({q: query.q, limit: '24'});
 const found = await collectImages(db, config, input, {}, config.IMAGE_POOL);
 const q = found.plan.corrected;
 const contract = await planContract(db, config, q, 'images');
 // As the live review orders the pool: Jev screens, weak sources go last, and the judged window is taken from the front.
 let ordered = found.images;
 const screener = makeScreener(db, config);
 if (screener && ordered.length > config.IMAGE_JUDGE_POOL) {
   const leads = ordered.map((image, position) => ({item: contentInput.parse({url: image.image_url, title: image.title}), provider: image.engine, position, image}));
   const screened = await screener.screen(q, leads, {requirements: judgeRequirements(contract), formats: ['image'], search_date: contract.search_date}).catch(() => null);
   if (screened) ordered = screeningOrder(leads, screened.promising).map(c => c.image);
 }
 const images = strongFirst(ordered, q).slice(0, config.IMAGE_JUDGE_POOL);
 const out: Pool = {field: found.field ?? null, contract, images, routed: (found.routed ?? []).filter(u => images.some(i => i.image_url === u))};
 writeFileSync(file, JSON.stringify(out));
 return out;
}

const thumbs = new Map<string, Promise<{contentType: string; data: Buffer}>>();
const thumbnail = (url: string) => { if (!thumbs.has(url)) thumbs.set(url, fetchImage(url, {timeoutMs: 4000, maxBytes: 400 * 1024})); return thumbs.get(url)!; };
const file = (label: string) => join(DIR, `${label}.json`);
const rows = Object.fromEntries(judges.map(j => [j.label, existsSync(file(j.label)) ? JSON.parse(readFileSync(file(j.label), 'utf8')) : []])) as Record<string, any[]>;

for (const query of queries) {
 const p = await pool(query);
 for (const judge of judges) {
   if (rows[judge.label]!.some(r => r.id === query.id && !r.error)) continue;
   costs = [];
   const started = Date.now();
   let row: any;
   try {
     const out = await reviewImages(db, config, query.q, p.images, {judge: new ModelJudge(client(judge.model, judge.effort), config),
       strong: null, screener: undefined, thumbnail, contract: p.contract as any, log: () => {}, onlyJudged: true});
     const kept = out.results.filter(r => r.judgement && r.judgement.relevance > TANGENTIAL);
     const removed = p.images.filter(i => !kept.some(k => k.id === i.id));
     const verdict = new Map(out.results.map(r => [r.id, r.judgement?.relevance ?? null]));
     const item = (r: ImageResult, isKept: boolean) => ({url: r.page_url, title: r.title, detail: r.source_name, image: r.thumbnail || r.image_url,
       relevance: verdict.get(r.id) ?? null, kept: isKept, routed: p.routed.includes(r.image_url)});
     const judged = out.results.filter(r => r.judgement).length;
     row = {...query, model: judge.model, effort: judge.effort ?? null, ms: Date.now() - started, cost_usd: +costs.reduce((n, c) => n + (c.cost ?? 0), 0).toFixed(5),
       judged, border: out.results.filter(r => r.judgement && r.judgement.relevance >= config.CASCADE_BORDER_LOW && r.judgement.relevance <= config.CASCADE_BORDER_HIGH).length,
       items: [...kept.map(r => item(r, true)), ...removed.map(r => item(r, false))]};
   } catch (e) { row = {...query, model: judge.model, ms: Date.now() - started, cost_usd: 0, error: String(e), items: []}; }
   const list = rows[judge.label]!;
   const at = list.findIndex(r => r.id === query.id);
   if (at >= 0) list[at] = row; else list.push(row);
   writeFileSync(file(judge.label), JSON.stringify(list, null, 1));
   console.log(`${judge.label.padEnd(10)} ${(row.ms / 1000).toFixed(0).padStart(3)}s $${row.cost_usd.toFixed(4)} kept ${row.items.filter((i: any) => i.kept).length}/${row.judged ?? 0}`
     + ` border ${row.border ?? '-'} routed ${p.routed.length}  ${query.id}${row.error ? `  ERROR ${row.error.slice(0, 200)}` : ''}`);
 }
}
await db.close();
process.exit(0);
