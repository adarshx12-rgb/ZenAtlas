import { hostname } from 'node:os';
import type { DB } from './db.js';

// Consecutive failures per provider, engine or model, as seen by real searches. code says why the latest one failed.
export async function providerHealth(db: DB, provider: string, ok: boolean, code = 'unavailable') {
 await db.query(`INSERT INTO provider_health(provider,failure_count,last_success_at,last_error_code)
 VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END,CASE WHEN $3 THEN NULL ELSE $4 END)
 ON CONFLICT(provider) DO UPDATE SET failure_count=CASE WHEN $3 THEN 0 ELSE provider_health.failure_count+1 END,
 last_success_at=CASE WHEN $3 THEN now() ELSE provider_health.last_success_at END,
 last_error_code=CASE WHEN $3 THEN NULL ELSE $4 END,checked_at=now()`,[provider,ok?0:1,ok,code.slice(0,100)]);
}

export type Service = 'api'|'worker'|'watchdog';
// A process reports that it is alive; the watchdog treats a report older than WATCHDOG_STALE_SECONDS as stopped.
export async function heartbeat(db: DB, service: Service, started: Date, details: Record<string,unknown> = {}) {
 await db.query(`INSERT INTO service_heartbeats(service,pid,host,started_at,beat_at,details) VALUES($1,$2,$3,$4,now(),$5)
 ON CONFLICT(service) DO UPDATE SET pid=excluded.pid,host=excluded.host,started_at=excluded.started_at,beat_at=now(),details=excluded.details`,
   [service,process.pid,hostname().slice(0,200),started,JSON.stringify(details)]);
}

// Beats now and then every 15 seconds without keeping the process alive. A failed beat is only logged once in a row.
export function keepBeating(db: DB, service: Service, details: () => Record<string,unknown> = () => ({})) {
 const started = new Date();
 let failing = false;
 const beat = () => heartbeat(db, service, started, details()).then(() => { failing = false; }, () => {
   if (!failing) console.error(JSON.stringify({event: 'heartbeat_failed', service, time: new Date().toISOString()}));
   failing = true;
 });
 void beat();
 const timer = setInterval(beat, 15_000);
 timer.unref();
 return () => clearInterval(timer);
}
