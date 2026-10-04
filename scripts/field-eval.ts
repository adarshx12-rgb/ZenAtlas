// Field evaluation (evaluation/field-queries.json): runs every query against the running app, builds a page for grading the
// results by hand, and scores runs against those human grades, never against the judge's own scores.
//   node --env-file-if-exists=.env --import tsx scripts/field-eval.ts run <label> [tier]   (resumes a partial run; nothing else should search meanwhile)
//   node --import tsx scripts/field-eval.ts label        → output/field-eval/label.html (open it, grade, press Download)
//   node --import tsx scripts/field-eval.ts score        (reads evaluation/field-labels.json, or the newest field-labels*.json in Downloads)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costOf, linesSince, logOffsets, search, sleep, type Tab } from './suite-client.js';

type Query = {id: string; field: string; tab: Tab; kind: 'surface'|'deep'; q: string};
// kept/routed: set by the image judge comparison (scripts/image-judge-eval.ts), whose rows also hold the removed images.
type Item = {url: string; title: string; detail: string|null; image: string|null; relevance: number|null; kept?: boolean; routed?: boolean};
type Row = {id: string; field: string; tab: Tab; kind: string; q: string; ms: number; cost_usd: number; error?: string; providers?: unknown; items: Item[]; border?: number};
type Labels = Record<string, Record<string, 0|1|2>>;
const DIR = process.env.FIELD_EVAL_DIR ?? 'output/field-eval', LABELS = 'evaluation/field-labels.json';
const queries: Query[] = JSON.parse(readFileSync('evaluation/field-queries.json', 'utf8')).queries;
const [command = 'score', label, tier = 'ssj3'] = process.argv.slice(2);
mkdirSync(DIR, {recursive: true});
const runs = () => readdirSync(DIR).filter(f => f.endsWith('.json')).sort().map(f => ({file: f, rows: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Row[]}));
// Queries every run answered: only these are graded and compared, so a partial run cannot skew the scores.
const common = () => { const all = runs(); return new Set(queries.map(q => q.id).filter(id => all.length && all.every(r => r.rows.some(x => x.id === id && !x.error)))); };
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

if (command === 'run') {
 if (!label || !/^[\w-]+$/.test(label)) throw new Error('Give the run a label: letters, digits, - or _');
 const file = join(DIR, `${label}.json`);
 const rows: Row[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
 const only = process.env.FIELD_EVAL_IDS?.split(',');
 for (const query of queries) {
   if (rows.some(r => r.id === query.id && !r.error) || (only && !only.includes(query.id))) continue;
   const start = logOffsets(), started = Date.now();
   let out: any;
   try { out = await search(query.tab, query.q, tier); } catch (e) { out = {error: String(e)}; }
   const ms = Date.now() - started; await sleep(3000);
   const items: Item[] = (out.results ?? []).map((r: any) => ({url: r.url ?? r.page_url, title: r.title,
     detail: r.snippet ?? r.reason ?? r.creator ?? null, image: r.image_url ?? null, relevance: r.relevance ?? null}));
   const row: Row = {...query, ms, cost_usd: costOf(linesSince(start)).cost_usd, ...(out.error ? {error: out.error} : {}), providers: out.providers, items};
   const at = rows.findIndex(r => r.id === query.id);
   if (at >= 0) rows[at] = row; else rows.push(row);
   writeFileSync(file, JSON.stringify(rows, null, 1));
   console.log(`${query.tab.padEnd(6)} ${(ms / 1000).toFixed(0).padStart(3)}s $${row.cost_usd.toFixed(4)} ${String(items.length).padStart(2)} results  ${query.id}${row.error ? `  ERROR ${row.error}` : ''}`);
 }
 console.log('wrote', file);
} else if (command === 'label') {
 // Every result any run showed for a query, once, with grades already given filled in.
 const given: Labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : {};
 const shared = common();
 const pool = queries.filter(q => shared.has(q.id)).map(query => {
   const seen = new Map<string, Item>();
   // Judge comparison runs: only each judge's first 12 kept images (the first screen) are graded.
   const keptBy = new Set<string>(), compared = runs().some(run => run.rows.some(r => r.items.some(i => i.kept !== undefined)));
   for (const run of runs()) for (const item of run.rows.find(r => r.id === query.id)?.items ?? []) {
     if (item.kept && run.rows.find(r => r.id === query.id)!.items.filter(i => i.kept).indexOf(item) < 12) keptBy.add(item.url);
     if (item.url && !seen.has(item.url)) seen.set(item.url, item);
   }
   if (compared) for (const url of seen.keys()) if (!keptBy.has(url)) seen.delete(url);
   // Ungraded results first, so a new run's pages are graded without scrolling past the earlier ones.
   const graded = (i: Item) => Number(given[query.id]?.[i.url] !== undefined);
   return {...query, items: [...seen.values()].sort((a, b) => graded(a) - graded(b))};
 }).filter(q => q.items.length);
 const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Field evaluation grading</title>
<style>:root{--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--good:#1a7f37;--ok:#9a6700;--bad:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:980px;padding:16px}
h2{font-size:17px;margin:28px 0 4px}.meta{color:var(--muted);font-size:13px}.item{display:flex;gap:12px;border-top:1px solid var(--line);padding:10px 0}
.item img{width:120px;height:90px;object-fit:cover;border-radius:4px}.body{flex:1;min-width:0}.body a{word-break:break-word}.detail{color:var(--muted);font-size:13px}
.grades{display:flex;gap:6px;align-items:flex-start}.grades button{border:1px solid var(--line);background:none;color:var(--fg);border-radius:6px;padding:6px 10px;cursor:pointer}
.grades button.on[data-g="2"]{background:var(--good);color:#fff}.grades button.on[data-g="1"]{background:var(--ok);color:#fff}.grades button.on[data-g="0"]{background:var(--bad);color:#fff}
header{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}</style></head><body>
<header><strong>Grade each result for its request</strong><span class="meta">2 = good, what I'd want · 1 = partly useful · 0 = wrong or useless</span>
<span id="count" class="meta"></span><button id="save">Download labels</button></header>
<div id="list"></div>
<script>const POOL=${JSON.stringify(pool).replace(/</g, '\\u003c')},GIVEN=${JSON.stringify(given).replace(/</g, '\\u003c')};
let labels={};try{labels=JSON.parse(localStorage.getItem('field-labels')||'null')||GIVEN;}catch{labels=GIVEN;}
const store=()=>{try{localStorage.setItem('field-labels',JSON.stringify(labels));}catch{}};
const count=()=>{const total=POOL.reduce((n,q)=>n+q.items.length,0),done=POOL.reduce((n,q)=>n+q.items.filter(i=>labels[q.id]?.[i.url]!==undefined).length,0);document.getElementById('count').textContent=done+' of '+total+' graded';};
const el=(tag,props={},...kids)=>{const e=Object.assign(document.createElement(tag),props);e.append(...kids);return e;};
for(const q of POOL){const box=el('section');box.append(el('h2',{textContent:q.q}),el('div',{className:'meta',textContent:q.tab+' · '+q.field+' · '+q.kind}));
 for(const item of q.items){const grades=el('div',{className:'grades'});
  for(const g of [2,1,0]){const b=el('button',{textContent:String(g)});b.dataset.g=g;if(labels[q.id]?.[item.url]===g)b.classList.add('on');
   b.onclick=()=>{(labels[q.id]??={})[item.url]=g;for(const o of grades.children)o.classList.toggle('on',o===b);store();count();};grades.append(b);}
  const body=el('div',{className:'body'},el('a',{href:item.url,target:'_blank',rel:'noopener noreferrer',textContent:item.title||item.url}),
   el('div',{className:'detail',textContent:(new URL(item.url).hostname)+(item.detail?' · '+item.detail:'')}));
  box.append(el('div',{className:'item'},...(item.image?[el('img',{src:item.image,loading:'lazy',alt:''})]:[]),body,grades));}
 document.getElementById('list').append(box);}
count();
document.getElementById('save').onclick=()=>{const a=el('a',{href:URL.createObjectURL(new Blob([JSON.stringify(labels,null,1)],{type:'application/json'})),download:'field-labels.json'});a.click();};
</script></body></html>`;
 writeFileSync(join(DIR, 'label.html'), html);
 console.log(`wrote ${DIR}/label.html: ${pool.reduce((n, q) => n + q.items.length, 0)} results across ${pool.length} queries`);
} else {
 // The newest downloaded grades replace the stored file, so grading never needs a manual copy.
 const downloads = join(homedir(), 'Downloads');
 const fresh = existsSync(downloads) ? readdirSync(downloads).filter(f => /^field-labels.*\.json$/.test(f))
   .map(f => join(downloads, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined;
 if (fresh && (!existsSync(LABELS) || statSync(fresh).mtimeMs > statSync(LABELS).mtimeMs)) { copyFileSync(fresh, LABELS); console.log('labels from', fresh); }
 const labels: Labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : {};
 // Per run: mean grade of the top 5 (2 good, 1 partly, 0 wrong; an empty slot counts 0), good results in the top 10,
 // queries with no good result, ungraded results, distinct sites, time and model cost.
 const score = (rows: Row[]) => {
   let top5 = 0, good = 0, empty = 0, ungraded = 0, n = 0, ms = 0, cost = 0; const sites = new Set<string>();
   // Judge comparison rows: what the judge kept against what was graded good, over the whole judged pool.
   let keptGood = 0, keptGraded = 0, poolGood = 0, border = 0; const routed: number[] = [], open: number[] = [];
   for (const row of rows) {
     const g = (i: Item) => labels[row.id]?.[i.url];
     for (const i of row.items.filter(i => i.kept !== undefined && g(i) !== undefined)) {
       if (i.kept) { keptGraded++; if (g(i) === 2) keptGood++; }
       if (g(i) === 2) poolGood++;
       (i.routed ? routed : open).push(g(i)!);
     }
     border += row.border ?? 0;
   }
   const mean = (l: number[]) => l.length ? +(l.reduce((a, b) => a + b, 0) / l.length).toFixed(2) : null;
   const judged = rows.some(r => r.items.some(i => i.kept !== undefined)) ? {precision: keptGraded ? +(keptGood / keptGraded).toFixed(2) : null,
     recall: poolGood ? +(keptGood / poolGood).toFixed(2) : null, to_strong: border, routed_grade: mean(routed), open_grade: mean(open)} : {};
   for (const row of rows) {
     const r = {...row, items: row.items.filter(i => i.kept !== false)};
     const g = (i: Item) => labels[r.id]?.[i.url];
     top5 += [0, 1, 2, 3, 4].reduce((s, k) => s + (r.items[k] ? g(r.items[k]) ?? 0 : 0), 0) / 5;
     const goods = r.items.slice(0, 10).filter(i => g(i) === 2).length;
     good += goods; if (!goods) empty++; ungraded += r.items.filter(i => g(i) === undefined).length;
     for (const i of r.items) sites.add(host(i.url));
     n++; ms += r.ms; cost += r.cost_usd;
   }
   return {queries: n, top5: +(top5 / Math.max(n, 1)).toFixed(2), good_top10: +(good / Math.max(n, 1)).toFixed(1), no_good: empty,
     ungraded, sites: sites.size, mean_s: +(ms / Math.max(n, 1) / 1000).toFixed(0), cost_usd: +cost.toFixed(3), ...judged};
 };
 const shared = common();
 console.log(`comparing the ${shared.size} queries every run answered`);
 for (const run of runs().map(r => ({...r, rows: r.rows.filter(x => shared.has(x.id))}))) {
   console.log(`\n== ${run.file}`);
   console.table({all: score(run.rows), surface: score(run.rows.filter(r => r.kind === 'surface')), deep: score(run.rows.filter(r => r.kind === 'deep')),
     ...Object.fromEntries((['videos', 'web', 'docs', 'images'] as Tab[]).map(t => [t, score(run.rows.filter(r => r.tab === t))]))});
 }
}
