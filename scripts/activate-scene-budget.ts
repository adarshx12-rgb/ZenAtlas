// Operator-authorized activation: release only budget-deferred scene work; retain all spend counters.
import {connect} from '../src/db.js';
const db=connect(process.env.DATABASE_URL!);
try{
 const released=await db.transaction(async tx=>{
  const rows=(await tx.query(`UPDATE jobs SET run_after=now(),error_code=NULL,updated_at=now()
   WHERE kind='scene_analysis' AND status='queued' AND error_code='budget_exhausted' RETURNING id,payload->>'media_version_id' AS version`)).rows;
  if(rows.length){
   await tx.query(`UPDATE media_versions SET analysis_code=NULL,analysis_updated_at=now()
    WHERE id=ANY($1::uuid[]) AND analysis_code='budget_exhausted'`,[rows.map(r=>r.version).filter(Boolean)]);
   await tx.query("SELECT pg_notify('scene_jobs','budget_extended')");
  }
  return rows.length;
 });
 // Expire only the two completed benchmark cache entries so the authorized rerun executes the activated workflow.
 const queries=['moment in the Falcon Heavy test flight video when both side boosters land at the same time',
  'hindi explainer on how UPI works, under 10 minutes, not from big news channels'];
 const expired=(await db.query(`UPDATE jobs SET updated_at=now()-interval '1 day' WHERE kind='discovery'
  AND status IN ('complete','failed') AND payload->>'q'=ANY($1::text[]) RETURNING id`,[queries])).rows.length;
 console.log(JSON.stringify({released_budget_deferred_jobs:released,expired_probe_cache_entries:expired,
  budget:(await db.query("SELECT bucket,used FROM budgets WHERE window_start=date_trunc('day',now()) AND bucket IN ('scene_analysis_requests','scene_auto_jobs')")).rows}));
}finally{await db.close();}
