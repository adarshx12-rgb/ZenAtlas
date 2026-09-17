import type { DB } from './db.js';
import type { Config } from './config.js';
import { CHECKS, mapLimit, reason, type Check, type CheckEnv, type CheckStatus, type Observation } from './dependencies.js';

const CHECK_TIMEOUT_MS = 60_000;
const PARALLEL = 4;
const EVENT_DAYS = 30;

export interface Outcome {
 check: Check; observation: Observation; latencyMs: number;
 // The settled status after this observation, the one before it, and whether this observation changed it.
 status: CheckStatus; previous: CheckStatus|null; changed: boolean;
}
export type Notify = (changes: Outcome[]) => Promise<void>;
type State = {status: CheckStatus; observed: CheckStatus; streak: number; nextAt: number};

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
 let timer: NodeJS.Timeout|undefined;
 const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms/1000} s`)), ms); });
 return Promise.race([task, expired]).finally(() => clearTimeout(timer));
}
async function observe(check: Check, env: CheckEnv): Promise<{observation: Observation; latencyMs: number}> {
 const started = Date.now();
 const observation = await withTimeout(check.run(env), CHECK_TIMEOUT_MS)
   .catch((error): Observation => ({status: 'failing', code: 'check_error', summary: `The check could not run: ${reason(error)}.`}));
 return {observation, latencyMs: Date.now() - started};
}

// Runs each check when it is due and keeps the settled status of each dependency. The schedule lives in this process,
// so it keeps working while the database is down; results are written to the database when it is reachable.
// Run one watchdog: two would each run every check.
export class Watchdog {
 private state = new Map<string,State>();
 constructor(private env: CheckEnv, private checks: Check[] = CHECKS, private notify: Notify = webhook(env.config)) {}

 // Continues from the stored results, so a restart neither repeats alerts nor runs every check at once.
 async load() {
   const rows = (await this.env.db.query<{name: string; status: CheckStatus; observed: CheckStatus; streak: number; next_at: Date}>(
     'SELECT name,status,observed,streak,next_at FROM dependency_checks')).rows;
   for (const r of rows) this.state.set(r.name, {status: r.status, observed: r.observed, streak: r.streak, nextAt: new Date(r.next_at).getTime()});
   await this.env.db.query('DELETE FROM dependency_checks WHERE name<>ALL($1::text[])', [this.checks.map(c => c.name)]);
 }
 due(now = Date.now()) { return this.checks.filter(c => (this.state.get(c.name)?.nextAt ?? 0) <= now); }

 async run(checks = this.due()): Promise<Outcome[]> {
   const outcomes = await mapLimit(checks, PARALLEL, check => this.runOne(check));
   const changes = outcomes.filter(o => o.changed);
   for (const o of changes) console.log(JSON.stringify({event: 'dependency_status_changed', check: o.check.name, from: o.previous, to: o.status,
     code: o.observation.code, time: new Date().toISOString()}));
   if (changes.length) await this.notify(changes).catch(error =>
     console.error(JSON.stringify({event: 'watchdog_notify_failed', reason: reason(error), time: new Date().toISOString()})));
   return outcomes;
 }

 private async runOne(check: Check): Promise<Outcome> {
   const {observation, latencyMs} = await observe(check, this.env);
   const before = this.state.get(check.name);
   const streak = before?.observed === observation.status ? before.streak + 1 : 1;
   // A different result becomes the status once it repeats, so a single timeout raises no alert. Turning a feature
   // off is a setting, not a symptom, so it counts at once.
   const status = !before || observation.status === 'disabled' || streak >= (check.confirm ?? 2) ? observation.status : before.status;
   const every = check.every(this.env.config);
   // Unconfirmed results are checked again within a minute; failures every 5 minutes (hourly for daily checks) to notice recovery.
   const minutes = status !== observation.status ? 1
     : observation.retryMinutes !== undefined ? Math.min(every, observation.retryMinutes)
     : status === 'failing' ? Math.min(every, every > 60 ? 60 : 5) : every;
   const nextAt = Date.now() + minutes*60_000;
   const previous = before?.status ?? null;
   // The first result for a check only alerts when it shows a problem.
   const changed = before ? before.status !== status : status === 'warning' || status === 'failing';
   this.state.set(check.name, {status, observed: observation.status, streak, nextAt});
   const outcome = {check, observation, latencyMs, status, previous, changed};
   await record(this.env.db, outcome, streak, nextAt).catch(error =>
     console.error(JSON.stringify({event: 'watchdog_record_failed', check: check.name, reason: reason(error), time: new Date().toISOString()})));
   return outcome;
 }
}

async function record(db: DB, o: Outcome, streak: number, nextAt: number) {
 const summary = o.observation.summary.slice(0, 2000), code = o.observation.code.slice(0, 100);
 await db.transaction(async tx => {
   await tx.query(`INSERT INTO dependency_checks(name,label,category,status,observed,streak,code,summary,details,latency_ms,checked_at,changed_at,next_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now(),$11)
     ON CONFLICT(name) DO UPDATE SET label=excluded.label,category=excluded.category,status=excluded.status,observed=excluded.observed,
       streak=excluded.streak,code=excluded.code,summary=excluded.summary,details=excluded.details,latency_ms=excluded.latency_ms,
       checked_at=now(),next_at=excluded.next_at,
       changed_at=CASE WHEN dependency_checks.status<>excluded.status THEN now() ELSE dependency_checks.changed_at END`,
     [o.check.name, o.check.label, o.check.category, o.status, o.observation.status, streak, code, summary,
       JSON.stringify(o.observation.details ?? {}), o.latencyMs, new Date(nextAt)]);
   if (o.changed) await tx.query('INSERT INTO dependency_events(name,from_status,to_status,code,summary) VALUES($1,$2,$3,$4,$5)',
     [o.check.name, o.previous, o.status, code, summary]);
 });
}

export async function prune(db: DB) {
 await db.query(`DELETE FROM dependency_events WHERE created_at<now()-($1*interval '1 day')`, [EVENT_DAYS]);
}

// Checks without the schedule, confirmation or storage: what `npm run watchdog -- --once` prints.
export async function probe(env: CheckEnv, checks: Check[] = CHECKS) {
 return mapLimit(checks, PARALLEL, async check => ({check, ...await observe(check, env)}));
}

const WORDS: Record<CheckStatus,string> = {ok: 'working again', warning: 'needs attention', failing: 'FAILING', disabled: 'turned off'};
export function alertText(changes: Outcome[]) {
 return ['ZenAtlas watchdog', ...changes.map(o =>
   `${o.check.label} ${WORDS[o.status]}${o.previous ? ` (was ${o.previous})` : ''}: ${o.observation.summary}`)].join('\n');
}
// A JSON POST with the alert as text (Slack) and content (Discord, at most 2000 characters).
export function webhook(config: Config): Notify {
 return async changes => {
   if (!config.WATCHDOG_WEBHOOK_URL) return;
   const text = alertText(changes);
   const response = await fetch(config.WATCHDOG_WEBHOOK_URL, {method: 'POST', headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({text, content: text.slice(0, 2000)}), redirect: 'error', signal: AbortSignal.timeout(10_000)});
   if (!response.ok) throw new Error(`webhook answered ${response.status}`);
 };
}

// For the administration API: every check, worst first, with the services' heartbeats and recent status changes.
export async function dependencyReport(db: DB, config: Config) {
 const checks = (await db.query(`SELECT name,label,category,status,observed,streak,code,summary,details,latency_ms,checked_at,changed_at,next_at
   FROM dependency_checks ORDER BY CASE status WHEN 'failing' THEN 0 WHEN 'warning' THEN 1 WHEN 'ok' THEN 2 ELSE 3 END,label`)).rows;
 const services = (await db.query(`SELECT service,pid,host,started_at,beat_at,extract(epoch FROM now()-beat_at)::int AS silent_seconds
   FROM service_heartbeats ORDER BY service`)).rows.map(s => ({...s, running: s.silent_seconds <= config.WATCHDOG_STALE_SECONDS}));
 const events = (await db.query('SELECT name,from_status,to_status,code,summary,created_at FROM dependency_events ORDER BY created_at DESC,id DESC LIMIT 50')).rows;
 const counts = Object.fromEntries((['ok', 'warning', 'failing', 'disabled'] as const).map(s => [s, checks.filter(c => c.status === s).length])) as Record<CheckStatus,number>;
 const watched = services.some(s => s.service === 'watchdog' && s.running);
 return {status: !watched ? 'unmonitored' : counts.failing ? 'failing' : counts.warning ? 'warning' : 'ok', counts, checks, services, events};
}
