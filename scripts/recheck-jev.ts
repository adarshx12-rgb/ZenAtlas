import { readFile, writeFile } from 'node:fs/promises';
import { connect } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { JevScreener } from '../src/screener.js';
import { contentInput } from '../src/types.js';
import { fetchJSON, UpstreamError } from '../src/http.js';

const config = readConfig(), db = connect(config.DATABASE_URL);
const source = JSON.parse(await readFile('output/jev-evaluation-2026-09-23.json', 'utf8')).queries[1];
const report: any = {query: source.q, kind: 'Separate same-pool screening retry; original search results are unchanged.',
 timeout_ms: config.JEV_SCREEN_TIMEOUT_MS, batches: []};
const transport: typeof fetchJSON = async (url, options) => {
 const start = Date.now();
 try {
   const raw = await fetchJSON(url, options);
   report.batches.push({elapsed_ms: Date.now() - start, usage: raw.usage, model: raw.model});
   return raw;
 } catch (error) {
   report.batches.push({elapsed_ms: Date.now() - start, error: error instanceof UpstreamError ? error.code : 'failed'});
   throw error;
 }
};
try {
 const started = Date.now();
 const out = await new JevScreener(db, config, transport).screen(source.q, source.baseline.map((c: any, i: number) => ({
   item: contentInput.parse({url: c.url, title: c.title, description: c.description, creator: c.creator}), provider: c.provider, position: i,
 })));
 report.decisions = out.decisions;
 report.screened = out.screened;
 report.promoted = out.promising.size;
 report.elapsed_ms = Date.now() - started;
 console.log(JSON.stringify({screened: report.screened, promoted: report.promoted, elapsed_ms: report.elapsed_ms}));
} catch (error) {
 report.error = error instanceof UpstreamError ? error.code : 'failed';
 console.log(JSON.stringify({error: report.error}));
} finally {
 await writeFile('output/jev-roswell-retry-2026-09-23.json', JSON.stringify(report, null, 2) + '\n');
 await db.close();
}
