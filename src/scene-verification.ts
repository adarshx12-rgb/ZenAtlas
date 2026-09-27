import type {DB} from './db.js';
import type {Config} from './config.js';
import type {Result, SearchResponse} from './types.js';
import type {RequirementsContract} from './requirements.js';
import {decide, type Finding} from './evidence.js';
import {makeJudge, enforceRequirements, type Judge, type JudgeCandidate, type JudgeContext, type Verdict} from './judge.js';
import {makeJevJudge} from './jev-judge.js';
import {cascadeReview, cascadeOptions, makeStrongJudge} from './cascade.js';
import {retainedEvidence} from './retained-evidence.js';
import {claim, complete, fail, renewLease} from './queue.js';
import {tierConfig} from './tiers.js';
import {rankBoost} from './canonical.js';

export interface SceneReviewEntry {content_id:string;job_id:string;candidate:JudgeCandidate;result:Result;findings:Finding[];done?:boolean}
export interface SceneReviewPlan {deadline:string;context:JudgeContext;contract?:RequirementsContract;entries:SceneReviewEntry[]}
export function sceneProgress(plan:SceneReviewPlan):NonNullable<SearchResponse['verification']> {
 return {status:'running',deadline:plan.deadline,items:plan.entries.map(e=>({content_id:e.content_id,status:'queued'}))};
}

// Only the affected candidate is replaced. Retrieval, transcript fetching and scene admission never run here.
export function applySceneVerdict(result:Result,c:JudgeCandidate,v:Verdict,model:string,plan:SceneReviewPlan,findings:Finding[],scenes:Result['moments']) {
 const verdict=enforceRequirements(c,v,plan.context.requirements);
 const decision=plan.contract?decide(plan.contract,findings,verdict.requirementChecks):undefined;
 const contradicted=decision?.status==='excluded'||verdict.intentChecks?.some(ch=>ch.status==='mismatch');
 const verified=!contradicted&&verdict.relevance>5&&(!decision||decision.status==='verified')&&
   (!verdict.intentChecks||verdict.intentChecks.every(ch=>ch.status==='supported'));
 const used=scenes.filter(s=>verdict.requirementChecks?.some(ch=>ch.status==='supported'&&ch.field==='scenes'&&s.summary.includes(ch.quote)));
 const updated:Result={...result,judgement:{relevance:verified?verdict.relevance:Math.min(verdict.relevance,contradicted?4:5),reason:verdict.reason,model,
   intent_checks:verdict.intentChecks},badges:(result.badges??[]).filter(b=>b!=='Closest match'),
   moments:verified?[...result.moments.filter(m=>m.evidence_type!=='video_analysed'),...used]:[],
   evidence:verified&&used.length?'video_analysed':verified?result.evidence:'metadata_match',
   evidence_coverage:{comments:result.evidence_coverage?.comments??'unavailable',captions:result.evidence_coverage?.captions??'unavailable',
     transcript_passages:c.transcripts?.length??0,analysed_scenes:scenes.length,basis:'direct_evidence'},
   ...(decision?{requirements:decision.requirements,uncertainties:[...decision.notes,...decision.requirements.filter(r=>r.status==='unknown').map(r=>`Not confirmed: ${r.text}`)]}:{})};
 return {result:updated,verified,excluded:!!contradicted||verdict.relevance<3};
}

// Independent lane: a scene model's slow response cannot occupy the discovery worker. Durable one-second checks are
// also recovery after missed notifications or a restart; attempts are not consumed while merely waiting.
export async function reviewScenesOnce(db:DB,config:Config,deps:{judge?:Judge;strong?:Judge|null}={}) {
 const job=await claim(db,'scenes');if(!job)return false;
 let renewal:Promise<void>|undefined;
 const timer=setInterval(()=>{if(!renewal)renewal=renewLease(db,job).catch(()=>{}).finally(()=>{renewal=undefined;});},20000);
 timer.unref();
 try {
   const parent=(await db.query("SELECT * FROM jobs WHERE id=$1 AND kind='discovery' AND status='complete' AND lease_token=$2",[job.payload.discovery_job_id,job.payload.run_id])).rows[0];
   const plan=parent?.result?._scene_review as SceneReviewPlan|undefined;
   if(!plan){await complete(db,job,{status:'obsolete'});return true;}
   const subscribed=(await db.query('SELECT 1 FROM searches WHERE job_id=$1 AND NOT cancelled AND expires_at>now() LIMIT 1',[parent.id])).rows.length;
   if(!subscribed){await complete(db,job,{status:'cancelled'});return true;}
   const cfg=tierConfig(config,parent.payload.tier??'ssj3');
   const judge=deps.judge??makeJevJudge(db,cfg,makeJudge(db,cfg));
   const strong='strong' in deps?deps.strong:makeStrongJudge(db,cfg);
   const sceneJobs=(await db.query('SELECT id,status,result,error_code,run_after,payload FROM jobs WHERE id=ANY($1::uuid[])',[plan.entries.map(e=>e.job_id)])).rows;
   const result=parent.result,verification=result.verification??sceneProgress(plan);
   let changed=false;
   for(const entry of plan.entries){
     if(entry.done)continue;
     const scene=sceneJobs.find(s=>s.id===entry.job_id);
     let status=!scene?'unavailable':scene.error_code==='budget_exhausted'?'budget_deferred':scene.status==='running'?'analysing':scene.status==='failed'?'failed':scene.status;
     if(scene?.status==='complete') {
       if(!['complete','cached'].includes(scene.result?.status)) status=scene.result?.status??'failed';
       else {
         const current=(await db.query("SELECT 1 FROM media_versions WHERE id=$1 AND content_id=$2 AND status='current' AND access_status='accessible'",[scene.payload.media_version_id,entry.content_id])).rows.length;
         const evidence=current?(await retainedEvidence(db,[entry.content_id],parent.payload.q)).get(entry.content_id):undefined;
         if(!evidence?.scenes.length)status='unavailable';
         else if(!judge)status='review_unavailable';
         else {
           const candidate={...entry.candidate,scenes:evidence.scenes.map(s=>({start:s.start_seconds,end:s.end_seconds,description:s.summary,inspected_ranges:s.inspected_ranges}))};
           try {
             const first=await judge.judge(parent.payload.q,[candidate],plan.context);
             const checked=await cascadeReview(parent.payload.q,[candidate],first.verdicts,first.jev,plan.context,undefined,strong??undefined,
               {...cascadeOptions(cfg),inspectionLimit:0});
             const v=checked.verdicts.get(candidate.key);
             if(!v)status='review_unavailable';
             else {
               const scored=applySceneVerdict(entry.result,candidate,v,checked.records.get(candidate.key)?.model??first.model,plan,entry.findings,evidence.scenes);
               result.results=(result.results??[]).filter((r:Result)=>r.id!==entry.content_id);
               result.closest=(result.closest??[]).filter((r:Result)=>r.id!==entry.content_id);
               if(scored.verified)result.results.push(scored.result);
               else if(!scored.excluded)result.closest.push({...scored.result,badges:[...(scored.result.badges??[]),'Closest match']});
               result.dropped=[...new Set([...(result.dropped??[]).filter((u:string)=>u!==entry.result.canonical_url),...(!scored.verified?[entry.result.canonical_url]:[])])];
               status='complete';
             }
           }catch{status='review_failed';}
         }
       }
     }
     if(['queued','analysing'].includes(status)&&Date.now()>=Date.parse(plan.deadline))status='timed_out';
     if(!['queued','analysing'].includes(status))entry.done=true;
     const item=verification.items.find((i:{content_id:string})=>i.content_id===entry.content_id);
     if(item&&item.status!==status){item.status=status;changed=true;}
   }
   const waiting=plan.entries.some(e=>!e.done);
   verification.status=waiting?'running':verification.items.every((i:{status:string})=>i.status==='complete')?'complete':'partial';
   if(changed||!waiting){
     const rank=(r:Result)=>(r.judgement?.relevance??0)+(r.badges?.includes('Official channel')?rankBoost('canonical'):0);
     result.results.sort((a:Result,b:Result)=>rank(b)-rank(a));
     if(plan.contract)result.unmet=plan.contract.requirements.filter(r=>r.hardness==='hard'&&r.scope==='each'&&!result.results.some((x:Result)=>x.requirements?.some(q=>q.id===r.id&&q.status==='supported'))).map(r=>`Not yet confirmed: ${r.text}`)
       .concat((result.unmet??[]).filter((s:string)=>!plan.contract!.requirements.some(r=>r.scope==='each'&&s.includes(r.text))));
     result.verification=verification;result.revision=(result.revision??1)+1;
     result.providers=(result.providers??[]).filter((p:{provider:string})=>!['scene_analysis','video_inspection','scene_verification'].includes(p.provider));
     result.providers.push({provider:'scene_verification',status:waiting?'ok':verification.status==='complete'?'ok':'partial',message:
       waiting?'Scene verification is running; these results will update.':verification.status==='complete'?'Scene evidence was checked and the results updated.':'Some scene checks could not finish; unresolved candidates remain uncertain.'});
     if(!waiting)delete result._scene_review;
     await db.transaction(async tx=>{
       if(!(await tx.query("SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",[job.id,job.lease_token])).rows.length)return;
       await tx.query("UPDATE jobs SET result=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='complete'",[parent.id,job.payload.run_id,JSON.stringify(result)]);
     });
   }
   if(waiting)await db.query("UPDATE jobs SET status='queued',attempts=greatest(0,attempts-1),run_after=now()+interval '1 second',lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",[job.id,job.lease_token]);
   else await complete(db,job,{status:verification.status});
 }catch{await fail(db,job,'scene_review_failed');}
 finally{clearInterval(timer);await renewal;}
 return true;
}
