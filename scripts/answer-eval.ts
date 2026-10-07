// Cited-answer evaluation (evaluation/answer-queries.json): runs every Web query against the running app and waits for its
// answer, builds a page for grading each claim and each answer by hand, and scores runs against those human grades.
//   node --import tsx scripts/answer-eval.ts run <label> [tier]   (resumes a partial run; ANSWER_EVAL_IDS=a,b runs only those)
//   node --import tsx scripts/answer-eval.ts label        → output/answer-eval/label.html (open it, grade, press Download)
//   node --import tsx scripts/answer-eval.ts score        (reads evaluation/answer-labels.json, or the newest answer-labels*.json in Downloads)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costOf, linesSince, logOffsets, sleep } from './suite-client.js';
import { scoreAnswers } from '../src/evaluation.js';

type Query = {id: string; kind: string; q: string};
type Passage = {id: string; text: string};
type Source = {id: string; url: string; title: string; published: string|null; passages: Passage[]};
type Answer = {status: string; message: string; claims: {id: string; text: string; evidence: string[]}[]; sources: Source[]; limited: boolean};
type Row = {id: string; kind: string; q: string; ms: number; answer_ms: number|null; cost_usd: number|null; answer_cost_usd: number|null;
 trace_id?:string; usage?:ReturnType<typeof costOf>; completed?:boolean;
 proposed: number|null; error?: string; answer: Answer|null; results: {title: string; url: string}[]};
// labels[query id]: claims by claim text (2 right and backed by its passages, 1 right but weakly backed or off the point, 0 wrong),
// and the answer as a whole (useful: 2 helps, 1 somewhat, 0 no help or misleading).
type Labels = Record<string, {claims: Record<string, 0|1|2>; useful?: 0|1|2}>;
const BASE = 'http://127.0.0.1:3000', DIR = process.env.ANSWER_EVAL_DIR ?? 'output/answer-eval', LABELS = 'evaluation/answer-labels.json';
const PENDING = ['reading', 'drafting', 'checking'];
const queries: Query[] = JSON.parse(readFileSync('evaluation/answer-queries.json', 'utf8')).queries;
const [command = 'score', label, tier = 'ssj3'] = process.argv.slice(2);
mkdirSync(DIR, {recursive: true});
const runs = () => readdirSync(DIR).filter(f => f.endsWith('.json')).sort().map(f => ({file: f, rows: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Row[]}));

// One session for the whole run: review tokens are bound to the session that searched.
let cookie = '';
async function get(path: string) {
 const r = await fetch(BASE + path, {headers: cookie ? {cookie} : {},signal:AbortSignal.timeout(30000)});
 const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
 if (!r.ok) throw new Error(`${r.status} ${path.split('?')[0]}`);
 return r.json();
}

if (command === 'run') {
 if (!label || !/^[\w-]+$/.test(label)) throw new Error('Give the run a label: letters, digits, - or _');
 const file = join(DIR, `${label}.json`);
 const rows: Row[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
 const only = process.env.ANSWER_EVAL_IDS?.split(',');
 await get('/health/ready');
 for (const query of queries) {
   if (rows.some(r => r.id === query.id && !r.error) || (only && !only.includes(query.id))) continue;
   const start = logOffsets(), started = Date.now();
   let answer: Answer|null = null, results: Row['results'] = [], answerMs: number|null = null, error: string|undefined;
   let traceId:string|undefined, completed=false;
   try {
     const body = await get(`/api/web?${new URLSearchParams({q: query.q, kind: 'web', tier})}`);
     traceId=body.trace_id;completed=!body.review;
     results = (body.results ?? []).slice(0, 5).map((r: any) => ({title: r.title, url: r.url}));
     // The review finishes first; its answer is read until it leaves the pending states (the site polls the same way).
     for (let i = 0; body.review && i < 150; i++) {
       await sleep(2000);
       const s = await get(`/api/web/review?token=${body.review}`);
       if (s.status === 'complete') results = (s.results ?? []).slice(0, 5).map((r: any) => ({title: r.title, url: r.url}));
       answer = s.answer ?? null;
       if (s.status === 'complete' && (!answer || !PENDING.includes(answer.status))) {completed=true;break;}
     }
     if(!completed)throw new Error('evaluation_timeout');
     if (answer && !PENDING.includes(answer.status)) answerMs = Date.now() - started;
   } catch (e) { error = String(e); }
   const ms=Date.now()-started;
   await sleep(2000);
   const lines = linesSince(start), cost = costOf(lines,traceId);
   const cited = traceId?lines.find(l => l.event === 'cited_answer'&&l.trace_id===traceId):undefined;
   const answerCost=costOf(lines.filter(l=>['answer_writer','answer_verifier'].includes(l.bucket)),traceId);
   const row: Row = {...query, ms, trace_id:traceId,completed,usage:cost,answer_ms: answerMs, cost_usd: cost.cost_usd,
     answer_cost_usd: answerCost.cost_usd,
     proposed: cited?.proposed ?? null, ...(error ? {error} : {}), answer, results};
   const at = rows.findIndex(r => r.id === query.id);
   if (at >= 0) rows[at] = row; else rows.push(row);
   writeFileSync(file, JSON.stringify(rows, null, 1));
   console.log(`${query.kind.padEnd(11)} ${(row.ms / 1000).toFixed(0).padStart(3)}s $${row.cost_usd?.toFixed(4)??'unknown'} (answer $${row.answer_cost_usd?.toFixed(4)??'unknown'}) `
     + `${(answer?.status ?? 'none').padEnd(12)} ${answer?.claims.length ?? 0}/${row.proposed ?? '-'} claims  ${query.id}${error ? `  ERROR ${error}` : ''}`);
 }
 console.log('wrote', file);
} else if (command === 'label') {
 const given: Labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : {};
 // Every answer any run gave for a query, each claim once, shown with exactly the passages it cites.
 const pool = queries.map(query => {
   const answers = runs().flatMap(run => { const row = run.rows.find(r => r.id === query.id);
     return row?.answer?.status === 'ready' ? [{run: run.file.replace(/\.json$/, ''), answer: row.answer}] : []; });
   const statuses = runs().map(run => { const row = run.rows.find(r => r.id === query.id);
     return `${run.file.replace(/\.json$/, '')}: ${row?.error ? 'error' : row?.answer?.status ?? 'no answer'}`; });
   return {...query, statuses, answers: answers.map(({run, answer}) => ({run, claims: answer.claims.map(c => ({text: c.text,
     cites: answer.sources.flatMap(s => s.passages.filter(p => c.evidence.includes(p.id)).map(p => ({title: s.title, url: s.url, published: s.published, text: p.text})))}))}))};
 });
 const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Answer grading</title>
<style>:root{--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--good:#1a7f37;--ok:#9a6700;--bad:#cf222e;--quote:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333;--quote:#1c1c1c}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:980px;padding:16px}
h2{font-size:17px;margin:32px 0 4px}.meta{color:var(--muted);font-size:13px}h3{font-size:14px;margin:16px 0 4px;color:var(--muted)}
.claim{display:flex;gap:12px;border-top:1px solid var(--line);padding:10px 0}.body{flex:1;min-width:0}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:13px}blockquote{margin:8px 0;padding:8px 12px;background:var(--quote);border-left:3px solid var(--line);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.grades{display:flex;gap:6px;align-items:flex-start}.grades button{border:1px solid var(--line);background:none;color:var(--fg);border-radius:6px;padding:6px 10px;cursor:pointer}
.grades button.on[data-g="2"]{background:var(--good);color:#fff}.grades button.on[data-g="1"]{background:var(--ok);color:#fff}.grades button.on[data-g="0"]{background:var(--bad);color:#fff}
.useful{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:2px solid var(--line)}
header{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:1}</style></head><body>
<header><strong>Grade each claim, then each answer</strong><span class="meta">Claim: 2 = right and the quotes back it · 1 = right but weakly backed or off the point · 0 = wrong or misleading. Answer: 2 = helps · 1 = somewhat · 0 = no help</span>
<span id="count" class="meta"></span><button id="save">Download labels</button></header><div id="list"></div>
<script>const POOL=${JSON.stringify(pool).replace(/</g, '\\u003c')},GIVEN=${JSON.stringify(given).replace(/</g, '\\u003c')};
let labels={};try{labels=JSON.parse(localStorage.getItem('answer-labels')||'null')||GIVEN;}catch{labels=GIVEN;}
const store=()=>{try{localStorage.setItem('answer-labels',JSON.stringify(labels));}catch{}};
const at=id=>labels[id]??={claims:{}};
const count=()=>{let total=0,done=0;for(const q of POOL){const seen=new Set(q.answers.flatMap(a=>a.claims.map(c=>c.text)));total+=seen.size+(q.answers.length?1:0);
 done+=[...seen].filter(t=>labels[q.id]?.claims?.[t]!==undefined).length+(q.answers.length&&labels[q.id]?.useful!==undefined?1:0);}
 document.getElementById('count').textContent=done+' of '+total+' graded';};
const el=(tag,props={},...kids)=>{const e=Object.assign(document.createElement(tag),props);e.append(...kids);return e;};
const buttons=(get,set)=>{const box=el('div',{className:'grades'});for(const g of [2,1,0]){const b=el('button',{textContent:String(g)});b.dataset.g=g;if(get()===g)b.classList.add('on');
 b.onclick=()=>{set(g);for(const o of box.children)o.classList.toggle('on',o===b);store();count();};box.append(b);}return box;};
for(const q of POOL){const box=el('section');box.append(el('h2',{textContent:q.q}),el('div',{className:'meta',textContent:q.kind+' · '+q.statuses.join(' · ')}));
 const graded=new Set();
 for(const a of q.answers){box.append(el('h3',{textContent:'Answer from '+a.run}));
  for(const c of a.claims){if(graded.has(c.text))continue;graded.add(c.text);
   const quotes=el('details',{},el('summary',{textContent:c.cites.length+' cited passage'+(c.cites.length===1?'':'s')}));
   for(const p of c.cites)quotes.append(el('div',{className:'meta'},el('a',{href:p.url,target:'_blank',rel:'noopener noreferrer',textContent:p.title||p.url}),p.published?' · '+p.published:''),el('blockquote',{textContent:p.text}));
   box.append(el('div',{className:'claim'},el('div',{className:'body'},el('div',{textContent:c.text}),quotes),buttons(()=>labels[q.id]?.claims?.[c.text],g=>{at(q.id).claims[c.text]=g;})));}}
 if(q.answers.length)box.append(el('div',{className:'useful'},el('strong',{textContent:'Was the answer useful for this request?'}),buttons(()=>labels[q.id]?.useful,g=>{at(q.id).useful=g;})));
 document.getElementById('list').append(box);}
count();
document.getElementById('save').onclick=()=>{const a=el('a',{href:URL.createObjectURL(new Blob([JSON.stringify(labels,null,1)],{type:'application/json'})),download:'answer-labels.json'});a.click();};
</script></body></html>`;
 writeFileSync(join(DIR, 'label.html'), html);
 console.log(`wrote ${DIR}/label.html: ${pool.filter(q => q.answers.length).length} answered queries`);
} else {
 const downloads = join(homedir(), 'Downloads');
 const fresh = existsSync(downloads) ? readdirSync(downloads).filter(f => /^answer-labels.*\.json$/.test(f))
   .map(f => join(downloads, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined;
 if (fresh && (!existsSync(LABELS) || statSync(fresh).mtimeMs > statSync(LABELS).mtimeMs)) { copyFileSync(fresh, LABELS); console.log('labels from', fresh); }
 const labels: Labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : {};
 // Per run: how often an answer appeared where one should, skip searches left alone, claims kept of those proposed,
 // human claim grade and wrong-claim rate, usefulness, and the answer's own time and cost.
 const score = (rows: Row[]) => scoreAnswers(rows, labels);
 for (const run of runs()) {
   console.log(`\n== ${run.file}`);
   const kinds = [...new Set(queries.map(q => q.kind))].filter(k => k !== 'skip');
   console.table({all: score(run.rows), ...Object.fromEntries(kinds.map(k => [k, score(run.rows.filter(r => r.kind === k))]))});
 }
}
