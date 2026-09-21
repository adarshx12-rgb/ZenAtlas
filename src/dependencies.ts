import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { configuredProviders } from './providers.js';
import { GeminiClient, ORIGIN as GEMINI_ORIGIN } from './gemini.js';
import { YouTubeData } from './youtube.js';
import { AniListClient } from './anilist.js';
import { embed } from './embeddings.js';
import { Trafilatura, type TextExtractor } from './extract.js';
import { compareVersions, newer, parseVersion, satisfies } from './versions.js';
import { plannerModels } from './planner.js';
import { judgeModels } from './judge.js';

// Everything the search engine needs from outside its own code, each with a check the watchdog runs on a schedule.
// A check reports what it observed and, when something is wrong, what it breaks and how to fix it.
export type CheckStatus = 'ok'|'warning'|'failing'|'disabled';
// retryMinutes: check again this soon instead of at the usual interval, for example when an update feed was unreachable.
export interface Observation { status: CheckStatus; code: string; summary: string; details?: Record<string,unknown>; retryMinutes?: number }
export interface CheckEnv {
 db: DB; config: Config;
 // Repository root: package.json, package-lock.json, node_modules, migrations, src and .env.
 root: string;
 transport: typeof fetchJSON;
 // Starts and closes headless Chromium, returning its version.
 launchBrowser: () => Promise<string>;
 extractor: (command: string) => TextExtractor;
}
export interface Check {
 name: string; label: string;
 category: 'services'|'search'|'ai'|'apis'|'runtime'|'packages';
 // Minutes between checks while the status is settled.
 every: (config: Config) => number;
 // Identical observations in a row before the status changes (default 2, so one timeout raises no alert).
 confirm?: number;
 run(env: CheckEnv): Promise<Observation>;
}
export const PROCESSES = {api: 'zenatlas-api', worker: 'zenatlas-worker', watchdog: 'zenatlas-watchdog'} as const;

const ENGINE_FAILURES = 3, PROVIDER_FAILURES = 3, MODEL_FAILURES = 3;
// A failure streak only counts while it is recent. Nothing resets it except a later call, so an engine or model that
// stopped being called (a deep-dive-only engine, a standby fallback) would otherwise stay flagged for good.
const RECENT = `checked_at>now()-interval '24 hours'`;
const JOB_RUNNING_LIMIT_SECONDS = 15 * 60;
const SEARXNG_MAX_AGE_DAYS = 30;
// Stable public records that should always be found: YouTube's first upload, and AniList's first entry.
const KNOWN_VIDEO = 'jNQXAC9IVRw';
const KNOWN_ANIME = {title: 'Cowboy Bebop', id: 1};
const SAMPLE_PAGE = `<!doctype html><html><head><title>Watchdog sample</title></head><body><nav>Home About Contact</nav>
<article><h1>Lanternfish migration</h1><p>Every night, lanternfish rise hundreds of metres from the deep ocean to feed near the
surface, then sink again before dawn. This daily vertical migration is the largest movement of animals on Earth by biomass.</p>
<p>Scientists track the migration with sonar, which shows a dense scattering layer moving up at dusk and down at sunrise.</p>
</article><footer>Copyright</footer></body></html>`;

const ok = (code: string, summary: string, details?: Record<string,unknown>): Observation => ({status: 'ok', code, summary, details});
const warning = (code: string, summary: string, details?: Record<string,unknown>): Observation => ({status: 'warning', code, summary, details});
const failing = (code: string, summary: string, details?: Record<string,unknown>): Observation => ({status: 'failing', code, summary, details});
const disabled = (summary: string): Observation => ({status: 'disabled', code: 'not_configured', summary});
// An update feed that could not be read says nothing about the dependency itself, so it is only a warning, retried hourly.
const unreachableFeed = (summary: string): Observation => ({...warning('feed_unreachable', summary), retryMinutes: 60});

type Issue = {status: 'warning'|'failing'; code: string; text: string};
// The worst issue sets the status and code; every issue is described, most serious first.
function verdict(issues: Issue[], fine: Observation): Observation {
 if (!issues.length) return fine;
 const ordered = [...issues.filter(i => i.status === 'failing'), ...issues.filter(i => i.status === 'warning')];
 return {status: ordered[0].status, code: ordered[0].code, summary: ordered.map(i => i.text).join(' '),
   details: {...fine.details, issues: ordered.map(i => i.code)}};
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export function list(items: string[], max = 4) {
 const shown = items.slice(0, max), rest = items.length - shown.length;
 if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
 return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] ?? '';
}
export const ago = (seconds: number) => seconds < 90 ? `${Math.max(0, Math.round(seconds))} s` : seconds < 5400 ? `${Math.round(seconds/60)} min`
 : seconds < 172800 ? `${Math.round(seconds/3600)} h` : `${Math.round(seconds/86400)} days`;
// A short, credential-free description of an error for a summary.
export function reason(error: unknown) {
 if (error instanceof UpstreamError) return [error.code, error.status, error.detail].filter(Boolean).join(' ');
 return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200);
}
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
 const results: R[] = new Array(items.length);
 let next = 0;
 await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
   while (next < items.length) { const i = next++; results[i] = await task(items[i]); }
 }));
 return results;
}

type Manifest = {engines?: {node?: string}; dependencies?: Record<string,string>; devDependencies?: Record<string,string>};
type Lockfile = {packages?: Record<string, {version?: string; link?: boolean}>};
const readJSON = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
// Direct dependencies with their package.json range and locked version. Dev dependencies count: tsx runs the services.
async function manifest(root: string) {
 const pkg: Manifest = await readJSON(join(root, 'package.json'));
 const lock: Lockfile = await readJSON(join(root, 'package-lock.json'));
 const direct = Object.entries({...pkg.devDependencies, ...pkg.dependencies}).sort(([a], [b]) => a.localeCompare(b))
   .map(([name, range]) => ({name, range, locked: lock.packages?.[`node_modules/${name}`]?.version ?? null}));
 return {pkg, lock, direct};
}
async function installedVersion(root: string, name: string): Promise<string|null> {
 try { return String((await readJSON(join(root, 'node_modules', ...name.split('/'), 'package.json'))).version); } catch { return null; }
}
async function modified(path: string): Promise<Date|null> {
 try { return (await stat(path)).mtime; } catch { return null; }
}
// When the code, packages and settings a service loads at start last changed.
export async function codeChanges(root: string): Promise<{what: string; at: Date}[]> {
 let newest: Date|null = null;
 try {
   for (const file of await readdir(join(root, 'src'), {recursive: true})) {
     if (!file.endsWith('.ts')) continue;
     const at = await modified(join(root, 'src', file));
     if (at && (!newest || at > newest)) newest = at;
   }
 } catch { /* No source directory: nothing to compare. */ }
 const changes = [{what: 'source code', at: newest}, {what: 'installed packages', at: await modified(join(root, 'node_modules', '.package-lock.json'))},
   {what: '.env settings', at: await modified(join(root, '.env'))}];
 return changes.filter((c): c is {what: string; at: Date} => !!c.at && c.at.getTime() <= Date.now());
}

const database: Check = {name: 'database', label: 'PostgreSQL', category: 'services', every: () => 5, confirm: 1,
 async run({db, root}) {
   let applied: Set<string>;
   try { applied = new Set((await db.query<{name: string}>('SELECT name FROM schema_migrations')).rows.map(r => r.name)); }
   catch (error) { return failing('unreachable', `The database is not answering (${reason(error)}), so search is down. Check that PostgreSQL is running (docker compose up -d db).`); }
   const files = (await readdir(join(root, 'migrations'))).filter(f => f.endsWith('.sql')).sort();
   const pending = files.filter(f => !applied.has(f));
   if (pending.length) return warning('migrations_pending', `${plural(pending.length, 'database migration')} not applied (${list(pending)}), so features that need ${pending.length === 1 ? 'it' : 'them'} fail. Run npm run migrate, then npm run db:app-user.`, {pending});
   // has_table_privilege is true when any one listed privilege is held, so each is asked separately.
   const denied = (await db.query<{name: string}>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations' AND NOT (has_table_privilege(c.oid,'SELECT')
     AND has_table_privilege(c.oid,'INSERT') AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')) ORDER BY 1`)).rows.map(r => r.name);
   if (denied.length) return warning('privileges_missing', `The app's database login cannot write to ${list(denied)}. Run npm run db:app-user.`, {tables: denied});
   return ok('ready', `Connected; all ${files.length} migrations are applied.`);
 }};

const api: Check = {name: 'api', label: 'Web API', category: 'services', every: () => 1,
 async run({db, config, transport}) {
   const origin = apiOrigin(config);
   try { await transport(`${origin}/health/ready`, {trustedOrigin: origin, timeoutMs: 5000, redirects: 0}); }
   catch (error) {
     if (error instanceof UpstreamError && error.status === 503) return failing('not_ready', `The API at ${origin} is running but cannot read its database, so searches fail.`);
     return failing('unreachable', `Nothing answers at ${origin} (${reason(error)}), so the site is down. Check pm2 list and the ${PROCESSES.api} log.`);
   }
   const beat = (await db.query(`SELECT pid,extract(epoch FROM now()-started_at)::int AS uptime FROM service_heartbeats WHERE service='api'`)).rows[0];
   return ok('ready', beat ? `Answering at ${origin}; up for ${ago(beat.uptime)} (pid ${beat.pid}).` : `Answering at ${origin}.`, {origin});
 }};
export function apiOrigin(config: Config) {
 if (config.WATCHDOG_API_URL) return new URL(config.WATCHDOG_API_URL).origin;
 const host = ['0.0.0.0', '::', ''].includes(config.HOST) ? '127.0.0.1' : config.HOST;
 return new URL(`http://${host.includes(':') ? `[${host}]` : host}:${config.PORT}`).origin;
}

const worker: Check = {name: 'worker', label: 'Background worker', category: 'services', every: () => 1, confirm: 1,
 async run({db, config}) {
   const beat = (await db.query(`SELECT pid,host,details,extract(epoch FROM now()-beat_at)::int AS silent,
     extract(epoch FROM now()-started_at)::int AS uptime FROM service_heartbeats WHERE service='worker'`)).rows[0];
   if (!beat) return failing('never_seen', `No worker has reported, so searches never look beyond the saved catalogue and source checks do not run. Start it: pm2 start ecosystem.config.cjs --only ${PROCESSES.worker} (or npm run worker).`);
   const details = {pid: beat.pid, host: beat.host, uptime_seconds: beat.uptime, silent_seconds: beat.silent};
   if (beat.silent > config.WATCHDOG_STALE_SECONDS) return failing('stopped', `The worker has not reported for ${ago(beat.silent)}, so searches wait for discovery that never comes. Check pm2 list and the ${PROCESSES.worker} log.`, details);
   const failures = Number(beat.details?.cycle_failures ?? 0);
   if (failures >= 3) return warning('cycles_failing', `The worker is running, but its last ${failures} cycles failed (worker_cycle_failed in its log).`, {...details, cycle_failures: failures});
   return ok('running', `Running for ${ago(beat.uptime)} (pid ${beat.pid}).`, details);
 }};

const queue: Check = {name: 'job_queue', label: 'Job queue', category: 'services', every: () => 1,
 async run({db, config}) {
   // A running job whose lease ran out is waiting again: its worker stopped.
   const q = (await db.query(`SELECT
     (SELECT count(*)::int FROM jobs WHERE kind<>'scene_analysis' AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now()))) AS queued,
     (SELECT extract(epoch FROM now()-min(CASE WHEN status='queued' THEN run_after ELSE lease_until END))::int FROM jobs
       WHERE kind='discovery' AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now()))) AS waiting,
     (SELECT count(*)::int FROM jobs WHERE kind<>'scene_analysis' AND status='running' AND lease_until>=now()) AS running,
     (SELECT extract(epoch FROM now()-min(updated_at))::int FROM jobs WHERE kind<>'scene_analysis' AND status='running' AND lease_until>=now()) AS longest,
     (SELECT count(*)::int FROM jobs WHERE kind='discovery' AND status='failed' AND updated_at>now()-interval '1 hour') AS failed`)).rows[0];
   const issues: Issue[] = [];
   if ((q.waiting ?? 0) > config.WATCHDOG_QUEUE_SECONDS) issues.push(q.running
     ? {status: 'warning', code: 'searches_queuing', text: `A search has waited ${ago(q.waiting)} behind ${plural(q.running, 'running job')}; the worker handles one job at a time and a deep dive takes up to 5 minutes.`}
     : {status: 'failing', code: 'searches_stuck', text: `A search has waited ${ago(q.waiting)} with no job running: the worker is not picking up work.`});
   if ((q.longest ?? 0) > JOB_RUNNING_LIMIT_SECONDS) issues.push({status: 'warning', code: 'job_running_long', text: `A job has been running for ${ago(q.longest)} and may be stuck.`});
   if (q.failed >= 3) issues.push({status: 'warning', code: 'discovery_failing', text: `${plural(q.failed, 'discovery search')} failed in the last hour.`});
   return verdict(issues, ok('flowing', q.queued || q.running ? `${q.queued} queued, ${q.running} running.` : 'Idle; nothing is waiting.', q));
 }};

const FIXED_BUDGETS: {bucket: string; label: string; setting: keyof Config; essential?: boolean}[] = [
 {bucket: 'discovery_jobs', label: 'discovery searches', setting: 'DISCOVERY_DAILY_BUDGET', essential: true},
 {bucket: 'discovery:searxng', label: 'SearXNG requests', setting: 'SEARXNG_DAILY_BUDGET', essential: true},
 {bucket: 'discovery:google', label: 'Google requests', setting: 'DISCOVERY_DAILY_BUDGET', essential: true},
 {bucket: 'discovery:brave', label: 'Brave requests', setting: 'BRAVE_DAILY_BUDGET', essential: true},
 {bucket: 'planner_calls', label: 'AI planning calls', setting: 'JUDGE_DAILY_BUDGET'},
 {bucket: 'judge_calls', label: 'AI judging calls', setting: 'JUDGE_DAILY_BUDGET'},
 {bucket: 'youtube_units', label: 'YouTube quota units', setting: 'YOUTUBE_DAILY_UNITS'},
 {bucket: 'anilist_calls', label: 'AniList requests', setting: 'ANILIST_DAILY_BUDGET'},
 {bucket: 'reddit_signals', label: 'Reddit lookups', setting: 'DISCOVERY_DAILY_BUDGET'},
 {bucket: 'embeddings', label: 'embeddings', setting: 'EMBEDDING_DAILY_BUDGET'},
 {bucket: 'source_health_probes', label: 'source health probes', setting: 'SOURCE_HEALTH_DAILY_BUDGET'},
];
// Each planning assist spends its own bucket (see makePlanner), so each is watched separately; otherwise a model
// quietly reaching its limit would look like it was simply not contributing.
const dailyBudgets = (config: Config) => [...FIXED_BUDGETS,
 ...plannerModels(config).map(model => ({bucket: `planner_calls:${model}`, label: `AI planning calls (${model})`, setting: 'JUDGE_DAILY_BUDGET' as keyof Config, essential: false}))];

const budgets: Check = {name: 'budgets', label: 'Daily budgets', category: 'services', every: () => 5, confirm: 1,
 async run({db, config}) {
   const watched = dailyBudgets(config);
   const used = new Map((await db.query<{bucket: string; used: number}>(`SELECT bucket,used FROM budgets
     WHERE window_start=date_trunc('day',now()) AND bucket=ANY($1::text[])`, [watched.map(b => b.bucket)])).rows.map(r => [r.bucket, r.used]));
   const rows = watched.flatMap(b => {
     const limit = Number(config[b.setting]), n = used.get(b.bucket);
     return n !== undefined && limit > 0 ? [{...b, n, limit, share: n/limit}] : [];
   }).sort((a, b) => b.share - a.share);
   const issues = rows.filter(r => r.share >= 0.9).map((r): Issue => r.share >= 1
     ? {status: r.essential ? 'failing' : 'warning', code: 'budget_spent', text: `Today's ${r.label} are used up (${r.n}/${r.limit}); ${r.essential ? 'searches only use the saved catalogue' : 'that feature is off'} until the day resets. Raise ${String(r.setting)} if this is normal use.`}
     : {status: 'warning', code: 'budget_nearly_spent', text: `${Math.round(r.share*100)}% of today's ${r.label} are used (${r.n}/${r.limit}).`});
   const top = rows[0];
   return verdict(issues, ok('within_budget', top ? `Highest use today: ${top.label} at ${Math.round(top.share*100)}% (${top.n}/${top.limit}).` : 'Nothing used yet today.',
     {used: Object.fromEntries(rows.map(r => [r.bucket, `${r.n}/${r.limit}`]))}));
 }};

const runningCode: Check = {name: 'running_code', label: 'Running code', category: 'services', every: () => 5, confirm: 1,
 async run({db, config, root}) {
   // The watchdog restarts itself when its own code changes (see watchdog-main.ts), so only the other services are listed.
   const services = (await db.query<{service: 'api'|'worker'; started_at: Date}>(`SELECT service,started_at FROM service_heartbeats
     WHERE service<>'watchdog' AND beat_at>now()-($1*interval '1 second') ORDER BY service`, [config.WATCHDOG_STALE_SECONDS])).rows;
   const changes = await codeChanges(root);
   const stale = services.flatMap(s => {
     const later = changes.filter(c => c.at > new Date(s.started_at)).map(c => c.what);
     return later.length ? [{process: PROCESSES[s.service], changed: later}] : [];
   });
   if (!stale.length) return ok('current', services.length ? `${list(services.map(s => PROCESSES[s.service]))} run the current code and settings.` : 'No service is reporting.');
   return warning('restart_needed', `${list(stale.map(s => `${s.process} (${list(s.changed)})`))} changed after start, so the running ${stale.length === 1 ? 'process uses' : 'processes use'} the old version. Restart when no search is running: pm2 restart ${stale.map(s => s.process).join(' ')}.`, {stale});
 }};

const SEARXNG_SETTINGS = ['SEARXNG_ENGINES', 'SEARXNG_SOURCE_ENGINES', 'SEARXNG_WEB_ENGINES', 'SEARXNG_DEEP_ENGINES', 'SEARXNG_DEEP_WEB_ENGINES'] as const;
const engineNames = (value: string) => value.split(',').map(e => e.trim()).filter(Boolean);
// Each engine the settings ask for, with the settings that name it.
function configuredEngines(config: Config) {
 const engines = new Map<string,string[]>();
 for (const setting of SEARXNG_SETTINGS) for (const engine of engineNames(config[setting])) engines.set(engine, [...engines.get(engine) ?? [], setting]);
 return engines;
}
const searxngConfig = z.object({version: z.string().default('unknown'), engines: z.array(z.looseObject({name: z.string(), enabled: z.boolean().default(true)}))});
async function readSearxng({config, transport}: CheckEnv) {
 const url = new URL('/config', config.SEARXNG_BASE_URL);
 return searxngConfig.parse(await transport(url.href, {trustedOrigin: url.origin, token: config.SEARXNG_TOKEN, timeoutMs: 8000, redirects: 0, maxBytes: 8*1024*1024}));
}

const searxng: Check = {name: 'searxng', label: 'SearXNG', category: 'search', every: () => 5,
 async run(env) {
   const {config} = env;
   if (!config.SEARXNG_BASE_URL) return disabled('SEARXNG_BASE_URL is empty; discovery uses only Google or Brave, if configured.');
   let instance: z.infer<typeof searxngConfig>;
   try { instance = await readSearxng(env); }
   catch (error) {
     if (error instanceof ZodError) return warning('config_unreadable', 'SearXNG answered, but its /config page has an unexpected shape, so its engines cannot be checked.');
     return failing('unreachable', `SearXNG at ${new URL(config.SEARXNG_BASE_URL).origin} is not answering (${reason(error)}), so searches only use the saved catalogue. Check that its container is running (docker ps).`);
   }
   const enabled = new Set(instance.engines.filter(e => e.enabled).map(e => e.name.toLowerCase()));
   const wanted = configuredEngines(config);
   const missing = [...wanted].filter(([engine]) => !enabled.has(engine.toLowerCase()));
   const details = {version: instance.version, engines_enabled: enabled.size, engines_configured: wanted.size};
   if (missing.length) return warning('engines_unavailable', `${list(missing.map(([engine, settings]) => `${engine} (${settings.join(', ')})`))} ${missing.length === 1 ? 'is' : 'are'} not enabled in SearXNG, so those requests find nothing. Enable ${missing.length === 1 ? 'it' : 'them'} in deploy/searxng/settings.yml or remove ${missing.length === 1 ? 'it' : 'them'} from .env.`,
     {...details, missing: missing.map(([engine]) => engine)});
   return ok('answering', `SearXNG ${instance.version} is answering; all ${wanted.size} configured engines are enabled.`, details);
 }};

const searxngEngines: Check = {name: 'searxng_engines', label: 'Search engines', category: 'search', every: () => 5, confirm: 1,
 async run({db, config}) {
   if (!config.SEARXNG_BASE_URL) return disabled('SearXNG is not configured.');
   const wanted = configuredEngines(config);
   const rows = (await db.query<{provider: string; failure_count: number; last_error_code: string|null}>(
     `SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider LIKE 'searxng:%' AND ${RECENT}`)).rows
     .map(r => ({...r, engine: r.provider.slice('searxng:'.length)})).filter(r => wanted.has(r.engine));
   const down = rows.filter(r => r.failure_count >= ENGINE_FAILURES).sort((a, b) => b.failure_count - a.failure_count || a.engine.localeCompare(b.engine));
   const details = {engines_seen: rows.length, failing: Object.fromEntries(down.map(r => [r.engine, {failures: r.failure_count, reason: r.last_error_code}]))};
   if (!down.length) return ok('answering', rows.length ? `All ${rows.length} engines used in the last day answered their latest searches.` : 'No engine results were recorded in the last day.', details);
   const text = `${list(down.map(r => `${r.engine} (${r.failure_count} in a row${r.last_error_code && r.last_error_code !== 'unavailable' ? `, ${r.last_error_code}` : ''})`))} failed ${down.length === 1 ? 'its' : 'their'} latest searches.`;
   const standard = engineNames(config.SEARXNG_ENGINES);
   const standardDown = standard.filter(e => down.some(r => r.engine === e));
   return standard.length && standardDown.length*2 >= standard.length
     ? failing('engines_failing', `${text} Most video engines are failing, so searches find little beyond the saved catalogue.`, details)
     : warning('engines_failing', `${text} The other engines still answer. Engines blocked by a CAPTCHA or rate limit usually recover; one that keeps failing may need a newer SearXNG image.`, details);
 }};

const PROVIDER_NAMES: Record<string,string> = {searxng: 'SearXNG', google: 'Google Custom Search', brave: 'Brave Search'};
const PROVIDER_HINTS: Record<string,string> = {searxng: 'see the SearXNG checks', google: 'check GOOGLE_SEARCH_API_KEY and its quota', brave: 'check BRAVE_SEARCH_API_KEY and its plan'};
// Google closes its Custom Search JSON API to existing customers on this date (docs/SOURCE_HEALTH.md).
const GOOGLE_CSE_END = Date.UTC(2027, 0, 1);
const searchProviders: Check = {name: 'search_providers', label: 'Discovery providers', category: 'search', every: () => 5, confirm: 1,
 async run({db, config}) {
   const providers = configuredProviders(config).map(p => p.name);
   if (!providers.length) return failing('none_configured', 'No discovery provider is configured (SEARXNG_BASE_URL, BRAVE_SEARCH_API_KEY or Google), so searches only use the saved catalogue.');
   const rows = new Map((await db.query<{provider: string; failure_count: number; last_error_code: string|null}>(
     `SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider=ANY($1::text[]) AND ${RECENT}`, [providers])).rows.map(r => [r.provider, r]));
   const issues: Issue[] = [];
   const down = providers.filter(p => (rows.get(p)?.failure_count ?? 0) >= PROVIDER_FAILURES);
   if (down.length) {
     const text = down.map(p => `${PROVIDER_NAMES[p] ?? p} failed its last ${rows.get(p)!.failure_count} searches (${rows.get(p)!.last_error_code ?? 'unavailable'}; ${PROVIDER_HINTS[p] ?? 'check its settings'}).`).join(' ');
     issues.push(down.length === providers.length
       ? {status: 'failing', code: 'providers_failing', text: `${text} No provider is answering, so searches only use the saved catalogue.`}
       : {status: 'warning', code: 'provider_failing', text: `${text} The other providers still answer.`});
   }
   const daysLeft = Math.ceil((GOOGLE_CSE_END - Date.now()) / 86400000);
   if (providers.includes('google') && daysLeft <= 120) issues.push({status: 'warning', code: 'google_cse_ending', text: daysLeft > 0
     ? `Google's Custom Search JSON API stops serving existing customers in ${plural(daysLeft, 'day')} (2027-01-01); move discovery to SearXNG or Brave.`
     : 'Google has closed its Custom Search JSON API; remove GOOGLE_SEARCH_API_KEY and use SearXNG or Brave.'});
   return verdict(issues, ok('answering', `Discovery uses ${list(providers.map(p => PROVIDER_NAMES[p] ?? p))}.`, {providers}));
 }};

const hubTags = z.object({results: z.array(z.looseObject({name: z.string()})).default([])});
const releaseDate = (version: string) => { const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version); return m ? Date.UTC(+m[1], +m[2]-1, +m[3]) : null; };
const searxngRelease: Check = {name: 'searxng_release', label: 'SearXNG version', category: 'search', every: c => c.WATCHDOG_UPDATE_HOURS*60, confirm: 1,
 async run(env) {
   if (!env.config.SEARXNG_BASE_URL) return disabled('SearXNG is not configured.');
   let running: string;
   try { running = (await readSearxng(env)).version; }
   catch { return {...warning('instance_unreachable', 'SearXNG could not be asked for its version; see the SearXNG check.'), retryMinutes: 60}; }
   let tags: z.infer<typeof hubTags>;
   try { tags = hubTags.parse(await env.transport('https://hub.docker.com/v2/namespaces/searxng/repositories/searxng/tags?page_size=25&ordering=last_updated', {timeoutMs: 10000, maxBytes: 2*1024*1024})); }
   catch (error) { return unreachableFeed(`Docker Hub could not be checked for newer SearXNG images (${reason(error)}).`); }
   const newest = tags.results.map(t => t.name).filter(n => /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]+$/.test(n)).sort((a, b) => releaseDate(b)! - releaseDate(a)!)[0];
   const ran = releaseDate(running), latest = newest ? releaseDate(newest) : null;
   const details = {running, newest: newest ?? null};
   if (ran === null || latest === null) return ok('unknown_age', `SearXNG ${running} is running; its age could not be compared with the published images.`, details);
   const days = Math.round((latest - ran) / 86400000);
   if (days > SEARXNG_MAX_AGE_DAYS) return warning('outdated', `SearXNG ${running} is ${days} days older than the newest image (${newest}). Search sites change often and old engines stop working: update SEARXNG_IMAGE, and check that deploy/searxng/engines/bing_videos.py still matches the new image's engine.`, details);
   return ok('current', days > 0 ? `SearXNG ${running} is running; the newest image (${newest}) is ${plural(days, 'day')} newer.` : `SearXNG ${running} is the newest image.`, details);
 }};

const modelList = z.object({models: z.array(z.looseObject({name: z.string(), supportedGenerationMethods: z.array(z.string()).default([])})).default([]),
 nextPageToken: z.string().optional()});
async function geminiModels({config, transport}: CheckEnv) {
 const names = new Set<string>();
 let token: string|undefined;
 for (let page = 0; page < 5; page++) {
   const url = new URL('/v1beta/models', GEMINI_ORIGIN);
   url.search = new URLSearchParams({pageSize: '1000', ...(token ? {pageToken: token} : {})}).toString();
   const data = modelList.parse(await transport(url.href, {trustedOrigin: GEMINI_ORIGIN, headers: {'x-goog-api-key': config.GEMINI_API_KEY},
     timeoutMs: 10000, redirects: 0, maxBytes: 4*1024*1024}));
   for (const m of data.models) if (m.supportedGenerationMethods.includes('generateContent')) names.add(m.name.replace(/^models\//, ''));
   token = data.nextPageToken;
   if (!token) break;
 }
 return names;
}
// The newest stable model in the same line as name (gemini-<version>-<variant>, such as flash or flash-lite), if newer.
export function newerModel(name: string, available: Iterable<string>): string|null {
 const line = /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-[a-z]+)*)$/;
 const own = line.exec(name);
 if (!own) return null;
 let best: {name: string; version: string}|null = null;
 for (const other of available) {
   const m = line.exec(other);
   if (m && m[2] === own[2] && newer(m[1], best?.version ?? own[1])) best = {name: other, version: m[1]};
 }
 return best?.name ?? null;
}
function modelFailure(code: string|null) {
 if (!code) return 'unavailable';
 if (code.startsWith('rate_limited_daily')) return 'daily quota used up';
 if (code.startsWith('rate_limited')) return 'rate-limited';
 if (code.startsWith('timeout')) return 'timed out';
 if (/^upstream_failure_5\d\d/.test(code)) return 'overloaded or failing';
 if (code.startsWith('upstream_failure_404')) return 'model not found';
 if (/^upstream_failure_4\d\d/.test(code)) return `request refused: ${code.slice('upstream_failure_'.length)}`;
 return code;
}
const gemini: Check = {name: 'gemini', label: 'Gemini models', category: 'ai', every: () => 30,
 async run(env) {
   const {db, config} = env;
   // Planning and judging each run on OpenRouter when configured, so name only what a missing key actually stops.
   if (!config.GEMINI_API_KEY) {
     const onOpenRouter = (models: string[]) => !!config.OPENROUTER_API_KEY && models.length > 0;
     const off = [!onOpenRouter(plannerModels(config)) && 'AI planning', !onOpenRouter(judgeModels(config)) && 'AI relevance checks'].filter(Boolean);
     return disabled(off.length
       ? `GEMINI_API_KEY is empty, so ${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} off. Scene analysis needs a key too.`
       : 'GEMINI_API_KEY is empty; planning and judging run on OpenRouter instead, but scene analysis still needs a key.');
   }
   const planning = new GeminiClient(db, config).models;
   const [primary, ...fallbacks] = planning;
   let available: Set<string>;
   try { available = await geminiModels(env); }
   catch (error) {
     if (error instanceof UpstreamError && [400, 401, 403].includes(error.status ?? 0)) return failing('key_rejected', `Gemini refused GEMINI_API_KEY (${reason(error)}), so AI planning and judging are off. Create a new key in Google AI Studio.`);
     if (error instanceof UpstreamError && error.code === 'rate_limited') return warning('rate_limited', 'Gemini is rate-limiting this key, so some AI checks are being skipped.');
     return failing('unreachable', `Gemini's API is not answering (${reason(error)}), so searches run without AI.`);
   }
   const issues: Issue[] = [];
   const usable = planning.filter(m => available.has(m));
   const setting = config.JUDGE_MODEL ? 'JUDGE_MODEL' : 'GEMINI_MODEL';
   if (!usable.length) {
     const suggestion = newerModel('gemini-0-flash', available);
     issues.push({status: 'failing', code: 'models_retired', text: `Gemini no longer offers ${list(planning)}, so AI planning and judging are off. Set ${setting} to an available model${suggestion ? `, such as ${suggestion}` : ''}.`});
   } else {
     if (!available.has(primary)) issues.push({status: 'warning', code: 'model_retired', text: `Gemini no longer offers ${primary} (${setting}); searches fall back to ${usable[0]}. Update ${setting}.`});
     const gone = fallbacks.filter(m => !available.has(m));
     if (gone.length) issues.push({status: 'warning', code: 'fallback_retired', text: `Fallback ${list(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer offered; remove ${gone.length === 1 ? 'it' : 'them'} from JUDGE_FALLBACK_MODELS.`});
   }
   if (!planning.includes(config.GEMINI_MODEL) && !available.has(config.GEMINI_MODEL)) issues.push({status: 'warning', code: 'scene_model_retired', text: `GEMINI_MODEL ${config.GEMINI_MODEL}, used by the scene worker, is no longer offered.`});
   // What real searches saw: a model can be listed yet unusable, for example when its daily free quota is used up.
   const calls = new Map((await db.query<{provider: string; failure_count: number; last_error_code: string|null}>(
     `SELECT provider,failure_count,last_error_code FROM provider_health WHERE provider=ANY($1::text[]) AND ${RECENT}`, [usable.map(m => `gemini:${m}`)])).rows
     .map(r => [r.provider.slice('gemini:'.length), r]));
   const struggling = usable.filter(m => (calls.get(m)?.failure_count ?? 0) >= MODEL_FAILURES);
   if (struggling.length) {
     const text = `${list(struggling.map(m => `${m} failed its last ${calls.get(m)!.failure_count} calls (${modelFailure(calls.get(m)!.last_error_code)})`))}.`;
     issues.push(struggling.length === usable.length
       ? {status: 'failing', code: 'models_failing', text: `${text} No configured model is answering, so AI planning and judging are off.`}
       : {status: 'warning', code: 'model_failing', text: `${text} The other configured models are covering.`});
   }
   const upgrades = planning.flatMap(m => { const n = newerModel(m, available); return n ? [`${m} → ${n}`] : []; });
   return verdict(issues, ok('available', `${primary} is available for AI planning and judging${fallbacks.length ? `, with ${plural(fallbacks.length, 'fallback')}` : ''}.${upgrades.length ? ` Newer models: ${list(upgrades)}.` : ''}`,
     {primary, fallbacks, upgrades, models_offered: available.size, recent_failures: Object.fromEntries([...calls].map(([m, r]) => [m, r.failure_count]))}));
 }};

const embeddings: Check = {name: 'embeddings', label: 'Embedding service', category: 'ai', every: () => 60,
 async run({db, config}) {
   if (!config.SEMANTIC_ENABLED) return disabled('SEMANTIC_ENABLED=false; search is lexical only.');
   if (!config.EMBEDDING_URL || !config.EMBEDDING_MODEL) return failing('not_configured', 'SEMANTIC_ENABLED=true but EMBEDDING_URL or EMBEDDING_MODEL is empty, so semantic search is off.');
   try {
     const vector = await embed(db, config, 'watchdog health check');
     return vector ? ok('answering', `${config.EMBEDDING_MODEL} returns ${vector.length}-dimension vectors.`)
       : warning('budget_spent', `Today's EMBEDDING_DAILY_BUDGET (${config.EMBEDDING_DAILY_BUDGET}) is used up; search is lexical only until the day resets.`);
   } catch (error) {
     if (error instanceof ZodError) return failing('wrong_shape', `The embedding service no longer returns ${config.EMBEDDING_DIMENSIONS} non-zero numbers (EMBEDDING_DIMENSIONS), so semantic search is off. Was the model changed?`);
     return failing('unreachable', `The embedding service is not answering (${reason(error)}); search falls back to lexical matching.`);
   }
 }};

const youtube: Check = {name: 'youtube_api', label: 'YouTube Data API', category: 'apis', every: () => 60,
 async run({db, config, transport}) {
   if (!config.YOUTUBE_API_KEY) return disabled('YOUTUBE_API_KEY is empty; results have no view counts, comments or viewer timestamps.');
   try {
     const found = await new YouTubeData(db, config, transport).videos([KNOWN_VIDEO]);
     return found.has(KNOWN_VIDEO) ? ok('answering', 'The key is accepted and video details are readable.')
       : warning('empty_answer', 'YouTube accepted the key but returned nothing for a well-known public video; check the key\'s API restrictions.');
   } catch (error) {
     if (!(error instanceof UpstreamError)) throw error;
     const why = error.detail ?? '';
     if (error.code === 'budget_exhausted') return warning('budget_spent', `Today's YOUTUBE_DAILY_UNITS (${config.YOUTUBE_DAILY_UNITS}) are used up; viewer signals resume when the day resets.`);
     if (error.code === 'rate_limited' || /quotaExceeded|dailyLimitExceeded|RESOURCE_EXHAUSTED/i.test(why)) return warning('quota_exceeded', 'Google reports this key\'s YouTube quota is used up; viewer signals resume when it resets (midnight Pacific time).');
     if (/accessNotConfigured|SERVICE_DISABLED/i.test(why)) return failing('api_disabled', 'The YouTube Data API v3 is not enabled for this key\'s Google Cloud project, so results lose view counts and comments.');
     if (/keyInvalid|keyExpired|API_KEY_INVALID/i.test(why) || error.status === 400) return failing('key_rejected', `YouTube rejected YOUTUBE_API_KEY (${reason(error)}), so results lose view counts and comments. Create a new key in Google Cloud.`);
     if (error.status === 403) return failing('forbidden', `YouTube refused the request (${reason(error)}); check the key's restrictions.`);
     return failing('unreachable', `YouTube's API is not answering (${reason(error)}).`);
   }
 }};

const anilist: Check = {name: 'anilist', label: 'AniList', category: 'apis', every: () => 30,
 async run({db, config, transport}) {
   if (!config.ANILIST_ENABLED) return disabled('ANILIST_ENABLED=false; anime queries are searched without AniList context.');
   try {
     const match = await new AniListClient(db, config, transport).probe(KNOWN_ANIME.title);
     if (match?.id === KNOWN_ANIME.id) return ok('answering', `Answering; "${KNOWN_ANIME.title}" is recognised.`);
     return warning('not_recognised', `AniList answered, but "${KNOWN_ANIME.title}" was ${match ? `matched to ${match.title}` : 'not recognised'}, so anime recognition may be failing for every search. Compare src/anilist.ts with AniList's API.`,
       {matched: match?.title ?? null});
   } catch (error) {
     if (!(error instanceof UpstreamError)) throw error;
     if (error.code === 'budget_exhausted') return warning('budget_spent', `Today's ANILIST_DAILY_BUDGET (${config.ANILIST_DAILY_BUDGET}) is used up; anime recognition resumes when the day resets.`);
     if (error.code === 'malformed_response' || error.status === 400) return failing('api_changed', `AniList no longer accepts or answers the query this app sends (${reason(error)}); its API has changed and src/anilist.ts needs updating.`);
     if (error.code === 'rate_limited') return warning('rate_limited', 'AniList is rate-limiting this server, so some anime lookups are refused.');
     if (error.status === 403) return failing('refused', 'AniList refuses requests (403); its API may be temporarily disabled. Anime queries still work without it.');
     return failing('unreachable', `AniList is not answering (${reason(error)}); anime queries are searched without it.`);
   }
 }};

const browser: Check = {name: 'browser', label: 'Headless Chromium', category: 'runtime', every: () => 60,
 async run({config, root, launchBrowser}) {
   if (!config.PAGE_RENDERS) return disabled('PAGE_RENDERS=0; page checks read HTML without a browser.');
   try { return ok('starts', `Chromium ${await launchBrowser()} starts for rendered page checks.`); }
   catch (error) {
     const message = reason(error);
     if (/Executable doesn't exist|playwright install/i.test(error instanceof Error ? error.message : '')) {
       const version = await installedVersion(root, 'playwright');
       return failing('not_installed', `The Chromium build that Playwright${version ? ` ${version}` : ''} needs is not installed (usually after a Playwright update), so rendered page checks and previews are off. Run: npx playwright install --only-shell chromium`);
     }
     return failing('launch_failed', `Chromium does not start (${message}), so rendered page checks and previews are off.`);
   }
 }};
export async function launchChromium() {
 const {chromium} = await import('playwright');
 const instance = await chromium.launch({chromiumSandbox: true, timeout: 30_000});
 try { return instance.version(); } finally { await instance.close(); }
}

const pageText: Check = {name: 'page_text', label: 'Main-text helper', category: 'runtime', every: () => 60,
 async run({config, root, extractor}) {
   const command = config.PAGE_TEXT_PYTHON;
   if (!command) return disabled('PAGE_TEXT_PYTHON is empty; page checks use visible text only.');
   // A bare command is looked up on PATH; a path is relative to the repository root, like the worker's working directory.
   if (/[\\/]/.test(command)) {
     try { await access(resolve(root, command)); }
     catch { return failing('python_missing', `PAGE_TEXT_PYTHON points to ${command}, which does not exist, so page checks use visible text only. Recreate the scene-worker virtual environment (see README).`); }
   }
   const helper = extractor(command);
   try {
     const text = await helper.text(SAMPLE_PAGE);
     return text?.includes('Lanternfish') ? ok('answering', 'trafilatura extracts the main text of a sample page.')
       : failing('no_answer', `The Python helper returned no text, so page checks use visible text only. Reinstall it: ${command} -m pip install -e "scene-worker[pages]"`);
   } finally { helper.close(); }
 }};

const nodeReleases = z.array(z.looseObject({version: z.string(), security: z.boolean().default(false)}));
const nodeRuntime: Check = {name: 'node_runtime', label: 'Node.js', category: 'runtime', every: c => c.WATCHDOG_UPDATE_HOURS*60, confirm: 1,
 async run({root, transport}) {
   const current = process.version;
   const {pkg} = await manifest(root);
   const range = pkg.engines?.node;
   if (range && satisfies(current, range) === false) return failing('unsupported', `The services run on Node ${current}, but package.json requires ${range}. Install a supported Node version.`);
   let releases: z.infer<typeof nodeReleases>;
   try { releases = nodeReleases.parse(await transport('https://nodejs.org/dist/index.json', {timeoutMs: 15000, maxBytes: 8*1024*1024})); }
   catch (error) { return unreachableFeed(`Node ${current} is supported, but nodejs.org could not be checked for security releases (${reason(error)}).`); }
   const major = parseVersion(current)!.major;
   const later = releases.filter(r => parseVersion(r.version)?.major === major && newer(r.version, current))
     .sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!));
   const fixes = later.filter(r => r.security).map(r => r.version);
   const latest = later[0]?.version ?? null;
   const details = {current, latest: latest ?? current, security_releases: fixes};
   if (fixes.length) return warning('security_update', `Node ${current} lacks the security fixes in ${list(fixes)}. Install ${latest}, then restart the services.`, details);
   return ok('supported', latest ? `Node ${current} is supported; ${latest} is available (no security fixes).` : `Node ${current} is the newest ${major}.x release.`, details);
 }};

const packages: Check = {name: 'packages', label: 'Installed packages', category: 'packages', every: () => 15, confirm: 1,
 async run({root}) {
   const {direct} = await manifest(root);
   const missing: string[] = [], drift: string[] = [], unlocked: string[] = [];
   for (const p of direct) {
     const installed = await installedVersion(root, p.name);
     if (!p.locked || satisfies(p.locked, p.range) === false) unlocked.push(p.name);
     if (!installed) missing.push(p.name);
     else if (p.locked && installed !== p.locked) drift.push(`${p.name} ${installed} (locked ${p.locked})`);
   }
   const issues: Issue[] = [];
   if (missing.length) issues.push({status: 'failing', code: 'missing', text: `${list(missing)} ${missing.length === 1 ? 'is' : 'are'} not installed, so a restarted service may not start. Run npm ci.`});
   if (drift.length) issues.push({status: 'warning', code: 'drift', text: `Installed versions differ from package-lock.json: ${list(drift)}. Run npm ci.`});
   if (unlocked.length) issues.push({status: 'warning', code: 'lockfile_stale', text: `package-lock.json does not match package.json for ${list(unlocked)}. Run npm install.`});
   return verdict(issues, ok('as_locked', `All ${direct.length} direct packages are installed at their locked versions.`,
     {packages: Object.fromEntries(direct.map(p => [p.name, p.locked]))}));
 }};

const distTags = z.looseObject({latest: z.string()});
const packageUpdates: Check = {name: 'package_updates', label: 'Package updates', category: 'packages', every: c => c.WATCHDOG_UPDATE_HOURS*60, confirm: 1,
 async run({root, transport}) {
   const {direct} = await manifest(root);
   const locked = direct.filter((p): p is typeof p & {locked: string} => !!p.locked);
   const checked = await mapLimit(locked, 4, async p => {
     try { return {...p, latest: distTags.parse(await transport(`https://registry.npmjs.org/-/package/${p.name.replace('/', '%2f')}/dist-tags`, {timeoutMs: 10000})).latest}; }
     catch { return {...p, latest: null}; }
   });
   if (checked.length && checked.every(p => !p.latest)) return unreachableFeed('The npm registry could not be reached to check for package updates.');
   const behind = checked.flatMap(p => p.latest && newer(p.latest, p.locked)
     ? [{...p, latest: p.latest, major: parseVersion(p.latest)!.major > parseVersion(p.locked)!.major}] : []);
   const majors = behind.filter(p => p.major), minors = behind.filter(p => !p.major);
   const details = {updates: Object.fromEntries(behind.map(p => [p.name, `${p.locked} → ${p.latest}`])), unchecked: checked.filter(p => !p.latest).map(p => p.name)};
   const minorText = minors.length ? `${plural(minors.length, 'compatible update')} available (${list(minors.map(p => `${p.name} ${p.latest}`))}); npm update applies ${minors.length === 1 ? 'it' : 'them'}.` : '';
   if (majors.length) return warning('major_updates', `${list(majors.map(p => `${p.name} ${p.locked} → ${p.latest}`))} ${majors.length === 1 ? 'is a new major version' : 'are new major versions'} that may need code changes. ${minorText}`.trim(), details);
   return ok(behind.length ? 'updates_available' : 'current', minorText || `All ${checked.length} direct packages are at their latest versions.`, details);
 }};

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const;
const advisories = z.record(z.string(), z.array(z.looseObject({title: z.string().default(''), url: z.string().default(''),
 severity: z.enum(SEVERITIES).catch('moderate'), vulnerable_versions: z.string()})));
const vulnerabilities: Check = {name: 'vulnerabilities', label: 'Known vulnerabilities', category: 'packages', every: c => Math.min(12*60, c.WATCHDOG_UPDATE_HOURS*60), confirm: 1,
 async run({root, transport}) {
   const {lock} = await manifest(root);
   const installed = new Map<string,Set<string>>();
   for (const [path, entry] of Object.entries(lock.packages ?? {})) {
     const at = path.lastIndexOf('node_modules/');
     if (at < 0 || entry.link || !entry.version) continue;
     const name = path.slice(at + 'node_modules/'.length);
     installed.set(name, (installed.get(name) ?? new Set()).add(entry.version));
   }
   // npm's bulk endpoint returns every advisory for each named package, whatever the version, and sends no content type.
   let found: z.infer<typeof advisories>;
   try {
     found = advisories.parse(await transport('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {method: 'POST',
       body: Object.fromEntries([...installed].map(([name, versions]) => [name, [...versions]])), timeoutMs: 20000, maxBytes: 16*1024*1024,
       contentTypes: ['application/json', '']}));
   } catch (error) { return unreachableFeed(`npm's advisory database could not be checked (${reason(error)}).`); }
   const hits = Object.entries(found).flatMap(([name, entries]) => entries.flatMap(advisory => [...installed.get(name) ?? []].flatMap(version => {
     const affected = satisfies(version, advisory.vulnerable_versions);
     return affected === false ? [] : [{name, version, severity: advisory.severity, title: advisory.title.trim(), url: advisory.url, range_unread: affected === null}];
   }))).sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.name.localeCompare(b.name));
   const details = {packages_checked: installed.size, advisories: hits.slice(0, 50)};
   if (!hits.length) return ok('none_known', `No known vulnerabilities in the ${installed.size} installed packages.`, details);
   const counts = [...SEVERITIES].reverse().flatMap(s => { const n = hits.filter(h => h.severity === s).length; return n ? [`${n} ${s}`] : []; });
   const text = `${plural(hits.length, 'known vulnerability', 'known vulnerabilities')} (${counts.join(', ')}): ${list(hits.map(h => `${h.name} ${h.version}, ${h.severity}: ${h.title}`), 3)}. Run npm audit for details; npm audit fix applies compatible fixes.`;
   return hits.some(h => h.severity === 'high' || h.severity === 'critical') ? failing('vulnerable', text, details) : warning('vulnerable', text, details);
 }};

export const CHECKS: Check[] = [api, worker, queue, database, budgets, runningCode, searchProviders, searxng, searxngEngines, searxngRelease,
 gemini, embeddings, youtube, anilist, browser, pageText, nodeRuntime, packages, vulnerabilities, packageUpdates];

export function defaultEnv(db: DB, config: Config, root = process.cwd()): CheckEnv {
 return {db, config, root, transport: fetchJSON, launchBrowser: launchChromium, extractor: command => new Trafilatura(command)};
}
