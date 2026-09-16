import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers.js';
import {ingest} from '../src/catalogue.js';
import {contentInput} from '../src/types.js';
import {setPolicyRule,listPolicyRules,deletePolicyRule,reviewQueue,domainMatchesPattern} from '../src/policy-rules.js';

const rulePayload=(overrides:Record<string,unknown>={})=>({status:'active',metadata:true,transcripts:false,
 video_analysis:false,retention_days:30,adapter:'link_only',feed_url:null,
 review_note:'TEST: trusted platform pattern reviewed once.',...overrides});

test('domain wildcard matching covers the base domain and every subdomain, never an unrelated one',()=>{
 assert.equal(domainMatchesPattern('videos.trusted.example','*.trusted.example'),true);
 assert.equal(domainMatchesPattern('trusted.example','*.trusted.example'),true);
 assert.equal(domainMatchesPattern('nottrusted.example','*.trusted.example'),false);
 assert.equal(domainMatchesPattern('trusted.example.evil.example','*.trusted.example'),false);
});

test('a matching rule classifies a brand-new domain immediately, with provenance recording the rule',async()=>{
 const db=await database();
 try{
   await setPolicyRule(db,'*.trusted-platform.example',rulePayload());
   const result=await ingest(db,contentInput.parse({url:'https://videos.trusted-platform.example/watch/1',title:'Rule-classified item'}),{method:'search'});
   assert.ok(result);
   const source=(await db.query('SELECT * FROM sources WHERE id=$1',[result!.source_id])).rows[0];
   assert.equal(source.status,'active');
   assert.equal(source.provenance.auto_policy_rule,'*.trusted-platform.example');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM content WHERE source_id=$1',[source.id])).rows[0].n,1,'metadata:true persists content immediately');
 }finally{await db.close();}
});

test('an unmatched domain lands as a plain, unreviewed candidate and stores no content',async()=>{
 const db=await database();
 try{
   const result=await ingest(db,contentInput.parse({url:'https://unknown.example/watch/1',title:'Unclassified item'}),{method:'search'});
   assert.ok(result);
   const source=(await db.query('SELECT * FROM sources WHERE id=$1',[result!.source_id])).rows[0];
   assert.equal(source.status,'candidate');
   assert.equal(source.provenance.auto_policy_rule,undefined);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM content WHERE source_id=$1',[source.id])).rows[0].n,0);
 }finally{await db.close();}
});

test('repeated discovery hits accumulate appearances, and the review queue ranks/filters by that count',async()=>{
 const db=await database();
 try{
   for(let i=0;i<3;i++)await ingest(db,contentInput.parse({url:`https://popular.example/watch/${i}`,title:`Item ${i}`}),{method:'search'});
   await ingest(db,contentInput.parse({url:'https://obscure.example/watch/1',title:'Rare item'}),{method:'search'});
   const source=(await db.query("SELECT * FROM sources WHERE domain='popular.example'")).rows[0];
   assert.equal(source.discovery_appearances,3);
   const queueAtThree=await reviewQueue(db,3);
   assert.ok(queueAtThree.some((r:any)=>r.domain==='popular.example'));
   assert.ok(!queueAtThree.some((r:any)=>r.domain==='obscure.example'));
   const queueAtFour=await reviewQueue(db,4);
   assert.ok(!queueAtFour.some((r:any)=>r.domain==='popular.example'),'threshold excludes domains below it');
 }finally{await db.close();}
});

test('adding a rule later retroactively promotes matching candidates already sitting in the database',async()=>{
 const db=await database();
 try{
   const before=await ingest(db,contentInput.parse({url:'https://backlog.example/watch/1',title:'Pre-existing candidate'}),{method:'search'});
   assert.equal((await db.query('SELECT status FROM sources WHERE id=$1',[before!.source_id])).rows[0].status,'candidate');
   const {applied_to_existing}=await setPolicyRule(db,'backlog.example',rulePayload());
   assert.equal(applied_to_existing,1);
   assert.equal((await db.query('SELECT status FROM sources WHERE id=$1',[before!.source_id])).rows[0].status,'active');
 }finally{await db.close();}
});

test('a rule can also blocklist a pattern straight to rejected, and never touches a human-reviewed source',async()=>{
 const db=await database();
 try{
   await setPolicyRule(db,'*.spam.example',rulePayload({status:'rejected',metadata:false,adapter:'link_only'}));
   const blocked=await ingest(db,contentInput.parse({url:'https://mirror.spam.example/watch/1',title:'Blocked item'}),{method:'search'});
   assert.equal(blocked,null);
   // A source a human already promoted out of 'candidate' must not be reclassified by a later rule edit.
   const reviewed=await ingest(db,contentInput.parse({url:'https://manual.example/watch/1',title:'Manually reviewed item'}),{method:'search'});
   await db.query("UPDATE sources SET status='paused' WHERE id=$1",[reviewed!.source_id]);
   await setPolicyRule(db,'manual.example',rulePayload());
   assert.equal((await db.query('SELECT status FROM sources WHERE id=$1',[reviewed!.source_id])).rows[0].status,'paused');
 }finally{await db.close();}
});

test('rules can be listed and deleted',async()=>{
 const db=await database();
 try{
   await setPolicyRule(db,'listed.example',rulePayload());
   assert.equal((await listPolicyRules(db)).length,1);
   assert.equal(await deletePolicyRule(db,'listed.example'),true);
   assert.equal(await deletePolicyRule(db,'listed.example'),false);
   assert.equal((await listPolicyRules(db)).length,0);
 }finally{await db.close();}
});
