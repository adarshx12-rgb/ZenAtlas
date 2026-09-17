import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';

export async function enqueue(db: DB, kind: 'discovery'|'collect'|'enrich'|'source_health'|'source_discovery', key: string, payload: unknown) {
 return (await db.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES($1,$2,$3)
 ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING *`,[kind,key,JSON.stringify(payload)])).rows[0];
}
// Scene analysis jobs belong to the Python worker in scene-worker/.
// Discovery jobs go first: a person is waiting on them, while health checks and collection can run later.
export async function claim(db: DB) {
 await db.query(`UPDATE jobs SET status='failed',error_code='retry_exhausted',lease_until=NULL,updated_at=now()
   WHERE kind<>'scene_analysis' AND attempts>=3 AND ((status='running' AND lease_until<now()) OR status='queued')`);
 return (await db.query(`UPDATE jobs SET status='running',attempts=attempts+1,lease_token=$1,
 lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=(SELECT id FROM jobs
 WHERE kind<>'scene_analysis' AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now())) AND attempts<3
 ORDER BY kind<>'discovery',run_after,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[randomUUID()])).rows[0]??null;
}
export async function complete(db: DB, job: any, result: unknown) {
 await db.query(`UPDATE jobs SET status='complete',result=$3,lease_until=NULL,updated_at=now()
 WHERE id=$1 AND lease_token=$2 AND status='running'`,[job.id,job.lease_token,JSON.stringify(result)]);
}
export async function fail(db: DB, job: any, code: string) {
 await db.query(`UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
 run_after=now()+(power(2,attempts)*interval '5 seconds'),error_code=$3,lease_until=NULL,updated_at=now()
 WHERE id=$1 AND lease_token=$2 AND status='running'`,[job.id,job.lease_token,code]);
}
