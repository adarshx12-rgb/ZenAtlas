import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';

export type JobKind = 'discovery'|'collect'|'enrich'|'source_health'|'source_discovery'|'audit'|'critic_review'|'youtube_captions';
export async function enqueue(db: DB, kind: JobKind, key: string, payload: unknown) {
 return (await db.query(`INSERT INTO jobs(kind,dedupe_key,payload) VALUES($1,$2,$3)
 ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING *`,[kind,key,JSON.stringify(payload)])).rows[0];
}
// Scene analysis jobs belong to the Python worker in scene-worker/.
// Discovery jobs go first: a person is waiting on them, while health checks and collection can run later.
// Critic work (audits and their weekly review) has its own lane, so a long model call never delays a search.
const CRITIC_KINDS = `('audit','critic_review')`;
export async function claim(db: DB, lane: 'main'|'critic' = 'main') {
 const kinds = lane === 'critic' ? `kind IN ${CRITIC_KINDS}` : `kind<>'scene_analysis' AND kind NOT IN ${CRITIC_KINDS}`;
 await db.query(`UPDATE jobs SET status='failed',error_code='retry_exhausted',lease_until=NULL,updated_at=now()
   WHERE kind<>'scene_analysis' AND attempts>=3 AND ((status='running' AND lease_until<now()) OR status='queued')`);
 return (await db.query(`UPDATE jobs SET status='running',attempts=attempts+1,lease_token=$1,
 lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=(SELECT id FROM jobs
 WHERE ${kinds} AND ((status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now())) AND attempts<3
 ORDER BY kind<>'discovery',run_after,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[randomUUID()])).rows[0]??null;
}
// Publishes partial results to the searches waiting on a running job, and renews its lease while it makes progress.
export async function progress(db: DB, job: any, result: unknown) {
 await db.query(`UPDATE jobs SET result=$3,lease_until=now()+interval '90 seconds'
 WHERE id=$1 AND lease_token=$2 AND status='running'`,[job.id,job.lease_token,JSON.stringify(result)]);
}
// Long network waits and AI checks must not let another worker reclaim a live job.
export async function renewLease(db: DB, job: any) {
 await db.query(`UPDATE jobs SET lease_until=now()+interval '90 seconds'
 WHERE id=$1 AND lease_token=$2 AND status='running'`,[job.id,job.lease_token]);
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
