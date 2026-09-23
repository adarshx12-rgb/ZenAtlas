// One live screening call using the configured OpenRouter key and normal daily budget.
// These labelled fixtures are never ingested into the catalogue.
import { connect } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { makeScreener } from '../src/screener.js';
import { contentInput } from '../src/types.js';
import { UpstreamError } from '../src/http.js';

const config = readConfig(), db = connect(config.DATABASE_URL);
try {
 const screener = makeScreener(db, config);
 if (!screener) throw new UpstreamError('screening_not_configured');
 const candidates = [
   {title: 'TEST: NASA Apollo 11 launch recording', description: 'Archival video of the Saturn V launch carrying Apollo 11 to the Moon.'},
   {title: 'TEST: Pasta cooking tutorial', description: 'How to prepare tomato sauce and boil pasta.'},
 ].map((item, i) => ({item: contentInput.parse({...item, url: `https://example.org/jev-smoke-${i}`}), provider: 'smoke_fixture', position: i}));
 const started = Date.now();
 const out = await screener.screen('Apollo 11 Moon launch footage', candidates);
 console.log(JSON.stringify({provider: 'openrouter', model: config.JEV_MODEL, screened: out.screened,
   promoted: candidates.filter(c => out.promising.has(c.item.url)).map(c => c.position), elapsed_ms: Date.now() - started}));
} catch (error) {
 process.exitCode = 1;
 console.error(JSON.stringify({error: error instanceof UpstreamError ? error.code : 'check_failed',
   status: error instanceof UpstreamError ? error.status : undefined}));
} finally { await db.close(); }
