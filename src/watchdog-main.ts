import { connect } from './db.js';
import { readConfig } from './config.js';
import { CHECKS, codeChanges, defaultEnv, list } from './dependencies.js';
import { Watchdog, probe, prune } from './watchdog.js';
import { keepBeating } from './health.js';

// npm run watchdog               keeps checking every dependency (run it supervised, like the worker)
// npm run watchdog -- --once     checks everything now, prints the results and exits 1 if anything is failing
// npm run watchdog -- --once gemini anilist    only the named checks
const args = process.argv.slice(2);
const names = args.filter(a => !a.startsWith('--'));
const unknown = names.filter(n => !CHECKS.some(c => c.name === n));
if (unknown.length || args.some(a => a.startsWith('--') && a !== '--once')) {
 console.error(`Usage: npm run watchdog [-- --once [check ...]]\nChecks: ${CHECKS.map(c => c.name).join(', ')}`);
 process.exit(2);
}
const config = readConfig(); const db = connect(config.DATABASE_URL);
const env = defaultEnv(db, config);
const TICK_MS = 15_000;

if (args.includes('--once')) {
 try {
   const results = await probe(env, names.length ? CHECKS.filter(c => names.includes(c.name)) : CHECKS);
   const width = Math.max(...results.map(r => r.check.name.length));
   for (const {check, observation, latencyMs} of results) {
     console.log(`${observation.status.padEnd(8)} ${check.name.padEnd(width)} ${`${latencyMs} ms`.padStart(8)}  ${observation.summary}`);
   }
   const failing = results.filter(r => r.observation.status === 'failing').map(r => r.check.name);
   const warnings = results.filter(r => r.observation.status === 'warning').map(r => r.check.name);
   console.log(`\n${failing.length ? `Failing: ${list(failing, 20)}.` : 'Nothing is failing.'}${warnings.length ? ` Warnings: ${list(warnings, 20)}.` : ''}`);
   process.exitCode = failing.length ? 1 : 0;
 } finally { await db.close(); }
} else {
 let stopping = false;
 let wake = () => {};
 for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; wake(); });
 const started = new Date();
 const stopBeating = keepBeating(db, 'watchdog');
 const watchdog = new Watchdog(env);
 await watchdog.load().catch(() => console.error(JSON.stringify({event: 'watchdog_load_failed', time: new Date().toISOString()})));
 console.log(JSON.stringify({event: 'watchdog_started', checks: CHECKS.length, time: started.toISOString()}));
 let pruned = 0;
 try {
   while (!stopping) {
     await watchdog.run();
     if (Date.now() - pruned > 3_600_000) { pruned = Date.now(); await prune(db).catch(() => {}); }
     // Under PM2 a watchdog whose own code or settings changed exits, and PM2 starts it again on the new version.
     if (process.env.pm_id !== undefined && Date.now() - started.getTime() > 60_000) {
       const changed = (await codeChanges(env.root)).filter(c => c.at > started).map(c => c.what);
       if (changed.length) { console.log(JSON.stringify({event: 'watchdog_restarting', changed, time: new Date().toISOString()})); break; }
     }
     await new Promise<void>(resolve => { const timer = setTimeout(resolve, TICK_MS); wake = () => { clearTimeout(timer); resolve(); }; });
   }
 } finally { stopBeating(); await db.close(); }
}
